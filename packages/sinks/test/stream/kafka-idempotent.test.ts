import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { KafkaErrorCode } from '../../src/kafka/errors.js';
import { KafkaProducer, type OutgoingRecord } from '../../src/kafka/producer.js';
import { FakeKafkaBroker } from './support/fake-kafka-broker.js';

/**
 * The idempotent producer (GitHub #17): InitProducerId, a producer epoch, and per-partition
 * sequence numbers in every RecordBatch, so a retry after a partial failure (a retryable broker
 * error, or a connection dropped after the broker already applied the write but before its
 * response arrived) resends the exact same sequence range instead of duplicating the record.
 */

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

describe('KafkaProducer: idempotent option validation', () => {
  it('rejects idempotent: true combined with acks other than -1', () => {
    expect(
      () =>
        new KafkaProducer({
          bootstrapBrokers: [{ host: '127.0.0.1', port: 9092 }],
          idempotent: true,
          acks: 1,
        }),
    ).toThrow(/acks/);
  });

  it('rejects idempotent: true combined with more than 5 in-flight requests', () => {
    expect(
      () =>
        new KafkaProducer({
          bootstrapBrokers: [{ host: '127.0.0.1', port: 9092 }],
          idempotent: true,
          maxInFlightRequestsPerConnection: 6,
        }),
    ).toThrow(/InFlight/);
  });

  it('accepts idempotent: true with acks: -1 and up to 5 in-flight requests', () => {
    expect(
      () =>
        new KafkaProducer({
          bootstrapBrokers: [{ host: '127.0.0.1', port: 9092 }],
          idempotent: true,
          acks: -1,
          maxInFlightRequestsPerConnection: 5,
        }),
    ).not.toThrow();
  });
});

describe('KafkaProducer: idempotent sequencing', () => {
  it('initializes a producer ID and stamps the first batch with baseSequence 0', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
    });
    const event = LogEvent.fromMessage('hello');
    const completion = withFinalizer(event);
    await producer.send([outgoing('events', { event })]);
    await expect(completion).resolves.toBe('delivered');

    expect(broker.producerIdsIssued).toBe(1);
    const decoded = broker.receivedBatches[0]!.decoded;
    expect(decoded.baseSequence).toBe(0);
    expect(decoded.producerEpoch).toBe(0);
    expect(decoded.producerId).toBeGreaterThanOrEqual(0n);
  });

  it('advances the sequence number across successive batches to the same partition', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
    });
    for (let i = 0; i < 3; i++) {
      const event = LogEvent.fromMessage(`m${i}`);
      await producer.send([outgoing('events', { event, value: Buffer.from(`v${i}`) })]);
    }
    expect(broker.receivedBatches.map((b) => b.decoded.baseSequence)).toEqual([0, 1, 2]);
  });

  it('reuses the same producerId/epoch/baseSequence when retrying the same batch array', async () => {
    let attempts = 0;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        attempts++;
        if (attempts === 1) return { errorCode: KafkaErrorCode.NOT_LEADER_OR_FOLLOWER };
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
    });
    const event = LogEvent.fromMessage('retry-me');
    const completion = withFinalizer(event);
    const batch = [outgoing('events', { event })];

    await expect(producer.send(batch)).rejects.toThrow();
    await producer.send(batch); // the caller's retry: the exact same array reference

    await expect(completion).resolves.toBe('delivered');
    expect(attempts).toBe(2);
    expect(broker.receivedBatches).toHaveLength(2);
    const [first, second] = broker.receivedBatches.map((b) => b.decoded);
    expect(second!.baseSequence).toBe(first!.baseSequence);
    expect(second!.producerId).toBe(first!.producerId);
    expect(second!.producerEpoch).toBe(first!.producerEpoch);
    // Only one copy of the record was ever actually applied.
    expect(broker.appliedRecords).toHaveLength(1);
  });

  it('a connection drop after the broker applies the write produces no duplicate: the retry is deduplicated', async () => {
    let attempts = 0;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        attempts++;
        // The broker accepts and applies the write, but the client never finds out (the
        // connection drops before any response), so it must retry.
        if (attempts === 1) return { errorCode: 0, disconnectAfter: true };
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
    });
    const event = LogEvent.fromMessage('dropped-ack');
    const completion = withFinalizer(event);
    const batch = [outgoing('events', { event, value: Buffer.from('once') })];

    // First attempt: the broker applies it then drops the connection, so the producer sees a
    // connection-level failure and throws (without finishing the event).
    await expect(producer.send(batch)).rejects.toThrow();
    // The caller's retry, same batch reference, same reserved sequence.
    await producer.send(batch);

    await expect(completion).resolves.toBe('delivered');
    // The broker's dedup check recognises the retry's sequence number as already applied before
    // ever consulting `onProduce` again (exactly like a real broker never re-appending a
    // duplicate to the log) — so the hook itself only ever ran once.
    expect(attempts).toBe(1);
    expect(broker.appliedRecords).toHaveLength(1);
    expect(broker.appliedRecords[0]?.value?.toString('utf8')).toBe('once');
  });

  it('a partial batch failure across two partitions resends only via the same sequence, with no duplicate on the partition that already succeeded', async () => {
    // `round_robin` assigns deterministically (first unkeyed record in the batch -> partition 0,
    // second -> partition 1), so which partition fails first try is known rather than left to
    // murmur2's hash of an arbitrary key.
    let firstAttempt = true;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 2 },
      onProduce: ({ partition }) => {
        // Partition 1 fails the first try (simulating the "partial batch failure" from the
        // GitHub issue: partition 0 already accepted) and succeeds on retry.
        if (partition === 1 && firstAttempt) {
          firstAttempt = false;
          return { errorCode: KafkaErrorCode.NOT_LEADER_OR_FOLLOWER };
        }
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
      partitioner: 'round_robin',
    });
    const eventA = LogEvent.fromMessage('a');
    const eventB = LogEvent.fromMessage('b');
    const completionA = withFinalizer(eventA);
    const completionB = withFinalizer(eventB);
    const batch = [
      outgoing('events', { key: null, value: Buffer.from('record-a'), event: eventA }),
      outgoing('events', { key: null, value: Buffer.from('record-b'), event: eventB }),
    ];
    await expect(producer.send(batch)).rejects.toThrow();
    await producer.send(batch); // the caller's retry resends *both* records, same array reference

    await expect(completionA).resolves.toBe('delivered');
    await expect(completionB).resolves.toBe('delivered');
    // Exactly one applied copy of each record, however many times the batch as a whole was sent
    // — in particular, partition 0's record (accepted on the very first attempt) is not
    // re-applied just because it was bundled with partition 1's in the retried batch.
    expect(broker.appliedRecords.map((r) => r.value?.toString('utf8')).sort()).toEqual([
      'record-a',
      'record-b',
    ]);
  });
});

describe('KafkaProducer: idempotent error handling', () => {
  it.each([
    ['OUT_OF_ORDER_SEQUENCE_NUMBER', KafkaErrorCode.OUT_OF_ORDER_SEQUENCE_NUMBER],
    ['INVALID_PRODUCER_EPOCH', KafkaErrorCode.INVALID_PRODUCER_EPOCH],
    ['PRODUCER_FENCED', KafkaErrorCode.PRODUCER_FENCED],
  ])(
    'finishes the event errored (not retried) and resets the producer ID on %s',
    async (_name, errorCode) => {
      let fenced = true;
      broker = new FakeKafkaBroker({
        partitionCounts: { events: 1 },
        onProduce: () => {
          if (fenced) {
            fenced = false;
            return { errorCode };
          }
          return { errorCode: 0 };
        },
      });
      const port = await broker.listen();
      producer = new KafkaProducer({
        bootstrapBrokers: [{ host: '127.0.0.1', port }],
        idempotent: true,
      });
      const event = LogEvent.fromMessage('fenced');
      const completion = withFinalizer(event);

      // The producer does not throw: the affected event is finished directly, not left for the
      // caller to retry (retrying under a reset identity could duplicate or reorder it).
      await expect(producer.send([outgoing('events', { event })])).resolves.toBeUndefined();
      await expect(completion).resolves.toBe('errored');
      expect(broker.appliedRecords).toHaveLength(0);

      // The next send re-initializes the producer ID and starts sequencing from 0 again.
      broker.receivedBatches.length = 0;
      const second = LogEvent.fromMessage('after-reset');
      const secondCompletion = withFinalizer(second);
      await producer.send([outgoing('events', { event: second })]);
      await expect(secondCompletion).resolves.toBe('delivered');
      expect(broker.producerIdsIssued).toBe(2);
      expect(broker.receivedBatches[0]?.decoded.baseSequence).toBe(0);
    },
  );

  it('treats DUPLICATE_SEQUENCE_NUMBER explicitly reported by the broker as delivered', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => ({ errorCode: KafkaErrorCode.DUPLICATE_SEQUENCE_NUMBER }),
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: true,
    });
    const event = LogEvent.fromMessage('already-there');
    const completion = withFinalizer(event);
    await producer.send([outgoing('events', { event })]);
    await expect(completion).resolves.toBe('delivered');
  });
});
