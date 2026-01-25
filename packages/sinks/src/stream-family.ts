/**
 * The "stream family" of sinks: local process streams, files, raw sockets, syslog, and the
 * hand-written PostgreSQL and Kafka wire-protocol clients. See `README.stream.md` for an overview
 * of each sink's options. The HTTP-family sinks live in `http-family.ts`, built independently.
 */
import type { SinkDefinition } from '@ferrule/runtime';
import { blackholeSink } from './stream/blackhole.js';
import { consoleSink } from './stream/console.js';
import { fileSink } from './stream/file.js';
import { socketSink } from './stream/socket.js';
import { syslogSink } from './stream/syslog.js';
import { postgresSink } from './postgres/sink.js';
import { kafkaSink } from './kafka/sink.js';

export * from './stream/backpressure-write.js';
export * from './stream/blackhole.js';
export * from './stream/console.js';
export * from './stream/file.js';
export * from './stream/frame-writer.js';
export * from './stream/safe-path.js';
export * from './stream/scram.js';
export * from './stream/socket.js';
export * from './stream/syslog.js';
export * from './stream/template.js';
export * from './stream/wire-transport.js';

export * from './postgres/auth.js';
export * from './postgres/connection.js';
export * from './postgres/copy-format.js';
export * from './postgres/errors.js';
export * from './postgres/pool.js';
export * from './postgres/sink.js';
export * from './postgres/wire.js';

export * from './kafka/connection.js';
export * from './kafka/errors.js';
export * from './kafka/murmur2.js';
export * from './kafka/primitives.js';
export * from './kafka/producer.js';
export * from './kafka/protocol.js';
export * from './kafka/record-batch.js';
export * from './kafka/sasl.js';
export * from './kafka/sink.js';

/** Every sink this module defines, ready to register with a `ComponentRegistry`. */
export function streamFamilySinks(): SinkDefinition[] {
  return [consoleSink, blackholeSink, fileSink, socketSink, syslogSink, postgresSink, kafkaSink];
}
