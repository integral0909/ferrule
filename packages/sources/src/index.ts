/**
 * Every source Ferrule ships, and `builtinSources()` for registering them all at once (see
 * `@ferrule/runtime`'s `ComponentRegistry`). Each source is also importable individually, e.g.
 * `import { httpServerSource } from '@ferrule/sources'`.
 */
import type { SourceDefinition } from '@ferrule/runtime';
import { demoLogsSource } from './demo_logs.js';
import { fileSource } from './file.js';
import { heartbeatSource } from './heartbeat.js';
import { httpServerSource } from './http_server.js';
import { internalMetricsSource } from './internal_metrics.js';
import { kafkaSource } from './kafka.js';
import { otlpSource } from './otlp.js';
import { prometheusScrapeSource } from './prometheus_scrape.js';
import { statsdSource } from './statsd.js';
import { stdinSource } from './stdin.js';
import { syslogSource } from './syslog.js';

export * from './demo_logs.js';
export * from './file.js';
export * from './heartbeat.js';
export * from './http_server.js';
export * from './internal_metrics.js';
export * from './kafka.js';
export * from './otlp.js';
export * from './prometheus_scrape.js';
export * from './statsd.js';
export * from './stdin.js';
export * from './syslog.js';

/** Every source this package ships, in the shape `ferrule`'s component registry expects. */
export function builtinSources(): readonly SourceDefinition<unknown>[] {
  return [
    demoLogsSource,
    fileSource,
    heartbeatSource,
    httpServerSource,
    internalMetricsSource,
    kafkaSource,
    otlpSource,
    prometheusScrapeSource,
    statsdSource,
    stdinSource,
    syslogSource,
  ];
}
