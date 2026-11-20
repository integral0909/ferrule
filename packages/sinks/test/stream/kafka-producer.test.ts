import { afterEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { KafkaError } from '../../src/kafka/errors.js';
import { KafkaProducer, type OutgoingRecord } from '../../src/kafka/producer.js';
import { stampedGroups } from './support/kafka-stamps.js';
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
let extraBrokers: FakeKafkaBroker[] = [];
let producer: KafkaProducer | undefined;

afterEach(async () => {
  if (producer !== undefined) await producer.close();
  if (broker !== undefined) await broker.close();
  await Promise.all(extraBrokers.map((b) => b.close()));
  producer = undefined;
  broker = undefined;
  extraBrokers = [];
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

  it('zstd-compresses the record batch when configured', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      compression: 'zstd',
    });
    const event = LogEvent.fromMessage('x');
    await producer.send([outgoing('events', { value: Buffer.from('compress-me'), event })]);
    expect(broker.receivedBatches[0]!.decoded.compression).toBe('zstd');
    expect(broker.receivedBatches[0]!.decoded.records[0]?.value?.toString('utf8')).toBe(
      'compress-me',
    );
  });

  it('acks=0 finishes events as delivered without waiting for a broker response', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      acks: 0,
      idempotent: false,
    });
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

describe('KafkaProducer: idempotence', () => {
  it('stamps each batch with the broker-issued producer id and advancing per-partition sequences', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 2 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      partitioner: 'round_robin',
    });

    // Two batches of three unkeyed records each: round-robin gives partitions 0,1,0 then 1,0,1.
    const first = producer.prepare([outgoing('events'), outgoing('events'), outgoing('events')]);
    await producer.send(first);
    const second = producer.prepare([outgoing('events'), outgoing('events'), outgoing('events')]);
    await producer.send(second);

    expect(broker.issuedProducerIds).toHaveLength(1);
    const pid = broker.issuedProducerIds[0]!;
    expect(producer.producerIdentity).toEqual({ id: pid, epoch: 0 });

    const stamps = [...stampedGroups(first), ...stampedGroups(second)].map((g) => [
      g.partition,
      g.baseSequence,
      g.recordCount,
    ]);
    expect(stamps.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)).toEqual([
      [0, 0, 2],
      [0, 2, 1],
      [1, 0, 1],
      [1, 1, 2],
    ]);
    for (const b of broker.appendedBatches) {
      expect(b.decoded.producerId).toBe(pid);
      expect(b.decoded.producerEpoch).toBe(0);
    }
    expect(broker.appendedBatches).toHaveLength(4);
  });

  it('sends batches with no producer id when idempotence is off', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: false,
    });
    await producer.send([outgoing('events')]);
    expect(broker.issuedProducerIds).toHaveLength(0);
    expect(broker.appendedBatches[0]!.decoded.producerId).toBe(-1n);
    expect(broker.appendedBatches[0]!.decoded.baseSequence).toBe(-1);
  });

  it.each([
    ['acknowledged with error code 0', false],
    ['reported as DUPLICATE_SEQUENCE_NUMBER', true],
  ])(
    'a batch whose response was lost is resent byte-for-byte and %s, not appended twice',
    async (_label, duplicatesAsError) => {
      let dropsLeft = 1;
      broker = new FakeKafkaBroker({
        partitionCounts: { events: 1 },
        duplicatesAsError,
        onProduce: () => {
          if (dropsLeft > 0) {
            dropsLeft--;
            return { errorCode: 0, dropConnection: true };
          }
          return { errorCode: 0 };
        },
      });
      const port = await broker.listen();
      producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

      const event = LogEvent.fromMessage('once');
      const completion = withFinalizer(event);
      const batch = producer.prepare([outgoing('events', { event })]);
      await expect(producer.send(batch)).rejects.toThrow(KafkaError);
      expect(batch.pending).toHaveLength(1);
      expect(broker.appendedBatches).toHaveLength(1); // the broker did append it

      await producer.send(batch);
      await expect(completion).resolves.toBe('delivered');
      expect(broker.receivedBatches).toHaveLength(2);
      expect(broker.appendedBatches).toHaveLength(1);
      const [a, b] = broker.receivedBatches;
      expect(b!.decoded.producerId).toBe(a!.decoded.producerId);
      expect(b!.decoded.baseSequence).toBe(a!.decoded.baseSequence);
      expect(b!.decoded.crc).toBe(a!.decoded.crc);
    },
  );

  it('after a batch is abandoned, the next batch recovers from the out-of-order sequence under a new producer id in one send', async () => {
    let failuresLeft = 1;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      onProduce: () => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return { errorCode: 7 }; // REQUEST_TIMED_OUT: retryable, nothing appended
        }
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });

    // The caller gives up on this batch (as the sink does once retries are exhausted): the
    // broker never saw its sequence 0.
    await expect(producer.send([outgoing('events')])).rejects.toThrow(KafkaError);
    const firstPid = producer.producerIdentity!.id;

    const event = LogEvent.fromMessage('next');
    const completion = withFinalizer(event);
    const next = producer.prepare([outgoing('events', { event })]);
    await producer.send(next);
    await expect(completion).resolves.toBe('delivered');

    // Sequence 1 under the old id was refused (OUT_OF_ORDER_SEQUENCE_NUMBER), then the group was
    // re-stamped with a fresh id at sequence 0 and accepted, all inside one send().
    expect(broker.issuedProducerIds).toHaveLength(2);
    expect(producer.producerIdentity!.id).not.toBe(firstPid);
    const codes = broker.receivedBatches.map((b) => [b.decoded.producerId, b.decoded.baseSequence]);
    expect(codes).toEqual([
      [firstPid, 0],
      [firstPid, 1],
      [producer.producerIdentity!.id, 0],
    ]);
    expect(broker.appendedBatches).toHaveLength(1);
    expect(stampedGroups(next)[0]!.baseSequence).toBe(0);
  });

  it('a partial failure plus a lost response on the retry still appends every record exactly once', async () => {
    // Round 1: partition 0 accepted, partition 1 refused (retryable). Round 2 (partition 1 only):
    // appended, but the connection drops before the response. Round 3: recognised as a duplicate.
    let round = 0;
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 2 },
      onProduce: ({ partition }) => {
        if (round === 0 && partition === 1) return { errorCode: 6 };
        if (round === 1) return { errorCode: 0, dropConnection: true };
        return { errorCode: 0 };
      },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      partitioner: 'round_robin',
    });
    const events = Array.from({ length: 6 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const completions = events.map(withFinalizer);
    const batch = producer.prepare(
      events.map((event, i) => outgoing('events', { value: Buffer.from(`v${i}`), event })),
    );

    await expect(producer.send(batch)).rejects.toThrow(KafkaError);
    round = 1;
    await expect(producer.send(batch)).rejects.toThrow();
    round = 2;
    await producer.send(batch);

    await expect(Promise.all(completions)).resolves.toEqual(Array(6).fill('delivered'));
    const appended = broker.appendedBatches.flatMap((b) =>
      b.decoded.records.map((r) => r.value!.toString('utf8')),
    );
    expect(appended.sort()).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  });

  it('rejects acks other than -1 when idempotent', () => {
    const bootstrapBrokers = [{ host: '127.0.0.1', port: 1 }];
    expect(() => new KafkaProducer({ bootstrapBrokers, acks: 0 })).toThrow(/acks=-1/);
    expect(() => new KafkaProducer({ bootstrapBrokers, acks: 1 })).toThrow(/acks=-1/);
    expect(() => new KafkaProducer({ bootstrapBrokers, acks: 1, idempotent: false })).not.toThrow();
  });

  it('surfaces a permanent InitProducerId error without finishing the events', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      initProducerIdError: 31, // CLUSTER_AUTHORIZATION_FAILED
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
    expect((caught as KafkaError).errorCode).toBe(31);
    expect((caught as KafkaError).isRetryable).toBe(false);
    expect(broker.receivedBatches).toHaveLength(0);
    const raced = await Promise.race([
      completion.then(() => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(raced).toBe('pending');
  });
});

describe('KafkaProducer: idempotence across brokers', () => {
  it('stamps every group of a round under the identity the round started with, even when another leader resets it mid-round', async () => {
    // Partition 0 is led by broker A, partition 1 by broker B. A answers at once and refuses
    // partition 0 with OUT_OF_ORDER_SEQUENCE_NUMBER, which clears the producer identity. B is
    // slow and needs SASL, so the client is still connecting to it when A's response lands. The
    // group bound for B must already carry the original producer id, not go out unstamped.
    const sasl = { mechanism: 'PLAIN', username: 'alice', password: 'secret' } as const;
    let refusalsLeft = 1;
    broker = new FakeKafkaBroker({
      nodeId: 1,
      partitionCounts: { events: 2 },
      partitionLeaders: { events: [1, 2] },
      firstProducerId: 1000n,
      sasl,
      onProduce: ({ partition }) => {
        if (partition === 0 && refusalsLeft > 0) {
          refusalsLeft--;
          return { errorCode: 45 };
        }
        return { errorCode: 0 };
      },
    });
    const slow = new FakeKafkaBroker({
      nodeId: 2,
      partitionCounts: { events: 2 },
      partitionLeaders: { events: [1, 2] },
      firstProducerId: 2000n,
      sasl,
      responseDelayMs: 150,
    });
    extraBrokers.push(slow);
    const [portA, portB] = await Promise.all([broker.listen(), slow.listen()]);
    broker.peers = [{ nodeId: 2, port: portB }];
    slow.peers = [{ nodeId: 1, port: portA }];

    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port: portA }],
      sasl,
      partitioner: 'round_robin',
    });
    const events = [LogEvent.fromMessage('to-A'), LogEvent.fromMessage('to-B')];
    const completions = events.map(withFinalizer);
    const batch = producer.prepare(
      events.map((event, i) => outgoing('events', { value: Buffer.from(`v${i}`), event })),
    );
    await producer.send(batch);
    await expect(Promise.all(completions)).resolves.toEqual(['delivered', 'delivered']);

    // B saw exactly one batch, stamped with the first producer id, while A's partition was
    // re-stamped under the second id and accepted inline.
    expect(slow.receivedBatches).toHaveLength(1);
    expect(slow.receivedBatches[0]!.decoded.producerId).toBe(1000n);
    expect(slow.receivedBatches[0]!.decoded.baseSequence).toBe(0);
    expect(broker.issuedProducerIds).toEqual([1000n, 1001n]);
    expect(broker.appendedBatches.map((b) => [b.partition, b.decoded.producerId])).toEqual([
      [0, 1001n],
    ]);
    const appended = [...broker.appendedBatches, ...slow.appendedBatches].flatMap((b) =>
      b.decoded.records.map((r) => r.value!.toString('utf8')),
    );
    expect(appended.sort()).toEqual(['v0', 'v1']);
  }, 10_000);
});

describe('KafkaProducer: healthcheck with idempotence', () => {
  it('obtains a producer id during healthcheck, so a refused InitProducerId fails the check', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { events: 1 },
      initProducerIdError: 31, // CLUSTER_AUTHORIZATION_FAILED
    });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    let caught: unknown;
    try {
      await producer.healthcheck();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KafkaError);
    expect((caught as KafkaError).errorCode).toBe(31);
  });

  it('healthcheck acquires an id when idempotent and none when not', async () => {
    broker = new FakeKafkaBroker({ partitionCounts: { events: 1 } });
    const port = await broker.listen();
    producer = new KafkaProducer({ bootstrapBrokers: [{ host: '127.0.0.1', port }] });
    await producer.healthcheck();
    expect(broker.issuedProducerIds).toHaveLength(1);
    expect(producer.producerIdentity?.id).toBe(broker.issuedProducerIds[0]);
    await producer.close();

    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      idempotent: false,
    });
    await producer.healthcheck();
    expect(broker.issuedProducerIds).toHaveLength(1);
  });
});
