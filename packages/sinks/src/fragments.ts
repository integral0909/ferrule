import { RetryPolicy, type Clock } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

/**
 * Option schema fragments shared by every sink in this package, regardless of family (HTTP,
 * stream/socket, Kafka, Postgres): TLS (client side), batching, retry, encoding, and wire
 * framing. Each sink's own option schema uses these directly, so the resulting configuration
 * surface is consistent across the package. HTTP-family-specific fragments (auth, proxy,
 * compression, the full request transport) live in `http/schema.ts`, which itself builds on the
 * `tlsSchema`/`batchSchema`/`retrySchema` fragments defined here.
 */

// ---------------------------------------------------------------------------------------------
// TLS (client side: a sink dialling out to a remote endpoint)
// ---------------------------------------------------------------------------------------------

const tlsInnerSchema = s.object({
  /** Require TLS for this connection. Only meaningful for sinks that do not already infer TLS
   * from the destination (e.g. an `https://` URL); ignored otherwise. */
  enabled: s.boolean().optional(),
  /** Path to a PEM-encoded CA certificate bundle used instead of Node's default trust store. */
  ca_file: s.string().optional(),
  /** Path to a PEM-encoded client certificate, for mutual TLS. */
  cert_file: s.string().optional(),
  /** Path to the PEM-encoded private key matching `cert_file`. */
  key_file: s.string().optional(),
  /** Verify the peer's certificate. Disabling this defeats TLS; a warning is logged. */
  verify_certificate: s.boolean().default(true),
  /** Overrides the hostname used for SNI and certificate verification. */
  server_name: s.string().optional(),
});

export const tlsSchema = tlsInnerSchema
  .optional()
  .describe('TLS options for this connection.')
  .example({ ca_file: '/etc/ferrule/tls/ca.pem' });
export type TlsOptions = Infer<typeof tlsInnerSchema>;

// ---------------------------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------------------------

const batchInnerSchema = s.object({
  /** Flush a batch once it reaches this many events. Default: sink-specific. */
  max_events: s.integer({ min: 1 }).optional(),
  /** Flush a batch once its estimated size reaches this many bytes. Default: sink-specific. */
  max_size: s.byteSize({ min: 1 }).optional(),
  /** Flush a batch this long after its first event, regardless of size. */
  timeout: s.duration({ minMs: 1 }).default(1_000),
});

export const batchSchema = batchInnerSchema
  .optional()
  .describe('Groups events into batches before delivering them.')
  .example({ max_events: 1000, timeout: '1s' });
export type BatchOptions = Infer<typeof batchInnerSchema>;

// ---------------------------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------------------------

const retryInnerSchema = s.object({
  /** Base delay before the first retry. */
  initial_backoff: s.duration({ minMs: 1 }).default(100),
  /** Ceiling the exponential backoff (with full jitter) is capped at. */
  max_backoff: s.duration({ minMs: 1 }).default(30_000),
  /** Give up after this many attempts. Default: unbounded. */
  max_attempts: s.integer({ min: 1 }).optional(),
  /** Give up once this much time has elapsed since the first attempt. Default: unbounded. */
  max_duration: s.duration({ minMs: 1 }).optional(),
});

export const retrySchema = retryInnerSchema
  .optional()
  .describe('Retry behaviour for transient delivery failures.')
  .example({ initial_backoff: '100ms', max_backoff: '30s' });
export type RetryOptions = Infer<typeof retryInnerSchema>;

/** Builds a `RetryPolicy` from the shared `retrySchema` shape (backoff always doubles; that
 * factor is not user-configurable). `options` is `undefined` when the sink's `retry` block was
 * omitted entirely — every field then falls back to the schema's own defaults. */
export function buildRetryPolicy(
  options: RetryOptions | undefined,
  random?: () => number,
): RetryPolicy {
  return new RetryPolicy({
    initialDelayMs: options?.initial_backoff ?? 100,
    maxDelayMs: options?.max_backoff ?? 30_000,
    multiplier: 2,
    ...(options?.max_attempts !== undefined ? { maxAttempts: options.max_attempts } : {}),
    ...(options?.max_duration !== undefined ? { maxElapsedMs: options.max_duration } : {}),
    ...(random !== undefined ? { random } : {}),
  });
}

/** Wall-clock `Date` for a sink's `ctx.clock`, for time-partitioned templates (object keys, etc.). */
export function clockDate(clock: Clock): Date {
  return clock.now().toDate();
}

// ---------------------------------------------------------------------------------------------
// Encoding: `{ codec, ...codec-specific options }`, mirroring `decoding` on the source side.
// ---------------------------------------------------------------------------------------------

/** Builds an `encoding` fragment for a sink whose codec is user-selectable, defaulting to
 * `defaultCodec`. */
export function encodingSchema(defaultCodec: string) {
  return s
    .object({
      codec: s.string().default(defaultCodec).describe('Codec used to serialise each event.'),
    })
    .passthrough()
    .default({ codec: defaultCodec })
    .describe(
      'Encoder configuration. Extra keys are passed through to the codec as its own options.',
    )
    .example({ codec: defaultCodec });
}

/** Splits a validated `decoding`/`encoding` fragment value into the codec name and the remaining
 * codec-specific options (`undefined` when there are none). The cast is safe: these schemas are
 * built with `.passthrough()`, so extra keys always survive validation even though the static
 * `Shape` only names `codec`. */
export function splitCodecOptions(value: { readonly codec: string }): [string, unknown] {
  const { codec, ...rest } = value as { codec: string } & Record<string, unknown>;
  return [codec, Object.keys(rest).length > 0 ? rest : undefined];
}

// ---------------------------------------------------------------------------------------------
// Framing: `{ method, ...method-specific options }`. Used by sinks that frame a stream of encoded
// events on the wire themselves (as opposed to the HTTP family's batch envelope, which is a
// different concept: how several already-encoded records are wrapped into one request body).
// ---------------------------------------------------------------------------------------------

export const framingSchema = s
  .tagged('method', {
    newline: s.object({}),
    octet_counting: s.object({}),
    length_prefixed: s.object({
      width: s.enum(['u16', 'u32']).default('u32').describe('Width of the length prefix.'),
      endianness: s.enum(['BE', 'LE']).default('BE').describe('Byte order of the length prefix.'),
    }),
  })
  .default({ method: 'newline' })
  .describe('How events are separated on the wire.')
  .example({ method: 'newline' }, { method: 'length_prefixed', width: 'u32', endianness: 'BE' });
export type FramingOptions = Infer<typeof framingSchema>;
