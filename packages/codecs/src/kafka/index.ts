/**
 * A hand-written Kafka wire protocol client: binary primitives, RecordBatch v2 encode/decode,
 * murmur2 partitioning, request/response codecs, SASL, broker connections, and (built on those) a
 * full consumer group client. Originally built for `@ferrule/sinks`'s Kafka producer; it lives
 * here, rather than in `@ferrule/sinks`, so a Kafka *source* (`@ferrule/sources`, a separate
 * package that must not depend on `@ferrule/sinks`) can reuse every bit of it — see each file's
 * own comment for what it provides.
 */
export * from './assignors.js';
export * from './connection.js';
export * from './consumer.js';
export * from './consumer-protocol.js';
export * from './errors.js';
export * from './murmur2.js';
export * from './primitives.js';
export * from './protocol.js';
export * from './record-batch.js';
export * from './sasl.js';
