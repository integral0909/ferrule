import type { Clock, Logger, MetricsRegistry, Pipeline, ReloadResult } from '@ferrule/runtime';

/** The host/port an {@link AdminServer} actually bound to, after `start()`. */
export interface BoundAddress {
  readonly host: string;
  readonly port: number;
}

export interface AdminAuthOptions {
  /** Bearer token required in `Authorization: Bearer <token>`. Never logged. */
  readonly token: string;
  /** If true, every endpoint requires the token, not just mutating ones (`POST /reload`).
   * Default false. */
  readonly requireForAll?: boolean;
}

export interface AdminTapOptions {
  /** Interval between `text/event-stream` heartbeat comments. Default 15000. */
  readonly heartbeatIntervalMs?: number;
  /** Bound on a subscriber's queue; once full, the oldest queued event is dropped (and counted)
   * rather than slowing the pipeline. Default 1000. */
  readonly defaultQueueCapacity?: number;
  /** Hard cap applied to a client-supplied `?limit=`. Default 100000. */
  readonly maxLimit?: number;
}

export interface AdminServerOptions {
  readonly pipeline: Pipeline;
  readonly metrics: MetricsRegistry;
  /** Default `{ host: '127.0.0.1', port: 0 }` (an ephemeral port on loopback only). */
  readonly address?: { readonly host?: string; readonly port?: number };
  readonly auth?: AdminAuthOptions;
  /** Performs a hot reload and reports the structured result. Re-reading configuration from disk
   * (or wherever it lives) is the caller's job; this only triggers it. Supplied by the CLI. */
  readonly onReload?: () => ReloadResult | Promise<ReloadResult>;
  /** Returns the current effective configuration as text, with secrets redacted. Never the raw
   * configuration. Supplied by the CLI. */
  readonly configDump?: () => string | Promise<string>;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** Extra `Host` header values accepted besides the loopback names for the bound address, for
   * the DNS-rebinding guard. Only consulted when bound to a loopback address. */
  readonly allowedHosts?: readonly string[];
  /** Maximum request body size, in bytes. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Maximum time given to a non-streaming request before it fails with 408. Default 30000.
   * `/tap` is exempt: it is a long-lived stream by design. */
  readonly requestTimeoutMs?: number;
  readonly tap?: AdminTapOptions;
}

/** An embeddable admin HTTP server: health, topology, metrics, component detail, live event tap,
 * config, and reload. Build one with {@link createAdminServer}. */
export interface AdminServer {
  /** Starts listening and resolves to the address actually bound (useful with `port: 0`). */
  start(): Promise<BoundAddress>;
  /** Stops accepting new connections, closes every open `/tap` stream, and waits for in-flight
   * requests to finish. Idempotent. */
  stop(): Promise<void>;
  /** The bound address, or `undefined` before `start()` resolves and after `stop()`. */
  readonly address: BoundAddress | undefined;
  /** Number of currently open `/tap` subscriptions. For diagnostics and tests. */
  activeTapCount(): number;
}

export interface ComponentDetail {
  readonly id: string;
  readonly kind: string;
  readonly type: string;
  readonly state: string;
  readonly error?: string;
  readonly metrics: readonly MetricEventJson[];
}

export type MetricValueJson =
  | { readonly type: 'counter' | 'gauge'; readonly value: number }
  | { readonly type: 'set'; readonly values: readonly string[] }
  | {
      readonly type: 'distribution';
      readonly samples: readonly { readonly value: number; readonly rate: number }[];
    }
  | {
      readonly type: 'histogram';
      readonly buckets: readonly { readonly upperLimit: number; readonly count: number }[];
      readonly count: number;
      readonly sum: number;
    }
  | {
      readonly type: 'exponentialHistogram';
      readonly scale: number;
      readonly zeroCount: number;
      readonly zeroThreshold: number;
      readonly positive: { readonly offset: number; readonly counts: readonly number[] };
      readonly negative: { readonly offset: number; readonly counts: readonly number[] };
      readonly count: number;
      readonly sum: number;
    }
  | {
      readonly type: 'summary';
      readonly quantiles: readonly { readonly quantile: number; readonly value: number }[];
      readonly count: number;
      readonly sum: number;
    };

/** A JSON-safe rendering of a `MetricEvent`, used by `GET /metrics?format=json` and
 * `GET /components/:id`. */
export interface MetricEventJson {
  readonly name: string;
  readonly namespace?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly kind: string;
  readonly value: MetricValueJson;
  readonly timestamp?: string;
  readonly intervalMs?: number;
}
