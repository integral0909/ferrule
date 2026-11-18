import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { KafkaError } from '../../src/kafka/errors.js';
import { KafkaProducer, type OutgoingRecord } from '../../src/kafka/producer.js';
import { FakeKafkaBroker } from './support/fake-kafka-broker.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function outgoing(topic: string, overrides: Partial<OutgoingRecord> = {}): OutgoingRecord {
  const event = LogEvent.fromMessage('x');
  return {
    topic,
    key: null,
    value: Buffer.from('payload'),
    headers: [],
    timestamp: 1_700_000_000_000n,
    event,
    ...overrides,
  };
}

let broker: FakeKafkaBroker | undefined;
let producer: KafkaProducer | undefined;

afterEach(async () => {
  if (producer !== undefined) await producer.close();
  if (broker !== undefined) await broker.close();
  producer = undefined;
  broker = undefined;
});

describe('KafkaProducer: basic produce', () => {
  it('sends a record and the broker receives a byte-valid, CRC-checked RecordBatch', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

    const event = LogEvent.fromMessage('hello');
    const completion = withFinalizer(event);
    await producer.send([
      outgoing('events', { key: Buffer.from('k1'), value: Buffer.from('v1'), event }),
    ]);

    await expect(completion).resolves.toBe('delivered');
    expect(broker.receivedBatches).toHaveLength(1);
    const batch = broker.receivedBatches[0]!;
    expect(batch.topic).toBe('events');
    expect(batch.decoded.crcValid).toBe(true);
    expect(batch.decoded.records).toHaveLength(1);
    expect(batch.decoded.records[0]?.key?.toString('utf8')).toBe('k1');
    expect(batch.decoded.records[0]?.value?.toString('utf8')).toBe('v1');
  });

  it('routes records with the same key to the same partition (murmur2)', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 8 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

    const key = Buffer.from('stable-key');
    for (let i = 0; i < 5; i++) {
      const event = LogEvent.fromMessage(`m${i}`);
      await producer.send([outgoing('events', { key, value: Buffer.from(`v${i}`), event })]);
    }
    const partitions = new Set(broker.receivedBatches.map((b) => b.partition));
    expect(partitions.size).toBe(1);
  });

  it('sends headers and null key/value through untouched', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

    const event = LogEvent.fromMessage('x');
    await producer.send([
      outgoing('events', {
        key: null,
        value: null,
        headers: [{ key: 'trace', value: Buffer.from('abc') }],
        event,
      }),
    ]);
    const record = broker.receivedBatches[0]!.decoded.records[0]!;
    expect(record.key).toBeNull();
    expect(record.value).toBeNull();
    expect(record.headers).toEqual([{ key: 'trace', value: Buffer.from('abc') }]);
  });

  it('gzip-compresses the record batch when configured', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      compression: 'gzip',
    });
    const event = LogEvent.fromMessage('x');
    await producer.send([outgoing('events', { value: Buffer.from('compress-me'), event })]);
    expect(broker.receivedBatches[0]!.decoded.compression).toBe('gzip');
    expect(broker.receivedBatches[0]!.decoded.records[0]?.value?.toString('utf8')).toBe(
      'compress-me',
    );
  });

  it('acks=0 finishes events as delivered without waiting for a broker response', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }], acks: 0 });
    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);
    await producer.send([outgoing('events', { event })]);
    await expect(completion).resolves.toBe('delivered');
  });
});

describe('KafkaProducer: error handling', () => {
  it('finishes events as rejected on a permanent per-partition error', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => ({ errorCode: 29, errorMessage: 'not authorized' }), // TOPIC_AUTHORIZATION_FAILED
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);
    await expect(producer.send([outgoing('events', { event })])).resolves.toBeUndefined();
    await expect(completion).resolves.toBe('rejected');
  });

  it('throws a retryable KafkaError on a retryable per-partition error, without finishing the event', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => ({ errorCode: 6 }), // NOT_LEADER_OR_FOLLOWER
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);
    let caught: unknown;
    try {
      await producer.send([outgoing('events', { event })]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KafkaError);
    expect((caught as KafkaError).isRetryable).toBe(true);
    // The event must not have been finished yet (a retryable failure leaves it to the caller).
    const raced = await Promise.race([
      completion.then(() => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(raced).toBe('pending');
  });

  it('invalidates cached metadata for a topic after a stale-leader error, and a subsequent send refreshes it', async () => {
    let shouldFail = true;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        if (shouldFail) {
          shouldFail = false;
          return { errorCode: 6 }; // NOT_LEADER_OR_FOLLOWER
        }
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    const first = LogEvent.fromMessage('first');
    await expect(producer.send([outgoing('events', { event: first })])).rejects.toThrow(KafkaError);

    const second = LogEvent.fromMessage('second');
    const completion = withFinalizer(second);
    await producer.send([outgoing('events', { event: second })]);
    await expect(completion).resolves.toBe('delivered');
  });
});

describe('KafkaProducer: healthcheck and metadata', () => {
  it('healthcheck succeeds against a reachable broker', async () => {
    broker = new FakeKafkaBroker();
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    await expect(producer.healthcheck()).resolves.toBeUndefined();
  });

  it('refreshMetadata populates partition counts for multiple topics', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { a: 2, b: 3 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    await producer.refreshMetadata(['a', 'b']);
    // Indirectly verify via partitioning: keys should distribute across each topic's own range.
    const seenA = new Set<number>();
    const seenB = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const ea = LogEvent.fromMessage(`a${i}`);
      await producer.send([outgoing('a', { key: Buffer.from(`k${i}`), event: ea })]);
    }
    for (let i = 0; i < 30; i++) {
      const eb = LogEvent.fromMessage(`b${i}`);
      await producer.send([outgoing('b', { key: Buffer.from(`k${i}`), event: eb })]);
    }
    for (const b of broker.receivedBatches) {
      if (b.topic === 'a') seenA.add(b.partition);
      if (b.topic === 'b') seenB.add(b.partition);
    }
    for (const p of seenA) expect(p).toBeLessThan(2);
    for (const p of seenB) expect(p).toBeLessThan(3);
  });
});

describe('KafkaProducer: partial-failure retries', () => {
  it('resends only the unsettled partitions when the same batch is sent again', async () => {
    // Partition 0 accepts every time; partition 1 fails once with a retryable error.
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
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      partitioner: 'round_robin',
    });

    const events = Array.from({ length: 4 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const completions = events.map(withFinalizer);
    const batch = producer.prepare(
      events.map((event, i) => outgoing('events', { value: Buffer.from(`v${i}`), event })),
    );
    expect(batch.pending).toHaveLength(4);

    await expect(producer.send(batch)).rejects.toThrow(KafkaError);
    // Partition 0's two records were accepted and are settled; partition 1's are still pending.
    expect(batch.pending).toHaveLength(2);
    expect(broker.receivedBatches).toHaveLength(2);

    await producer.send(batch);
    expect(batch.pending).toHaveLength(0);
    await expect(Promise.all(completions)).resolves.toEqual(Array(4).fill('delivered'));

    // The retry carried exactly one more batch, for partition 1 only.
    expect(broker.receivedBatches).toHaveLength(3);
    expect(broker.receivedBatches[2]!.partition).toBe(1);
    const perPartition = new Map<number, number>();
    for (const b of broker.receivedBatches) {
      if (b.decoded.records.length === 0) continue;
      perPartition.set(b.partition, (perPartition.get(b.partition) ?? 0) + 1);
    }
    expect(perPartition.get(0)).toBe(1);
  });

  it('keeps partition assignment fixed across retries even after metadata was invalidated', async () => {
    let failuresLeft = 1;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 4 },
      onProduce: () => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return { errorCode: 3 }; // UNKNOWN_TOPIC_OR_PARTITION: invalidates cached metadata
        }
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

    const event = LogEvent.fromMessage('x');
    const completion = withFinalizer(event);
    const batch = producer.prepare([outgoing('events', { key: Buffer.from('k'), event })]);
    await expect(producer.send(batch)).rejects.toThrow(KafkaError);
    await producer.send(batch);
    await expect(completion).resolves.toBe('delivered');
    const partitions = broker.receivedBatches.map((b) => b.partition);
    expect(partitions).toHaveLength(2);
    expect(partitions[0]).toBe(partitions[1]);
  });

  it('a settled batch sent again is a no-op', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    const batch = producer.prepare([outgoing('events')]);
    await producer.send(batch);
    await producer.send(batch);
    expect(broker.receivedBatches).toHaveLength(1);
  });
});
