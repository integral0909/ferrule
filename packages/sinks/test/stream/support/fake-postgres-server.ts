import * as crypto from 'node:crypto';
import * as net from 'node:net';
import {
  AuthCode,
  computeMd5PasswordResponse,
  SCRAM_SHA_256_MECHANISM,
} from '../../../src/postgres/auth.js';
import { parseScramAttributes, saltPassword } from '../../../src/stream/scram.js';
import {
  BackendMessageFramer,
  frontendMessage,
  PgReader,
  PgWriter,
  type BackendMessage,
} from '../../../src/postgres/wire.js';

/**
 * A fake PostgreSQL server speaking just enough of the wire protocol v3 to exercise the client in
 * `src/postgres/`: startup, cleartext/MD5/SCRAM-SHA-256 authentication, the simple query
 * protocol, the extended query protocol, and `COPY ... FROM STDIN` (capturing the raw bytes
 * received, byte-for-byte, for the test to assert on). Driven as a small async state machine per
 * connection (an explicit `nextMessage()` pump), mirroring the real client's own design, so the
 * message sequencing is easy to get right and to read.
 */

export type FakePgAuthMode = 'trust' | 'cleartext' | 'md5' | 'scram';

export interface CopyRequestHandler {
  (
    sql: string,
    data: Buffer,
  ): { ok: true; commandTag?: string } | { ok: false; sqlState: string; message: string };
}

export interface SimpleQueryHandler {
  (
    sql: string,
  ): { rows: (string | null)[][]; columnNames: string[]; commandTag: string } | undefined;
}

export interface FakePgServerOptions {
  auth?: FakePgAuthMode;
  password?: string;
  onCopy?: CopyRequestHandler;
  onSimpleQuery?: SimpleQueryHandler;
}

function msg(type: string, body: Buffer): Buffer {
  return frontendMessage(type, body);
}

function errorResponse(sqlState: string, message: string): Buffer {
  const w = new PgWriter();
  w.int8('S'.charCodeAt(0)).cstring('ERROR');
  w.int8('C'.charCodeAt(0)).cstring(sqlState);
  w.int8('M'.charCodeAt(0)).cstring(message);
  w.int8(0);
  return msg('E', w.build());
}

function readyForQuery(): Buffer {
  return msg('Z', Buffer.from('I', 'ascii'));
}

function parseStartupParams(buf: Buffer): Record<string, string> {
  const params: Record<string, string> = {};
  let offset = 8; // Int32 length + Int32 protocol version
  while (offset < buf.length) {
    const keyEnd = buf.indexOf(0, offset);
    if (keyEnd === -1 || keyEnd === offset) break;
    const key = buf.toString('utf8', offset, keyEnd);
    offset = keyEnd + 1;
    const valEnd = buf.indexOf(0, offset);
    if (valEnd === -1) break;
    params[key] = buf.toString('utf8', offset, valEnd);
    offset = valEnd + 1;
  }
  return params;
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

class ConnectionHandler {
  private readonly framer = new BackendMessageFramer();
  private readonly inbox: BackendMessage[] = [];
  private waiter: ((m: BackendMessage) => void) | undefined;
  private startupParams: Record<string, string> | undefined;

  constructor(
    private readonly socket: net.Socket,
    private readonly options: FakePgServerOptions,
    private readonly receivedCopyData: Buffer[],
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
  }

  private onData(chunk: Buffer): void {
    if (this.startupParams === undefined) {
      this.startupParams = parseStartupParams(chunk);
      return;
    }
    let messages: BackendMessage[];
    try {
      messages = this.framer.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const m of messages) {
      if (this.waiter !== undefined) {
        const w = this.waiter;
        this.waiter = undefined;
        w(m);
      } else {
        this.inbox.push(m);
      }
    }
  }

  private next(): Promise<BackendMessage> {
    const buffered = this.inbox.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private send(buf: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(buf);
  }

  async run(): Promise<void> {
    while (this.startupParams === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.socket.destroyed) return;
    }
    const ok = await this.authenticate();
    if (!ok) return;
    this.send(msg('K', new PgWriter().int32(4242).int32(1234).build()));
    this.send(readyForQuery());

    for (;;) {
      const message = await this.next().catch(() => undefined);
      if (message === undefined || this.socket.destroyed) return;
      if (message.type === 'Q') {
        const sql = new PgReader(message.body).cstring();
        await this.handleSimpleQuery(sql);
      } else if (message.type === 'P') {
        this.send(msg('1', Buffer.alloc(0)));
      } else if (message.type === 'B') {
        this.send(msg('2', Buffer.alloc(0)));
      } else if (message.type === 'D') {
        this.sendExtendedRowDescriptionAndRow();
      } else if (message.type === 'E') {
        this.send(msg('C', Buffer.concat([Buffer.from('SELECT 1', 'utf8'), Buffer.from([0])])));
      } else if (message.type === 'S') {
        this.send(readyForQuery());
      } else if (message.type === 'X') {
        this.socket.end();
        return;
      }
    }
  }

  /** Returns `true` once authenticated and ready to proceed; `false` if the connection ended
   * (rejected or closed) during authentication. */
  private async authenticate(): Promise<boolean> {
    const auth = this.options.auth ?? 'trust';
    const user = this.startupParams?.['user'] ?? '';
    if (auth === 'trust') {
      this.send(msg('R', new PgWriter().int32(AuthCode.Ok).build()));
      return true;
    }
    if (auth === 'cleartext') {
      this.send(msg('R', new PgWriter().int32(AuthCode.CleartextPassword).build()));
      const response = await this.next();
      const password = new PgReader(response.body).cstring();
      if (password !== this.options.password) {
        this.send(errorResponse('28P01', 'password authentication failed'));
        this.socket.end();
        return false;
      }
      this.send(msg('R', new PgWriter().int32(AuthCode.Ok).build()));
      return true;
    }
    if (auth === 'md5') {
      const salt = crypto.randomBytes(4);
      this.send(msg('R', new PgWriter().int32(AuthCode.MD5Password).bytes(salt).build()));
      const response = await this.next();
      const received = new PgReader(response.body).cstring();
      const expected = computeMd5PasswordResponse(user, this.options.password ?? '', salt);
      if (received !== expected) {
        this.send(errorResponse('28P01', 'password authentication failed'));
        this.socket.end();
        return false;
      }
      this.send(msg('R', new PgWriter().int32(AuthCode.Ok).build()));
      return true;
    }
    // scram
    const mechW = new PgWriter().int32(AuthCode.SASL);
    mechW.bytes(Buffer.from(`${SCRAM_SHA_256_MECHANISM}\0\0`, 'utf8'));
    this.send(msg('R', mechW.build()));

    const initial = await this.next();
    const initialReader = new PgReader(initial.body);
    initialReader.cstring(); // mechanism name
    const len = initialReader.int32();
    const clientFirst = initialReader.bytes(len).toString('utf8');
    const bare = clientFirst.startsWith('n,,') ? clientFirst.slice(3) : clientFirst;
    const attrs = parseScramAttributes(bare);
    const clientNonce = attrs['r']!;
    const serverNonceSuffix = crypto.randomBytes(18).toString('base64').replaceAll(/[+/=]/g, '');
    const combinedNonce = clientNonce + serverNonceSuffix;
    const salt = crypto.randomBytes(16);
    const iterations = 4096;
    const serverFirst = `r=${combinedNonce},s=${salt.toString('base64')},i=${iterations}`;
    this.send(
      msg(
        'R',
        new PgWriter().int32(AuthCode.SASLContinue).bytes(Buffer.from(serverFirst, 'utf8')).build(),
      ),
    );

    const finalMsg = await this.next();
    const clientFinal = new PgReader(finalMsg.body).rest().toString('utf8');
    const proofIdx = clientFinal.lastIndexOf(',p=');
    const withoutProof = clientFinal.slice(0, proofIdx);
    const proofB64 = clientFinal.slice(proofIdx + 3);

    const saltedPassword = saltPassword(this.options.password ?? '', salt, iterations);
    const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const authMessage = `${bare},${serverFirst},${withoutProof}`;
    const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
    const expectedProof = xor(clientKey, clientSignature);
    if (expectedProof.toString('base64') !== proofB64) {
      this.send(errorResponse('28P01', 'SCRAM authentication failed'));
      this.socket.end();
      return false;
    }
    const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest();
    const serverSignature = crypto.createHmac('sha256', serverKey).update(authMessage).digest();
    this.send(
      msg(
        'R',
        new PgWriter()
          .int32(AuthCode.SASLFinal)
          .bytes(Buffer.from(`v=${serverSignature.toString('base64')}`, 'utf8'))
          .build(),
      ),
    );
    // Per protocol, AuthenticationSASLFinal is followed by a plain AuthenticationOk.
    this.send(msg('R', new PgWriter().int32(AuthCode.Ok).build()));
    return true;
  }

  private sendExtendedRowDescriptionAndRow(): void {
    const tw = new PgWriter();
    tw.int16(1).cstring('answer').int32(0).int16(0).int32(25).int16(-1).int32(-1).int16(0);
    this.send(msg('T', tw.build()));
    const rw = new PgWriter();
    rw.int16(1);
    const val = Buffer.from('1', 'utf8');
    rw.int32(val.length).bytes(val);
    this.send(msg('D', rw.build()));
  }

  private async handleSimpleQuery(sql: string): Promise<void> {
    if (/^\s*copy\s/i.test(sql)) {
      this.send(msg('G', new PgWriter().int8(0).int16(0).build()));
      await this.handleCopyIn(sql);
      return;
    }
    const custom = this.options.onSimpleQuery?.(sql);
    if (custom !== undefined) {
      const tw = new PgWriter();
      tw.int16(custom.columnNames.length);
      for (const name of custom.columnNames) {
        tw.cstring(name).int32(0).int16(0).int32(25).int16(-1).int32(-1).int16(0);
      }
      this.send(msg('T', tw.build()));
      for (const row of custom.rows) {
        const rw = new PgWriter();
        rw.int16(row.length);
        for (const value of row) {
          if (value === null) rw.int32(-1);
          else {
            const buf = Buffer.from(value, 'utf8');
            rw.int32(buf.length).bytes(buf);
          }
        }
        this.send(msg('D', rw.build()));
      }
      this.send(
        msg('C', Buffer.concat([Buffer.from(custom.commandTag, 'utf8'), Buffer.from([0])])),
      );
      this.send(readyForQuery());
      return;
    }
    // Default: answer with a single-row "SELECT 1"-shaped result.
    const tw = new PgWriter();
    tw.int16(1).cstring('?column?').int32(0).int16(0).int32(23).int16(4).int32(-1).int16(0);
    this.send(msg('T', tw.build()));
    const rw = new PgWriter();
    rw.int16(1);
    const val = Buffer.from('1', 'utf8');
    rw.int32(val.length).bytes(val);
    this.send(msg('D', rw.build()));
    this.send(msg('C', Buffer.concat([Buffer.from('SELECT 1', 'utf8'), Buffer.from([0])])));
    this.send(readyForQuery());
  }

  private async handleCopyIn(sql: string): Promise<void> {
    const chunks: Buffer[] = [];
    for (;;) {
      const message = await this.next();
      if (message.type === 'd') {
        chunks.push(message.body);
        continue;
      }
      if (message.type === 'c') {
        const data = Buffer.concat(chunks);
        this.receivedCopyData.push(data);
        const result = this.options.onCopy?.(sql, data) ?? { ok: true };
        if (result.ok) {
          const tag = Buffer.from(result.commandTag ?? 'COPY 0', 'utf8');
          this.send(msg('C', Buffer.concat([tag, Buffer.from([0])])));
        } else {
          this.send(errorResponse(result.sqlState, result.message));
        }
        this.send(readyForQuery());
        return;
      }
      if (message.type === 'f') {
        this.send(readyForQuery());
        return;
      }
    }
  }
}

export class FakePostgresServer {
  private readonly server: net.Server;
  private _port = 0;
  /** Every byte-exact payload received across all COPY operations, in order, for assertions. */
  readonly receivedCopyData: Buffer[] = [];

  constructor(private readonly options: FakePgServerOptions = {}) {
    this.server = net.createServer((socket) => {
      const handler = new ConnectionHandler(socket, this.options, this.receivedCopyData);
      // A client that disconnects mid-handshake (or a test tearing a connection down early) is
      // expected and not a test failure; only genuine bugs in the handler logic should surface.
      handler.run().catch(() => undefined);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this._port = typeof address === 'object' && address !== null ? address.port : 0;
    return this._port;
  }

  get port(): number {
    return this._port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
