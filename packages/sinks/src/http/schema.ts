import { s, type Infer } from '@ferrule/schema';

/**
 * Option schema fragments shared by every sink in this package: authentication, TLS, proxying,
 * request compression, and batching. Each sink's own option schema extends these so the
 * resulting configuration surface (and its redaction behaviour) is consistent across the family.
 */

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

export const authSchema = s
  .tagged('type', {
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
  .optional();

export type AuthOptions = Infer<typeof authSchema>;

// ---------------------------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------------------------

const tlsInnerSchema = s.object({
  /** Path to a PEM-encoded CA certificate bundle used instead of Node's default trust store. */
  caFile: s.string().optional(),
  /** Path to a PEM-encoded client certificate, for mutual TLS. */
  certFile: s.string().optional(),
  /** Path to the PEM-encoded private key matching `certFile`. */
  keyFile: s.string().optional(),
  /** Verify the server's certificate. Disabling this defeats TLS; a warning is logged. */
  verify: s.boolean().default(true),
});

export const tlsSchema = tlsInnerSchema.optional();
export type TlsOptions = Infer<typeof tlsInnerSchema>;

// ---------------------------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------------------------

const proxyInnerSchema = s.object({
  /** Read `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and lowercase variants) from the environment. */
  useEnv: s.boolean().default(true),
  /** Explicit proxy URL, overriding the environment for every request regardless of scheme. */
  url: s.url({ protocols: ['http', 'https'] }).optional(),
});

export const proxySchema = proxyInnerSchema.optional();
export type ProxyOptions = Infer<typeof proxyInnerSchema>;

// ---------------------------------------------------------------------------------------------
// Request compression
// ---------------------------------------------------------------------------------------------

export const compressionSchema = s.enum(['none', 'gzip']).default('none');
export type CompressionOptions = Infer<typeof compressionSchema>;

// ---------------------------------------------------------------------------------------------
// HTTP client transport options common to every sink
// ---------------------------------------------------------------------------------------------

/** Transport options common to every sink except `object_storage` (which authenticates every
 * request with AWS SigV4 instead of the shared {@link authSchema} strategies). */
export const transportSchemaNoAuth = s.object({
  tls: tlsSchema,
  proxy: proxySchema,
  /** Per-request timeout, from connection start to the response headers/body being read. */
  timeout: s.duration({ minMs: 1 }).default(30_000),
  /** Maximum bytes read from a response body before the request is aborted. */
  maxResponseBytes: s.byteSize({ min: 1 }).default(10 * 1024 * 1024),
  /** Compress the request body before sending. */
  compression: compressionSchema,
  /** Extra static headers sent with every request. Values are never logged. */
  headers: s.record(s.string()).optional(),
  /** Maximum sockets kept alive per host. */
  maxSockets: s.integer({ min: 1 }).default(16),
});
export type TransportOptionsNoAuth = Infer<typeof transportSchemaNoAuth>;

export const transportSchema = transportSchemaNoAuth.extend({ auth: authSchema });
export type TransportOptions = Infer<typeof transportSchema>;

// ---------------------------------------------------------------------------------------------
// Batching (mirrors runBatchedSink's own knobs, as a reusable options fragment)
// ---------------------------------------------------------------------------------------------

export const batchSchema = s.object({
  maxEvents: s.integer({ min: 1 }).optional(),
  maxBytes: s.byteSize({ min: 1 }).optional(),
  timeout: s.duration({ minMs: 1 }).default(1_000),
});
export type BatchOptions = Infer<typeof batchSchema>;

export const retrySchema = s.object({
  initialDelay: s.duration({ minMs: 1 }).default(100),
  maxDelay: s.duration({ minMs: 1 }).default(30_000),
  multiplier: s.number({ greaterThan: 1 }).default(2),
  maxAttempts: s.integer({ min: 1 }).optional(),
  maxElapsed: s.duration({ minMs: 1 }).optional(),
});
export type RetryOptions = Infer<typeof retrySchema>;

export const concurrencySchema = s.integer({ min: 1 }).default(4);
