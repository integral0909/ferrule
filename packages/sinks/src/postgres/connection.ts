import * as net from 'node:net';
import * as tls from 'node:tls';
import type { TlsOptions } from '../fragments.js';
import { writeWithBackpressure } from '../stream/backpressure-write.js';
import { resolveTlsConnectOptions } from '../stream/wire-transport.js';
import {
  AuthCode,
  chooseSaslMechanism,
  computeMd5PasswordResponse,
  parseSaslMechanismList,
  PostgresScramAuth,
} from './auth.js';
import {
  parseNoticeFields,
  PostgresAuthError,
  PostgresError,
  PostgresProtocolError,
  type PgNoticeFields,
} from './errors.js';
import {
  BackendMessageFramer,
  encodeSslRequest,
  encodeStartupMessage,
  frontendMessage,
  PgReader,
  PgWriter,
  type BackendMessage,
} from './wire.js';

export interface PgConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  applicationName?: string;
  tls?: TlsOptions;
  connectTimeoutMs?: number;
  maxMessageLength?: number;
  /** Extra `StartupMessage` parameters (e.g. `{ options: '-c statement_timeout=5000' }`). */
  extraStartupParams?: Readonly<Record<string, string>>;
  /** Called for every `NoticeResponse` the server sends outside of an error path. */
  onNotice?: (notice: PgNoticeFields) => void;
}

export interface FieldDescriptor {
  readonly name: string;
  readonly tableOid: number;
  readonly columnAttrNumber: number;
  readonly typeOid: number;
  readonly typeSize: number;
  readonly typeModifier: number;
  readonly formatCode: number;
}

export interface QueryResultSet {
  readonly fields: FieldDescriptor[];
  readonly rows: (string | null)[][];
  readonly commandTag: string;
}

export interface CopyInResult {
  readonly commandTag: string;
}

type Socket = net.Socket | tls.TLSSocket;

/**
 * A hand-written PostgreSQL wire protocol v3 client connection: `StartupMessage`, authentication
 * (cleartext, MD5, and SCRAM-SHA-256), optional TLS via `SSLRequest`, the simple query protocol,
 * the extended query protocol with text-format parameters, and `COPY ... FROM STDIN`. One
 * connection handles one operation at a time (PostgreSQL's wire protocol is inherently
 * request/response on a given socket); concurrency comes from a pool of connections (`pool.ts`),
 * not from pipelining within one.
 */
export class PgConnection {
  private socket: Socket | undefined;
  private framer: BackendMessageFramer;
  private inbox: BackendMessage[] = [];
  private inboxWaiter: ((message: BackendMessage) => void) | undefined;
  private inboxRejecter: ((error: unknown) => void) | undefined;
  private terminalError: Error | undefined;
  private readonly parameterStatus = new Map<string, string>();
  private backendPid: number | undefined;
  private backendSecretKey: number | undefined;
  private closed = false;

  constructor(private readonly options: PgConnectionOptions) {
    this.framer = new BackendMessageFramer(options.maxMessageLength);
  }

  get parameters(): ReadonlyMap<string, string> {
    return this.parameterStatus;
  }

  get processId(): number | undefined {
    return this.backendPid;
  }

  /** Opens the TCP connection, negotiates TLS if configured, sends `StartupMessage`, completes
   * authentication, and waits for the first `ReadyForQuery`. */
  async connect(): Promise<void> {
    const raw = await dialTcp(
      this.options.host,
      this.options.port,
      this.options.connectTimeoutMs ?? 10_000,
    );
    let socket: Socket = raw;
    if (this.options.tls?.enabled === true) {
      socket = await this.negotiateTls(raw);
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () =>
      this.fail(new PostgresProtocolError('connection closed by the server')),
    );

    const startupParams: Record<string, string> = {
      user: this.options.user,
      database: this.options.database,
      ...(this.options.applicationName !== undefined
        ? { application_name: this.options.applicationName }
        : {}),
      ...this.options.extraStartupParams,
    };
    await this.writeRaw(encodeStartupMessage(startupParams));
    await this.performAuthentication();
    await this.drainUntilReadyForQuery();
  }

  private async negotiateTls(raw: net.Socket): Promise<tls.TLSSocket> {
    await writeRawToSocket(raw, encodeSslRequest());
    const response = await readOneByte(raw);
    if (response === 0x4e /* 'N' */) {
      raw.destroy();
      throw new PostgresAuthError('server does not support SSL, but tls.enabled is set');
    }
    if (response !== 0x53 /* 'S' */) {
      raw.destroy();
      throw new PostgresProtocolError(
        `unexpected byte in response to SSLRequest: 0x${response.toString(16)}`,
      );
    }
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: raw,
        ...resolveTlsConnectOptions(this.options.tls, this.options.host, 'E_POSTGRES_TLS_FILE'),
      });
      const onSecure = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        socket.off('secureConnect', onSecure);
        socket.off('error', onError);
      };
      socket.once('secureConnect', onSecure);
      socket.once('error', onError);
    });
  }

  private async performAuthentication(): Promise<void> {
    for (;;) {
      const message = await this.nextRaw();
      if (message.type === 'E') throw this.toPostgresError(message);
      if (message.type !== 'R') {
        throw new PostgresProtocolError(
          `expected an Authentication message, got '${message.type}'`,
        );
      }
      const reader = new PgReader(message.body);
      const code = reader.int32();
      if (code === AuthCode.Ok) return;
      if (code === AuthCode.CleartextPassword) {
        await this.sendPassword(this.requirePassword());
        continue;
      }
      if (code === AuthCode.MD5Password) {
        const salt = reader.bytes(4);
        const response = computeMd5PasswordResponse(
          this.options.user,
          this.requirePassword(),
          salt,
        );
        await this.sendPassword(response);
        continue;
      }
      if (code === AuthCode.SASL) {
        await this.performScramAuth(reader);
        continue;
      }
      throw new PostgresAuthError(`unsupported PostgreSQL authentication method (code ${code})`);
    }
  }

  private async performScramAuth(reader: PgReader): Promise<void> {
    const mechanisms = parseSaslMechanismList(reader.rest());
    const mechanism = chooseSaslMechanism(mechanisms);
    const scram = new PostgresScramAuth(this.requirePassword());
    const initial = scram.initialResponse();
    await this.write(frontendMessage('p', saslInitialResponseBody(mechanism, initial)));

    const continueMsg = await this.nextRaw();
    if (continueMsg.type === 'E') throw this.toPostgresError(continueMsg);
    if (continueMsg.type !== 'R') {
      throw new PostgresProtocolError(
        `expected AuthenticationSASLContinue, got '${continueMsg.type}'`,
      );
    }
    const continueReader = new PgReader(continueMsg.body);
    if (continueReader.int32() !== AuthCode.SASLContinue) {
      throw new PostgresProtocolError('expected AuthenticationSASLContinue');
    }
    const finalResponse = scram.continueResponse(continueReader.rest());
    await this.write(frontendMessage('p', new PgWriter().bytes(finalResponse).build()));

    const finalMsg = await this.nextRaw();
    if (finalMsg.type === 'E') throw this.toPostgresError(finalMsg);
    if (finalMsg.type !== 'R') {
      throw new PostgresProtocolError(`expected AuthenticationSASLFinal, got '${finalMsg.type}'`);
    }
    const finalReader = new PgReader(finalMsg.body);
    if (finalReader.int32() !== AuthCode.SASLFinal) {
      throw new PostgresProtocolError('expected AuthenticationSASLFinal');
    }
    scram.finish(finalReader.rest());
  }

  private requirePassword(): string {
    if (this.options.password === undefined) {
      throw new PostgresAuthError('server requires a password, but none was configured');
    }
    return this.options.password;
  }

  private async sendPassword(password: string): Promise<void> {
    await this.write(frontendMessage('p', new PgWriter().cstring(password).build()));
  }

  /** Reads (and applies) `ParameterStatus`/`BackendKeyData`/`NoticeResponse` messages until
   * `ReadyForQuery`, used once right after authentication completes. */
  private async drainUntilReadyForQuery(): Promise<void> {
    for (;;) {
      const message = await this.nextRelevant();
      if (message.type === 'K') {
        const reader = new PgReader(message.body);
        this.backendPid = reader.int32();
        this.backendSecretKey = reader.int32();
        continue;
      }
      if (message.type === 'Z') return;
      if (message.type === 'E') throw this.toPostgresError(message);
      throw new PostgresProtocolError(`unexpected message '${message.type}' before ReadyForQuery`);
    }
  }

  // -----------------------------------------------------------------------------------------
  // Simple query protocol
  // -----------------------------------------------------------------------------------------

  /** Runs one or more `;`-separated statements via the simple query protocol. Returns one
   * {@link QueryResultSet} per statement that produced a command tag. */
  async simpleQuery(sql: string): Promise<QueryResultSet[]> {
    await this.write(frontendMessage('Q', new PgWriter().cstring(sql).build()));
    return this.collectQueryResults();
  }

  private async collectQueryResults(): Promise<QueryResultSet[]> {
    const results: QueryResultSet[] = [];
    let fields: FieldDescriptor[] = [];
    let rows: (string | null)[][] = [];
    let firstError: PostgresError | undefined;
    for (;;) {
      const message = await this.nextRelevant();
      switch (message.type) {
        case 'T':
          fields = parseRowDescription(message.body);
          rows = [];
          break;
        case 'D':
          rows.push(parseDataRow(message.body));
          break;
        case 'C': {
          const tag = new PgReader(message.body).cstring();
          results.push({ fields, rows, commandTag: tag });
          fields = [];
          rows = [];
          break;
        }
        case 'I': // EmptyQueryResponse
          break;
        case 'E':
          firstError ??= this.toPostgresError(message);
          break;
        case 'Z':
          if (firstError !== undefined) throw firstError;
          return results;
        default:
          throw new PostgresProtocolError(
            `unexpected message '${message.type}' during a simple query`,
          );
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Extended query protocol (text-format parameters only)
  // -----------------------------------------------------------------------------------------

  /** Runs one parameterised statement via Parse/Bind/Execute/Sync, with all parameters and
   * results in text format. */
  async extendedQuery(
    sql: string,
    params: readonly (string | null)[] = [],
  ): Promise<QueryResultSet> {
    const parse = new PgWriter().cstring('').cstring(sql).int16(0).build();
    const bind = new PgWriter()
      .cstring('')
      .cstring('')
      .int16(0) // parameter format codes: 0 means "use the default (text) for all"
      .int16(params.length);
    for (const p of params) {
      if (p === null) bind.int32(-1);
      else {
        const encoded = Buffer.from(p, 'utf8');
        bind.int32(encoded.length).bytes(encoded);
      }
    }
    bind.int16(0); // result format codes: text for all
    const describe = new PgWriter().int8(0x50 /* 'P' */).cstring('').build();
    const execute = new PgWriter().cstring('').int32(0).build();

    await this.write(
      Buffer.concat([
        frontendMessage('P', parse),
        frontendMessage('B', bind.build()),
        frontendMessage('D', describe),
        frontendMessage('E', execute),
        frontendMessage('S', Buffer.alloc(0)),
      ]),
    );

    let fields: FieldDescriptor[] = [];
    const rows: (string | null)[][] = [];
    let commandTag = '';
    let firstError: PostgresError | undefined;
    for (;;) {
      const message = await this.nextRelevant();
      switch (message.type) {
        case '1': // ParseComplete
        case '2': // BindComplete
        case 'n': // NoData
          break;
        case 't': // ParameterDescription
          break;
        case 'T':
          fields = parseRowDescription(message.body);
          break;
        case 'D':
          rows.push(parseDataRow(message.body));
          break;
        case 'C':
          commandTag = new PgReader(message.body).cstring();
          break;
        case 'E':
          firstError ??= this.toPostgresError(message);
          break;
        case 'Z':
          if (firstError !== undefined) throw firstError;
          return { fields, rows, commandTag };
        default:
          throw new PostgresProtocolError(
            `unexpected message '${message.type}' during an extended query`,
          );
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // COPY FROM STDIN
  // -----------------------------------------------------------------------------------------

  /**
   * Runs a `COPY ... FROM STDIN` statement, streaming `chunks` as `CopyData` messages (each
   * already encoded in the format the statement declares, text or CSV) with backpressure applied
   * to the underlying socket. On a chunk source error, sends `CopyFail` so the server reports a
   * clean SQL error instead of hanging.
   */
  async copyFromStdin(
    sql: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<CopyInResult> {
    await this.write(frontendMessage('Q', new PgWriter().cstring(sql).build()));

    const response = await this.nextRelevant();
    if (response.type === 'E') throw this.toPostgresError(response);
    if (response.type !== 'G') {
      throw new PostgresProtocolError(`expected CopyInResponse, got '${response.type}'`);
    }

    try {
      for await (const chunk of chunks) {
        await this.write(frontendMessage('d', Buffer.from(chunk)));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.write(frontendMessage('f', new PgWriter().cstring(reason).build()));
      await this.drainCopyFailure();
      throw error;
    }
    await this.write(frontendMessage('c', Buffer.alloc(0)));

    let commandTag = '';
    let firstError: PostgresError | undefined;
    for (;;) {
      const message = await this.nextRelevant();
      if (message.type === 'C') {
        commandTag = new PgReader(message.body).cstring();
        continue;
      }
      if (message.type === 'E') {
        firstError ??= this.toPostgresError(message);
        continue;
      }
      if (message.type === 'Z') {
        if (firstError !== undefined) throw firstError;
        return { commandTag };
      }
      throw new PostgresProtocolError(`unexpected message '${message.type}' finishing a COPY`);
    }
  }

  private async drainCopyFailure(): Promise<void> {
    for (;;) {
      const message = await this.nextRelevant();
      if (message.type === 'Z') return;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed || this.socket === undefined) {
      this.closed = true;
      return;
    }
    this.closed = true;
    try {
      await this.write(frontendMessage('X', Buffer.alloc(0)));
    } catch {
      // best-effort: the socket may already be gone
    }
    await new Promise<void>((resolve) => {
      const socket = this.socket;
      if (socket === undefined || socket.destroyed) {
        resolve();
        return;
      }
      socket.end(() => resolve());
      socket.once('error', () => resolve());
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  private handleData(chunk: Buffer): void {
    let messages: BackendMessage[];
    try {
      messages = this.framer.push(chunk);
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const message of messages) {
      if (this.inboxWaiter !== undefined) {
        const waiter = this.inboxWaiter;
        this.inboxWaiter = undefined;
        this.inboxRejecter = undefined;
        waiter(message);
      } else {
        this.inbox.push(message);
      }
    }
  }

  private fail(error: unknown): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error instanceof Error ? error : new Error(String(error));
    if (this.inboxRejecter !== undefined) {
      const reject = this.inboxRejecter;
      this.inboxWaiter = undefined;
      this.inboxRejecter = undefined;
      reject(this.terminalError);
    }
  }

  /** The next raw backend message, without filtering. */
  private nextRaw(): Promise<BackendMessage> {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
    const buffered = this.inbox.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<BackendMessage>((resolve, reject) => {
      this.inboxWaiter = resolve;
      this.inboxRejecter = reject;
    });
  }

  /** The next backend message, transparently applying `ParameterStatus` updates and forwarding
   * `NoticeResponse`s to `onNotice`, since both can arrive at any point in the protocol. */
  private async nextRelevant(): Promise<BackendMessage> {
    for (;;) {
      const message = await this.nextRaw();
      if (message.type === 'S') {
        const reader = new PgReader(message.body);
        this.parameterStatus.set(reader.cstring(), reader.cstring());
        continue;
      }
      if (message.type === 'N') {
        this.options.onNotice?.(parseNoticeFields(new PgReader(message.body)));
        continue;
      }
      return message;
    }
  }

  private toPostgresError(message: BackendMessage): PostgresError {
    return new PostgresError(parseNoticeFields(new PgReader(message.body)));
  }

  private write(buf: Buffer): Promise<void> {
    if (this.socket === undefined) {
      return Promise.reject(new PostgresProtocolError('not connected'));
    }
    return writeWithBackpressure(this.socket, buf);
  }

  private writeRaw(buf: Buffer): Promise<void> {
    return this.write(buf);
  }
}

function saslInitialResponseBody(mechanism: string, initialResponse: Buffer): Buffer {
  return new PgWriter()
    .cstring(mechanism)
    .int32(initialResponse.length)
    .bytes(initialResponse)
    .build();
}

function parseRowDescription(body: Buffer): FieldDescriptor[] {
  const reader = new PgReader(body);
  const count = reader.int16();
  const fields: FieldDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    fields.push({
      name: reader.cstring(),
      tableOid: reader.int32(),
      columnAttrNumber: reader.int16(),
      typeOid: reader.int32(),
      typeSize: reader.int16(),
      typeModifier: reader.int32(),
      formatCode: reader.int16(),
    });
  }
  return fields;
}

function parseDataRow(body: Buffer): (string | null)[] {
  const reader = new PgReader(body);
  const count = reader.int16();
  const row: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const length = reader.int32();
    row.push(length === -1 ? null : reader.bytes(length).toString('utf8'));
  }
  return row;
}

function dialTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new PostgresProtocolError(`connection to ${host}:${port} timed out`));
    }, timeoutMs);
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function writeRawToSocket(socket: net.Socket, buf: Buffer): Promise<void> {
  return writeWithBackpressure(socket, buf);
}

function readOneByte(socket: net.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      cleanup();
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      resolve(chunk[0]!);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.once('data', onData);
    socket.once('error', onError);
  });
}
