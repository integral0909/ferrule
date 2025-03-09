import { ComponentRegistry, defineSink, defineSource, defineTransform } from '@ferrule/runtime';
import { s } from '@ferrule/schema';

/** A small set of fake component definitions, used across the config test suite. */

export const httpSource = defineSource({
  type: 'http',
  kind: 'source',
  description: 'a fake HTTP source, for tests',
  options: s.object({
    address: s.socketAddress(),
    max_body: s.byteSize().default(1024 * 1024),
  }),
  produces: () => ['log'],
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export const statsdSource = defineSource({
  type: 'statsd',
  kind: 'source',
  description: 'a fake StatsD source, for tests',
  options: s.object({ address: s.socketAddress() }),
  produces: () => ['metric'],
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export const scriptTransform = defineTransform({
  type: 'script',
  kind: 'transform',
  description: 'a fake script transform, for tests',
  accepts: ['log', 'metric', 'span'],
  options: s.object({ source: s.string() }),
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export const routeTransform = defineTransform({
  type: 'route',
  kind: 'transform',
  description: 'a fake route transform, for tests',
  accepts: ['log', 'metric', 'span'],
  options: s.object({ condition: s.string() }),
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export const clickhouseSink = defineSink({
  type: 'clickhouse',
  kind: 'sink',
  description: 'a fake ClickHouse sink, for tests',
  accepts: ['log'],
  options: s.object({
    endpoint: s.url(),
    table: s.string(),
    batch: s
      .object({ max_events: s.integer({ min: 1 }).default(1000) })
      .default({ max_events: 1000 }),
    auth: s.object({ password: s.string().secret() }).optional(),
  }),
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export const consoleSink = defineSink({
  type: 'console',
  kind: 'sink',
  description: 'a fake console sink, for tests',
  accepts: ['log', 'metric', 'span'],
  options: s.object({}),
  build(): never {
    throw new Error('not implemented in tests');
  },
});

export function testRegistry(): ComponentRegistry {
  return new ComponentRegistry().register(
    httpSource,
    statsdSource,
    scriptTransform,
    routeTransform,
    clickhouseSink,
    consoleSink,
  );
}
