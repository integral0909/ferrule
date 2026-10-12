import * as net from 'node:net';
import * as tls from 'node:tls';
import type { TlsOptions } from '../fragments.js';
import { writeWithBackpressure } from '../stream/backpressure-write.js';
import { resolveTlsConnectOptions } from '../stream/wire-transport.js';
import { KafkaWriter } from './primitives.js';
import {
  ApiKey,
  decodeApiVersionsResponseV0,
  encodeApiVersionsRequestV0,
  type ApiVersionsResponse,
} from './protocol.js';
import { performSaslAuth, type KafkaSaslOptions } from './sasl.js';

/**
 * A connection to one Kafka broker: TCP (optionally TLS), the `Int32`-length-prefixed
 * request/response framing every Kafka API uses, and correlation-ID-based request pipelining (up
 * to `maxInFlightRequests` requests may be outstanding at once; responses are matched back to
 * their request by `correlation_id` regardless of the order the broker answers in, since Kafka
 * does not guarantee in-order responses across different APIs on a pipelined connection).
 */

export interface KafkaConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly clientId?: string;
  readonly tls?: TlsOptions;
  readonly connectTimeoutMs?: number;
  readonly maxInFlightRequests?: number;
  readonly sasl?: KafkaSaslOptions;
}

interface PendingRequest {
  readonly resolve: (body: Buffer) => void;
  readonly reject: (error: unknown) => void;
}

type Socket = net.Socket | tls.TLSSocket;

export class KafkaBrokerConnection {
  private socket: Socket | undefined;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private nextCorrelationId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inFlightWaiters: (() => void)[] = [];
  private inFlightCount = 0;
  private terminalError: Error | undefined;
  private closed = false;

  constructor(private readonly options: KafkaConnectionOptions) {}

  get remoteAddress(): string {
    return `${this.options.host}:${this.options.port}`;
  }

  async connect(): Promise<void> {
    const raw = await dialTcp(
      this.options.host,
      this.options.port,
      this.options.connectTimeoutMs ?? 10_000,
    );
    let socket: Socket = raw;
    if (this.options.tls?.enabled === true) {
      socket = await negotiateTls(raw, this.options.host, this.options.tls);
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error(`connection to ${this.remoteAddress} closed`)));
    if (this.options.sasl !== undefined) {
      try {
        await performSaslAuth(this, this.options.sasl);
      } catch (error) {
        // Authentication failed partway through: the socket is otherwise healthy at the TCP
        // level, but this connection is unusable, so close it rather than leaking it.
        socket.destroy();
        this.closed = true;
        throw error;
      }
    }
  }

  /** Queries the broker's supported API version ranges. Always uses the classic (non-flexible)
   * header/body, per protocol convention, so it works before either side knows whether the other
   * supports flexible headers. */
  async apiVersions(): Promise<ApiVersionsResponse> {
    const body = await this.sendRequest(ApiKey.ApiVersions, 0, false, encodeApiVersionsRequestV0());
    return decodeApiVersionsResponseV0(body);
  }

  /**
   * Sends one request and resolves with its response body (the header, which this method parses
   * and discards, is already stripped). `flexible` selects the KIP-482 flexible request/response
   * header shape; `apiVersion` is written into the header as-is.
   */
  async sendRequest(
    apiKey: number,
    apiVersion: number,
    flexible: boolean,
    body: Buffer,
  ): Promise<Buffer> {
    await this.acquireInFlightSlot();
    try {
      const { frame, correlationId } = this.buildFrame(apiKey, apiVersion, flexible, body);
      const responsePromise = new Promise<Buffer>((resolve, reject) => {
        this.pending.set(correlationId, { resolve, reject });
      });
      await this.write(frame);
      return await responsePromise;
    } finally {
      this.releaseInFlightSlot();
    }
  }

  /** Sends a request the broker will never answer (a Produce request with `acks=0`). Does not
   * occupy an in-flight slot or a pending-response entry, since none is coming. */
  async sendOneWay(
    apiKey: number,
    apiVersion: number,
    flexible: boolean,
    body: Buffer,
  ): Promise<void> {
    const { frame } = this.buildFrame(apiKey, apiVersion, flexible, body);
    await this.write(frame);
  }

  private buildFrame(
    apiKey: number,
    apiVersion: number,
    flexible: boolean,
    body: Buffer,
  ): { frame: Buffer; correlationId: number } {
    const correlationId = this.nextCorrelationId++;
    const header = new KafkaWriter();
    header.int16(apiKey);
    header.int16(apiVersion);
    header.int32(correlationId);
    header.nullableString(this.options.clientId ?? 'ferrule');
    if (flexible) header.emptyTaggedFields();
    const headerBytes = header.build();

    const frame = new KafkaWriter();
    frame.int32(headerBytes.length + body.length);
    frame.bytes(headerBytes);
    frame.bytes(body);
    return { frame: frame.build(), correlationId };
  }

  private acquireInFlightSlot(): Promise<void> {
    const max = this.options.maxInFlightRequests ?? 5;
    if (this.inFlightCount < max) {
      this.inFlightCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.inFlightWaiters.push(() => {
        this.inFlightCount++;
        resolve();
      });
    });
  }

  private releaseInFlightSlot(): void {
    this.inFlightCount--;
    const next = this.inFlightWaiters.shift();
    next?.();
  }

  private onData(chunk: Buffer): void {
    this.recvBuffer =
      this.recvBuffer.length === 0 ? chunk : Buffer.concat([this.recvBuffer, chunk]);
    for (;;) {
      if (this.recvBuffer.length < 4) return;
      const size = this.recvBuffer.readInt32BE(0);
      if (this.recvBuffer.length < 4 + size) return;
      const frame = this.recvBuffer.subarray(4, 4 + size);
      this.recvBuffer = this.recvBuffer.subarray(4 + size);
      this.handleFrame(Buffer.from(frame));
    }
  }

  private handleFrame(frame: Buffer): void {
    // Every response header (flexible or not) starts with a plain Int32 correlation_id; the
    // flexible variant's trailing empty tagged-fields section is the caller's concern to skip
    // (each protocol.ts decoder knows whether its response header is flexible).
    const correlationId = frame.readInt32BE(0);
    const pending = this.pending.get(correlationId);
    if (pending === undefined) return; // no longer awaited (shouldn't normally happen)
    this.pending.delete(correlationId);
    pending.resolve(frame.subarray(4));
  }

  private fail(error: unknown): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error instanceof Error ? error : new Error(String(error));
    // An unexpected socket error or close makes this connection permanently unusable, exactly
    // like an explicit `close()` — without this, `KafkaProducer.getOrConnect`'s `!isClosed` reuse
    // check would hand back a dead connection on the very next send, whose `write()` either
    // throws or (worse) silently never resolves, instead of opening a fresh one.
    this.closed = true;
    for (const [, pending] of this.pending) pending.reject(this.terminalError);
    this.pending.clear();
  }

  private write(buf: Buffer): Promise<void> {
    if (this.socket === undefined) return Promise.reject(new Error('not connected'));
    return writeWithBackpressure(this.socket, buf);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error(`connection to ${this.remoteAddress} closed`));
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      socket.once('error', () => resolve());
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function dialTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`connection to ${host}:${port} timed out`));
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

function negotiateTls(
  raw: net.Socket,
  host: string,
  tlsOptions: TlsOptions,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      ...resolveTlsConnectOptions(tlsOptions, host, 'E_KAFKA_TLS_FILE'),
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
