/**
 * Option schema fragments shared by every built-in source: server-side TLS (for sources that
 * terminate TLS themselves) and inbound request authentication. Each source's own option schema
 * uses these directly, so the resulting configuration surface is consistent across the package.
 *
 * See also `util/http.ts`, which holds the runtime helpers (`loadTlsServerOptions`, `checkAuth`,
 * ...) that consume the types defined here.
 */
import { s, type Infer } from '@ferrule/schema';

// ---------------------------------------------------------------------------------------------
// TLS (server side: a source that terminates TLS itself, e.g. http_server, otlp, syslog's tcp mode)
// ---------------------------------------------------------------------------------------------

export const tlsSchema = s
  .object({
    cert_file: s.string().describe('Path to a PEM certificate (or full chain) file.'),
    key_file: s.string().describe('Path to the PEM private key file.'),
    ca_file: s
      .string()
      .optional()
      .describe('Path to a PEM CA bundle used to verify client certificates.'),
    require_client_cert: s
      .boolean()
      .default(false)
      .describe(
        'Request a client certificate. With ca_file set, a certificate that fails verification ' +
          'is rejected.',
      ),
  })
  .optional()
  .describe('Enables TLS. Omit to serve plain HTTP.')
  .example({ cert_file: '/etc/ferrule/tls/cert.pem', key_file: '/etc/ferrule/tls/key.pem' });

export type TlsOptions = Infer<typeof tlsSchema>;

// ---------------------------------------------------------------------------------------------
// Auth (authenticating inbound requests made to a source)
// ---------------------------------------------------------------------------------------------

export const authSchema = s
  .object({
    strategy: s
      .enum(['none', 'bearer', 'basic'])
      .default('none')
      .describe('Authentication required of clients: none, a bearer token, or HTTP Basic.'),
    token: s
      .string()
      .secret()
      .optional()
      .describe('Required bearer token when strategy is "bearer".'),
    username: s.string().optional().describe('Required username when strategy is "basic".'),
    password: s
      .string()
      .secret()
      .optional()
      .describe('Required password when strategy is "basic".'),
  })
  .refine((v) => {
    if (v.strategy === 'bearer') return typeof v.token === 'string' && v.token.length > 0;
    if (v.strategy === 'basic') {
      return (
        typeof v.username === 'string' && v.username.length > 0 && typeof v.password === 'string'
      );
    }
    return true;
  }, 'auth.token is required when strategy is "bearer"; auth.username and auth.password are required when strategy is "basic"')
  .default({ strategy: 'none' })
  .describe('Authentication required of clients making requests to this source.')
  .example({ strategy: 'bearer', token: '${secret:API_TOKEN}' });

export type AuthOptions = Infer<typeof authSchema>;

// ---------------------------------------------------------------------------------------------
// Decoding: `{ codec, ...codec-specific options }`. `codec` selects the decoder; every other key
// is passed through, untyped, to that codec (codec option shapes live in `@ferrule/codecs`, not
// in this schema layer).
// ---------------------------------------------------------------------------------------------

/** Builds a `decoding` fragment for a source whose codec is user-selectable, defaulting to
 * `defaultCodec`. */
export function decodingSchema(defaultCodec: string) {
  return s
    .object({
      codec: s.string().default(defaultCodec).describe('Codec used to parse the raw input.'),
    })
    .passthrough()
    .default({ codec: defaultCodec })
    .describe(
      'Decoder configuration. Extra keys are passed through to the codec as its own options.',
    )
    .example({ codec: defaultCodec });
}

/** Splits a validated `decoding`/`encoding` fragment value into the codec name and the remaining
 * codec-specific options (`undefined` when there are none), ready for `CodecRegistry.createDecoder`
 * / `createEncoder`. The cast is safe: `codec` schemas are built with `.passthrough()`, so extra
 * keys always survive validation even though the static `Shape` only names `codec`. */
export function splitCodecOptions(value: { readonly codec: string }): [string, unknown] {
  const { codec, ...rest } = value as { codec: string } & Record<string, unknown>;
  return [codec, Object.keys(rest).length > 0 ? rest : undefined];
}
