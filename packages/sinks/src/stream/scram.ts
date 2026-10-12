/**
 * SCRAM-SHA-256 (RFC 5802 / RFC 7677) now lives in `@ferrule/codecs` (`src/scram.ts`), shared with
 * that package's Kafka SASL client, rather than duplicated here. This module re-exports it under
 * its original path so `../postgres/auth.ts` and this package's existing tests need no changes.
 */
export {
  ScramSha256Client,
  ScramProtocolError,
  saslPrepStored,
  generateClientNonce,
  saltPassword,
  parseScramAttributes,
} from '@ferrule/codecs';
