import { isZstdSupported, zstdUnsupportedMessage } from '@ferrule/codecs';
import { s, type Infer, type Schema } from '@ferrule/schema';
import { tlsSchema } from '../fragments.js';

/**
 * Option schema fragments shared by every sink in this HTTP family: authentication, proxying,
 * and request compression. `tls`/`batch`/`retry` come from the package-wide `../fragments.js`
 * (the same shapes stream-family and Postgres/Kafka sinks use); this module adds the fragments
 * that are specific to sinks that speak HTTP.
 */

export {
  batchSchema,
  retrySchema,
  tlsSchema,
  type BatchOptions,
  type RetryOptions,
  type TlsOptions,
} from '../fragments.js';

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

export const authSchema = s
  .tagged('strategy', {
    none: s.object({}),
    basic: s.object({
      username: s.string(),
      password: s.string().secret(),
    }),
    bearer: s.object({
      token: s.string().secret(),
    }),
    header: s.object({
      name: s.string().nonEmpty().describe('the header name to send the secret under'),
      value: s.string().secret(),
    }),
  })
  .optional()
  .describe('Authenticates outgoing requests.')
  .example({ strategy: 'bearer', token: '${secret:API_TOKEN}' });

export type AuthOptions = Infer<typeof authSchema>;

// ---------------------------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------------------------

const proxyInnerSchema = s.object({
  /** Read `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and lowercase variants) from the environment. */
  use_env: s.boolean().default(true),
  /** Explicit proxy URL, overriding the environment for every request regardless of scheme. */
  url: s.url({ protocols: ['http', 'https'] }).optional(),
});

export const proxySchema = proxyInnerSchema
  .optional()
  .describe('Outgoing proxy configuration.')
  .example({ url: 'http://proxy.internal:3128' });
export type ProxyOptions = Infer<typeof proxyInnerSchema>;

// ---------------------------------------------------------------------------------------------
// Request compression
// ---------------------------------------------------------------------------------------------

export const compressionSchema = s
  .enum(['none', 'gzip', 'zstd'])
  .default('none')
  .describe('Compresses the request body before sending.')
  .example('gzip');
export type CompressionOptions = Infer<typeof compressionSchema>;

/**
 * Rejects `compression: zstd` at config validation if this runtime's `node:zlib` has no zstd
 * support (see `isZstdSupported` from `@ferrule/codecs`), with a message naming the required
 * Node version — the same check `@ferrule/codecs`' Kafka sink applies to its own `compression`
 * option. Every HTTP-family sink's final option schema (after its own `.extend(...)`) wraps
 * itself with this, since `.refine()` on the base `Schema` class returns a plain `Schema<Out>`
 * (losing `ObjectSchema`-specific methods like `.extend()`), so it must be the last step applied.
 */
export function withZstdSupportCheck<T extends { compression: CompressionOptions }>(
  schema: Schema<T>,
): Schema<T> {
  return schema.refine(
    (o) => o.compression !== 'zstd' || isZstdSupported(),
    zstdUnsupportedMessage(),
  );
}

// ---------------------------------------------------------------------------------------------
// HTTP client transport options common to every sink
// ---------------------------------------------------------------------------------------------

/** Transport options common to every sink except `object_storage` (which authenticates every
 * request with AWS SigV4 instead of the shared {@link authSchema} strategies). */
export const transportSchemaNoAuth = s.object({
  tls: tlsSchema,
  proxy: proxySchema,
  /** Per-request timeout, from connection start to the response headers/body being read. */
  timeout: s.duration({ minMs: 1 }).default(30_000).describe('Per-request timeout.'),
  /** Maximum bytes read from a response body before the request is aborted. */
  max_response_size: s
    .byteSize({ min: 1 })
    .default(10 * 1024 * 1024)
    .describe('Maximum bytes read from a response body before the request is aborted.'),
  /** Compress the request body before sending. */
  compression: compressionSchema,
  /** Extra static headers sent with every request. Values are never logged. */
  headers: s
    .record(s.string())
    .optional()
    .describe('Extra static headers sent with every request.'),
  /** Maximum sockets kept alive per host. */
  max_sockets: s.integer({ min: 1 }).default(16).describe('Maximum sockets kept alive per host.'),
});
export type TransportOptionsNoAuth = Infer<typeof transportSchemaNoAuth>;

export const transportSchema = transportSchemaNoAuth.extend({ auth: authSchema });
export type TransportOptions = Infer<typeof transportSchema>;

// ---------------------------------------------------------------------------------------------
// Delivery concurrency
// ---------------------------------------------------------------------------------------------

export const concurrencySchema = s
  .integer({ min: 1 })
  .default(4)
  .describe('Number of batches this sink may deliver concurrently.');
