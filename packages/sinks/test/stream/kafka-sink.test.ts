import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { createKafkaSink, type KafkaSinkOptions } from '../../src/kafka/sink.js';
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

  it('retries a partly failed batch without resending the partitions that were accepted', async () => {
    // Keyed records spread over two partitions; partition 1 fails once with a retryable error.
    let failuresLeft = 1;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 2 },
      onProduce: ({ partition }) => {
        if (partition === 1 && failuresLeft > 0) {
          failuresLeft--;
          return { errorCode: 6 }; // NOT_LEADER_OR_FOLLOWER
        }
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port, { key: '{{ message }}' }));
    const ctx = createTestSinkContext();
    const events = Array.from({ length: 20 }, (_, i) => LogEvent.fromMessage(`k${i}`));
    const completions = events.map(withFinalizer);

    const running = sink.run(ctx.ctx);
    await ctx.feed(events);
    ctx.close();
    for (let i = 0; i < 200 && broker.receivedBatches.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.clock.advance(20);
    }
    await running;
    await expect(Promise.all(completions)).resolves.toEqual(Array(20).fill('delivered'));

    // Three batches reached the broker: partition 0 (accepted) and partition 1 (rejected) in the
    // first request, in either order, then the retry of partition 1 alone. Partition 0's records
    // were never sent a second time.
    const [first, second, retry] = broker.receivedBatches;
    const keysOf = (b: typeof first): string[] =>
      b!.decoded.records.map((r) => r.key!.toString('utf8')).sort();
    expect(retry!.partition).toBe(1);
    const acceptedFirst = first!.partition === 0 ? first : second;
    const rejectedFirst = first!.partition === 0 ? second : first;
    expect(rejectedFirst!.partition).toBe(1);
    expect(keysOf(retry)).toEqual(keysOf(rejectedFirst));
    expect([...keysOf(acceptedFirst), ...keysOf(retry)].sort()).toEqual(
      events.map((_, i) => `k${i}`).sort(),
    );
  }, 15_000);

  it('healthcheck succeeds against a reachable broker', async () => {
    broker = new FakeKafkaBroker();
    const port = await broker.listen();
    const sink = createKafkaSink(baseOptions(port));
    const ctx = createTestSinkContext();
    await expect(sink.healthcheck?.(ctx.ctx)).resolves.toBeUndefined();
  });
});
