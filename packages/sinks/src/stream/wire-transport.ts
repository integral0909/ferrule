import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { FerruleError } from '@ferrule/core';
import { SinkError, type Logger } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

/** Shared TLS option shape for every sink that dials a raw TCP socket (`socket`, `syslog`). */
export const tlsOptionsSchema = s.object({
  enabled: s.boolean().default(false),
  ca: s.string().optional(),
  cert: s.string().optional(),
  key: s.string().optional(),
  rejectUnauthorized: s.boolean().default(true),
  serverName: s.string().optional(),
});

export type TlsOptions = Infer<typeof tlsOptionsSchema>;

export interface WireEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls?: TlsOptions;
  readonly connectTimeout: number;
}

export interface Transport {
  /** Sends already-encoded (and, for TCP, framed) bytes. Throws a {@link SinkError}. */
  send(payload: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Establishes connectivity without sending anything, for health checks. */
  probe(): Promise<void>;
  close(): Promise<void>;
}

export function describeError(error: unknown): string {
  if (error instanceof FerruleError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A persistent TCP (optionally TLS) connection, dialled lazily and redialled after any error.
 * Reconnect backoff is deliberately not implemented here: a failed {@link send} throws a
 * retryable {@link SinkError}, and the caller's `RetryPolicy` (driven by `ctx.clock`, so it is
 * deterministic in tests) supplies the backoff between attempts — reusing the sink toolkit's
 * retry loop instead of a second, bespoke one.
 */
export class TcpTransport implements Transport {
  private socket: net.Socket | tls.TLSSocket | undefined;

  constructor(
    private readonly endpoint: WireEndpoint,
    private readonly logger: Logger,
    private readonly writeChunk: (
      socket: net.Socket | tls.TLSSocket,
      payload: Uint8Array,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async send(payload: Uint8Array, signal: AbortSignal): Promise<void> {
    if (payload.length === 0) return;
    const socket = await this.ensureConnected();
    try {
      await this.writeChunk(socket, payload, signal);
    } catch (error) {
      this.teardown();
      throw SinkError.retryable('E_SOCKET_WRITE', describeError(error), { cause: error });
    }
  }

  async probe(): Promise<void> {
    await this.ensureConnected();
  }

  private async ensureConnected(): Promise<net.Socket | tls.TLSSocket> {
    if (this.socket !== undefined && !this.socket.destroyed) return this.socket;
    try {
      this.socket = await this.dial();
      return this.socket;
    } catch (error) {
      throw SinkError.retryable('E_SOCKET_CONNECT', describeError(error), { cause: error });
    }
  }

  private dial(): Promise<net.Socket | tls.TLSSocket> {
    const { host, port } = this.endpoint;
    return new Promise((resolve, reject) => {
      const useTls = this.endpoint.tls?.enabled === true;
      const socket = useTls
        ? tls.connect({
            host,
            port,
            ca: this.endpoint.tls?.ca,
            cert: this.endpoint.tls?.cert,
            key: this.endpoint.tls?.key,
            rejectUnauthorized: this.endpoint.tls?.rejectUnauthorized ?? true,
            servername: this.endpoint.tls?.serverName ?? host,
          })
        : net.createConnection({ host, port });
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`connection to ${host}:${port} timed out`));
      }, this.endpoint.connectTimeout);
      const readyEvent = useTls ? 'secureConnect' : 'connect';
      const onReady = (): void => {
        cleanup();
        socket.on('error', (err) =>
          this.logger.debug('socket connection error', { error: describeError(err) }),
        );
        resolve(socket);
      };
      const onError = (err: Error): void => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off(readyEvent, onReady);
        socket.off('error', onError);
      };
      socket.once(readyEvent, onReady);
      socket.once('error', onError);
    });
  }

  private teardown(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      socket.once('error', () => resolve());
    });
  }
}

/** A UDP socket. Connectionless, so there is nothing to redial; a send failure is surfaced as a
 * retryable {@link SinkError} and left to the caller's retry policy. */
export class UdpTransport implements Transport {
  private readonly socket: dgram.Socket;
  private bound: Promise<void> | undefined;

  constructor(private readonly endpoint: Pick<WireEndpoint, 'host' | 'port'>) {
    this.socket = dgram.createSocket('udp4');
  }

  private ensureBound(): Promise<void> {
    this.bound ??= new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(() => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    return this.bound;
  }

  async send(payload: Uint8Array, _signal: AbortSignal): Promise<void> {
    if (payload.length === 0) return;
    await this.ensureBound();
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, this.endpoint.port, this.endpoint.host, (err) => {
        if (err) reject(SinkError.retryable('E_SOCKET_SEND', describeError(err), { cause: err }));
        else resolve();
      });
    });
  }

  async probe(): Promise<void> {
    await this.ensureBound();
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }
}
