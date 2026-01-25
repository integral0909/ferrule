import type { SinkDefinition } from '@ferrule/runtime';
import { clickhouseSink } from './http/sinks/clickhouse.js';
import { elasticsearchSink } from './http/sinks/elasticsearch.js';
import { httpSink } from './http/sinks/http.js';
import { lokiSink } from './http/sinks/loki.js';
import { objectStorageSink } from './http/sinks/object-storage.js';
import { otlpSink } from './http/sinks/otlp.js';
import { prometheusExporterSink } from './http/sinks/prometheus-exporter.js';
import { prometheusRemoteWriteSink } from './http/sinks/prometheus-remote-write.js';

// Only sink definitions (and their own option types) are re-exported from the package barrel.
// The shared transport/templating/signing/compression internals under `./http/` are intentionally
// not re-exported here to avoid colliding with same-named helpers the sibling `stream-family`
// (owned by another engineer, built concurrently in this package) may export; tests and other
// in-package code import them directly by relative path instead.

export * from './http/sinks/clickhouse.js';
export * from './http/sinks/elasticsearch.js';
export * from './http/sinks/http.js';
export * from './http/sinks/loki.js';
export * from './http/sinks/object-storage.js';
export * from './http/sinks/otlp.js';
export * from './http/sinks/prometheus-exporter.js';
export * from './http/sinks/prometheus-remote-write.js';

/** Every sink definition in the HTTP family (M6): `http`, `loki`, `clickhouse`, `object_storage`,
 * `otlp`, `prometheus_remote_write`, `prometheus_exporter`, `elasticsearch`. */
export function httpFamilySinks(): SinkDefinition[] {
  return [
    httpSink,
    lokiSink,
    clickhouseSink,
    objectStorageSink,
    otlpSink,
    prometheusRemoteWriteSink,
    prometheusExporterSink,
    elasticsearchSink,
  ];
}
