import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { isZstdSupported, KafkaErrorCode } from '@ferrule/codecs';
import { createTestSinkContext } from '@ferrule/runtime';
import {
  createKafkaSink,
  kafkaSinkOptionsSchema,
  type KafkaSinkOptions,
} from '../../src/kafka/sink.js';
import { FakeKafkaBroker } from './support/fake-kafka-broker.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function baseOptions(port: number, overrides: Partial<KafkaSinkOptions> = {}): KafkaSinkOptions {
  return {
    brokers: [{ host: '127.0.0.1', port }],
    client_id: 'ferrule-test',
    topic: 'events',
    encoding: { codec: 'json' },
    acks: '-1',
    compression: 'none',
    partitioner: 'sticky',
    connect_timeout: 2_000,
    request_timeout: 5_000,
    max_in_flight_requests_per_connection: 5,
    idempotent: true,
    batch: { max_events: 100, max_size: 1024 * 1024, timeout: 100 },
    retry: { initial_backoff: 5, max_backoff: 20 },
    ...overrides,
  };
}

let broker: FakeKafkaBroker | undefined;
afterEach(async () => {
  if (broker !== undefined) await broker.close();
  broker = undefined;
});

describe('kafka sink', () => {
  it('produces JSON-encoded events to the templated topic', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'hello' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('delivered');
    expect(broker.receivedBatches).toHaveLength(1);
    const record = broker.receivedBatches[0]!.decoded.records[0]!;
    expect(JSON.parse(record.value!.toString('utf8'))).toEqual({ message: 'hello' });
  });

  it('renders the topic and key from field-reference templates', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { 'logs-web': 4 } });
    const port = await broker.listen();
    const sink = createKafkaSink(
      baseOptions(port, {
        topic: 'logs-{{ service }}',
        key: '{{ host }}',
        encoding: { codec: 'text' },
      }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ service: 'web', host: 'h1', message: 'hi' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('delivered');
    const batch = broker.receivedBatches[0]!;
    expect(batch.topic).toBe('logs-web');
    expect(batch.decoded.records[0]?.key?.toString('utf8')).toBe('h1');
  });

  it('renders header templates', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    const sink = createKafkaSink(
      baseOptions(port, {
        headers: new Map([['x-service', '{{ service }}']]),
        encoding: { codec: 'text' },
      }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ service: 'api', message: 'x' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('delivered');
    const record = broker.receivedBatches[0]!.decoded.records[0]!;
    expect(record.headers).toEqual([{ key: 'x-service', value: Buffer.from('api') }]);
  });

  it('produces lz4-compressed batches the broker decodes correctly', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port, { compression: 'lz4' }));
    const ctx = createTestSinkContext();
    const event = LogEvent.from({ message: 'hello lz4' });
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('delivered');
    const batch = broker.receivedBatches[0]!.decoded;
    expect(batch.compression).toBe('lz4');
    expect(batch.crcValid).toBe(true);
    expect(JSON.parse(batch.records[0]!.value!.toString('utf8'))).toEqual({
      message: 'hello lz4',
    });
  });

  it.runIf(isZstdSupported())(
    'produces zstd-compressed batches the broker decodes correctly',
    async () => {
      broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
      const port = await broker.listen();
      const sink = createKafkaSink(baseOptions(port, { compression: 'zstd' }));
      const ctx = createTestSinkContext();
      const event = LogEvent.from({ message: 'hello zstd' });
      const completion = withFinalizer(event);

      const running = sink.run(ctx.ctx);
      await ctx.feed(event);
      ctx.close();
      await running;

      await expect(completion).resolves.toBe('delivered');
      const batch = broker.receivedBatches[0]!.decoded;
      expect(batch.compression).toBe('zstd');
      expect(batch.crcValid).toBe(true);
      expect(JSON.parse(batch.records[0]!.value!.toString('utf8'))).toEqual({
        message: 'hello zstd',
      });
    },
  );

  it('rejects an event whose rendered topic is empty', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port, { topic: '{{ missing }}' }));
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('rejected');
    expect(broker.receivedBatches).toHaveLength(0);
  });

  it('rejects the event on a permanent broker error', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => ({ errorCode: 29 }), // TOPIC_AUTHORIZATION_FAILED
    });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port));
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('rejected');
  });

  it('retries (driven by the manual clock) after a retryable broker error, then delivers', async () => {
    let attempts = 0;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        attempts++;
        if (attempts === 1) return { errorCode: 6 }; // NOT_LEADER_OR_FOLLOWER
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    const sink = createKafkaSink(
      baseOptions(port, { retry: { initial_backoff: 5, max_backoff: 20 } }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('retry-me');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();

    for (let i = 0; i < 200 && attempts < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.clock.advance(20);
    }
    await running;
    await expect(completion).resolves.toBe('delivered');
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('healthcheck succeeds against a reachable broker', async () => {
    broker = new FakeKafkaBroker();
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port));
    const ctx = createTestSinkContext();
    await expect(sink.healthcheck?.(ctx.ctx)).resolves.toBeUndefined();
  });
});

describe('kafka sink options validation (idempotent)', () => {
  function validOptions(overrides: Record<string, unknown> = {}): unknown {
    return {
      brokers: ['127.0.0.1:9092'],
      topic: 'events',
      encoding: { codec: 'json' },
      ...overrides,
    };
  }

  it('defaults idempotent to true, compatible with the default acks and in-flight limit', () => {
    const result = kafkaSinkOptionsSchema.safeParse(validOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.idempotent).toBe(true);
      expect(result.value.acks).toBe('-1');
      expect(result.value.max_in_flight_requests_per_connection).toBe(5);
    }
  });

  it('rejects idempotent: true combined with acks other than "-1"', () => {
    const result = kafkaSinkOptionsSchema.safeParse(validOptions({ idempotent: true, acks: '1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects idempotent: true combined with more than 5 in-flight requests', () => {
    const result = kafkaSinkOptionsSchema.safeParse(
      validOptions({ idempotent: true, max_in_flight_requests_per_connection: 6 }),
    );
    expect(result.ok).toBe(false);
  });

  it('allows idempotent: false with any acks/in-flight combination', () => {
    const result = kafkaSinkOptionsSchema.safeParse(
      validOptions({ idempotent: false, acks: '1', max_in_flight_requests_per_connection: 10 }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts compression: lz4 (no runtime dependency)', () => {
    const result = kafkaSinkOptionsSchema.safeParse(validOptions({ compression: 'lz4' }));
    expect(result.ok).toBe(true);
  });

  it.runIf(isZstdSupported())('accepts compression: zstd on a runtime with zstd support', () => {
    const result = kafkaSinkOptionsSchema.safeParse(validOptions({ compression: 'zstd' }));
    expect(result.ok).toBe(true);
  });

  it.runIf(!isZstdSupported())(
    'rejects compression: zstd on a runtime without zstd support',
    () => {
      const result = kafkaSinkOptionsSchema.safeParse(validOptions({ compression: 'zstd' }));
      expect(result.ok).toBe(false);
    },
  );
});

describe('kafka sink: idempotent production end to end (issue #17)', () => {
  it('a connection drop after the broker accepts the write produces no duplicate record', async () => {
    let attempts = 0;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        attempts++;
        // The broker applies the write, but the client never learns that (the connection drops
        // before any response), so the sink's retry policy resends the batch.
        if (attempts === 1) return { errorCode: 0, disconnectAfter: true };
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    const sink = createKafkaSink(
      baseOptions(port, { retry: { initial_backoff: 5, max_backoff: 20 } }),
    );
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('no-duplicate');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();

    for (let i = 0; i < 200 && attempts < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.clock.advance(20);
    }
    await running;

    await expect(completion).resolves.toBe('delivered');
    expect(broker.appliedRecords).toHaveLength(1);
  }, 15_000);

  it('finishes an event errored, not retried, when the broker reports PRODUCER_FENCED', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => ({ errorCode: KafkaErrorCode.PRODUCER_FENCED }),
    });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port));
    const ctx = createTestSinkContext();
    const event = LogEvent.fromMessage('fenced');
    const completion = withFinalizer(event);

    const running = sink.run(ctx.ctx);
    await ctx.feed(event);
    ctx.close();
    await running;

    await expect(completion).resolves.toBe('errored');
    expect(broker.appliedRecords).toHaveLength(0);
  });
});
