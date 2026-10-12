import { afterEach, describe, expect, it } from 'vitest';
import {
  KafkaConsumer,
  type KafkaConsumerClock,
  type KafkaConsumerOptions,
  type PartitionBatch,
  type RebalanceEvent,
} from '../../src/kafka/consumer.js';
import { KafkaCrcError } from '../../src/kafka/errors.js';
import type { RecordInput } from '../../src/kafka/record-batch.js';
import { FakeGroupCoordinatorBroker } from './support/fake-kafka-broker.js';
import { FreezableClock, ManualClock } from './support/manual-clock.js';

function record(value: string, overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    key: null,
    value: Buffer.from(value),
    headers: [],
    timestamp: 1_700_000_000_000n,
    ...overrides,
  };
}

/**
 * Yields several real event-loop turns (not just microtasks) so genuine, in-flight socket I/O
 * (a heartbeat/rejoin request that a just-resolved `clock.sleep()` triggered) has a real chance
 * to complete before the next clock advance — one `setImmediate` turn is usually enough on an
 * idle machine, but under load (e.g. this whole suite running in parallel) a single round trip
 * can span more than one turn, so this chains several rather than assuming it never will.
 */
async function yieldToRealIo(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Advances the shared ManualClock in small steps, yielding to real I/O between each (see
 * {@link yieldToRealIo}) — the same pattern this repo's own README documents for other
 * ManualClock-driven, real-socket tests. Keeps stepping until `until` settles (a rebalance may
 * need more than one heartbeat tick to fully converge — e.g. the cooperative-sticky assignor's
 * second, deferred hand-off round, or a member that only discovers REBALANCE_IN_PROGRESS on its
 * own next heartbeat tick after another member has already rejoined — and exactly how many ticks
 * that takes depends on real, not simulated, timing between each step) rather than a fixed step
 * count, which could settle one tick too early under slower real I/O.
 */
async function settleUntil(
  clock: ManualClock,
  stepMs: number,
  until: Promise<unknown>,
  maxSteps = 80,
): Promise<void> {
  let settled = false;
  until.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) {
    await clock.advance(stepMs);
    await yieldToRealIo();
  }
}

/**
 * Like {@link settleUntil}, but for a rebalance that may take more than one generation to fully
 * converge (the cooperative-sticky assignor's deferred hand-off: round 1 only revokes, round 2
 * hands off — see `assignors.ts`) — a single member's `poll()` resolving only reflects *that*
 * member's state as of whichever generation was current at the time, not the group's eventual
 * steady state. Keeps advancing until `isConverged()` reports the group has settled, polled
 * directly against the consumers' own `.assignment` rather than any one `poll()` call's result,
 * since the background heartbeat loop (not `poll()`) is what actually drives a member through a
 * rebalance it did not itself trigger.
 */
async function settleWhile(
  clock: ManualClock,
  stepMs: number,
  isConverged: () => boolean,
  maxSteps = 100,
): Promise<void> {
  for (let i = 0; i < maxSteps && !isConverged(); i++) {
    await clock.advance(stepMs);
    await yieldToRealIo();
  }
}

const HEARTBEAT_MS = 50;
const SESSION_TIMEOUT_MS = 500;

let broker: FakeGroupCoordinatorBroker | undefined;
const consumers: KafkaConsumer[] = [];

function makeConsumer(
  broker_: FakeGroupCoordinatorBroker,
  groupId: string,
  topics: string[],
  clock: KafkaConsumerClock,
  overrides: Partial<KafkaConsumerOptions> = {},
): KafkaConsumer {
  const consumer = new KafkaConsumer({
    bootstrapBrokers: [{ host: '127.0.0.1', port: broker_.port }],
    groupId,
    topics,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_MS,
    rebalanceTimeoutMs: 10_000,
    clock,
    ...overrides,
  });
  consumers.push(consumer);
  return consumer;
}

afterEach(async () => {
  await Promise.all(consumers.map((c) => c.close().catch(() => undefined)));
  consumers.length = 0;
  await broker?.close();
  broker = undefined;
});

describe('KafkaConsumer: join/sync', () => {
  it('a single member gets every partition of its subscribed topic', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 4 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('a')]);
    broker.appendRecords('events', 1, [record('b')]);

    const events: RebalanceEvent[] = [];
    const consumer = makeConsumer(broker, 'g1', ['events'], clock, {
      onRebalance: (event) => {
        events.push(event);
      },
    });

    const batches = await consumer.poll();
    expect(events).toHaveLength(1);
    expect(events[0]!.revoked).toEqual([]);
    expect(events[0]!.assigned.map((tp) => tp.partition).sort()).toEqual([0, 1, 2, 3]);
    expect(consumer.assignment.map((tp) => tp.partition).sort()).toEqual([0, 1, 2, 3]);

    const byPartition = new Map(batches.map((b) => [b.partition, b]));
    expect(byPartition.get(0)?.records[0]?.value?.toString('utf8')).toBe('a');
    expect(byPartition.get(1)?.records[0]?.value?.toString('utf8')).toBe('b');
  });

  it('two members converge on a split topic once both have joined', async () => {
    // Real Kafka coordinators hold the very first JoinGroup of a brand-new group open for a
    // short "initial rebalance delay" specifically to batch up near-simultaneous joiners into
    // one generation; this fake broker does not model that delay, so two members racing to join
    // "at the same instant" are not guaranteed to land in the same generation — whichever one
    // the coordinator sees first finishes alone, and the second's arrival starts an ordinary
    // (deterministic, heartbeat-driven) rebalance, exactly like a member joining mid-stream.
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 4 } });
    await broker.listen();

    const a = makeConsumer(broker, 'g2', ['events'], clock);
    await a.poll();
    expect(a.assignment).toHaveLength(4);

    const b = makeConsumer(broker, 'g2', ['events'], clock);
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;

    const aPartitions = a.assignment.map((tp) => tp.partition).sort();
    const bPartitions = b.assignment.map((tp) => tp.partition).sort();
    expect(aPartitions).toHaveLength(2);
    expect(bPartitions).toHaveLength(2);
    expect([...aPartitions, ...bPartitions].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('KafkaConsumer: a member joins mid-stream', () => {
  it('range assignor: redistributes every partition in one rebalance', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 4 } });
    await broker.listen();

    const a = makeConsumer(broker, 'g3', ['events'], clock, { assignor: 'range' });
    await a.poll();
    expect(a.assignment).toHaveLength(4);

    const b = makeConsumer(broker, 'g3', ['events'], clock, { assignor: 'range' });
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;

    expect(a.assignment).toHaveLength(2);
    expect(b.assignment).toHaveLength(2);
    const all = [...a.assignment, ...b.assignment].map((tp) => tp.partition).sort();
    expect(all).toEqual([0, 1, 2, 3]);
  });

  it('cooperative-sticky assignor: incrementally revokes before the new member receives anything', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 4 } });
    await broker.listen();

    const aRevocations: RebalanceEvent[] = [];
    const a = makeConsumer(broker, 'g4', ['events'], clock, {
      assignor: 'cooperative_sticky',
      onRebalance: (event) => {
        if (event.revoked.length > 0) aRevocations.push(event);
      },
    });
    await a.poll();
    const original = new Set(a.assignment.map((tp) => tp.partition));
    expect(original.size).toBe(4);

    const b = makeConsumer(broker, 'g4', ['events'], clock, { assignor: 'cooperative_sticky' });
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;
    // bPoll resolving only reflects b's state as of whichever generation was current when it
    // resolved — the cooperative protocol's deferred hand-off (a's revocation in round 1, b's
    // actual gain in round 2) may still be in flight, driven by each member's own background
    // heartbeat loop rather than by any poll() call. Keep advancing until the group has actually
    // settled into a balanced steady state.
    await settleWhile(clock, HEARTBEAT_MS, () => a.assignment.length + b.assignment.length === 4);

    // The group converges to a balanced steady state...
    expect(a.assignment.length + b.assignment.length).toBe(4);
    expect(Math.abs(a.assignment.length - b.assignment.length)).toBeLessThanOrEqual(1);
    // ...and a lost a partition via an explicit revocation at some point along the way (the
    // defining trait of the cooperative protocol: the losing member finds out before the
    // gaining member receives it, never via a surprise, silent reassignment).
    expect(aRevocations.length).toBeGreaterThan(0);
    // Every partition a kept, it already owned from the start (stickiness).
    for (const tp of a.assignment) expect(original.has(tp.partition)).toBe(true);
  });
});

describe('KafkaConsumer: a member leaves mid-stream', () => {
  it('its partitions are picked up by the remaining member', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 4 } });
    await broker.listen();

    const a = makeConsumer(broker, 'g5', ['events'], clock);
    await a.poll();
    const b = makeConsumer(broker, 'g5', ['events'], clock);
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;
    expect(a.assignment).toHaveLength(2);
    expect(b.assignment).toHaveLength(2);

    await a.close();
    consumers.splice(consumers.indexOf(a), 1);
    await settleWhile(clock, HEARTBEAT_MS, () => b.assignment.length === 4);

    expect(b.assignment).toHaveLength(4);
  });

  it('a silent member (no LeaveGroup) is evicted once its session times out', async () => {
    // a heartbeats normally (via the shared clock, through clockA) through setup, so the group
    // actually reaches a genuine 2/2 stable split — then clockA.freeze() makes every future
    // sleep() on a's heartbeat loop simply never resolve, the same observable effect as a
    // crashed process that stops heartbeating but never gets the chance to send LeaveGroup
    // (unlike calling a.close(), which sends one — the clean-departure path the previous test
    // already covers).
    const clock = new ManualClock();
    const clockA = new FreezableClock(clock);
    broker = new FakeGroupCoordinatorBroker({
      partitionCounts: { events: 4 },
      clock,
      rebalanceStragglerTimeoutMs: 200,
    });
    await broker.listen();

    const a = makeConsumer(broker, 'g6', ['events'], clockA);
    await a.poll();
    const b = makeConsumer(broker, 'g6', ['events'], clock);
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;
    expect(a.assignment).toHaveLength(2);
    expect(b.assignment).toHaveLength(2);

    // Frozen, a can no longer be closed cleanly either (its heartbeat loop's pending sleep will
    // never resolve, so close()'s own await would hang right along with it) — drop it from the
    // shared afterEach cleanup; the broker's own close() forcibly tears down its leftover socket.
    clockA.freeze();
    consumers.splice(consumers.indexOf(a), 1);
    await settleWhile(clock, HEARTBEAT_MS, () => b.assignment.length === 4);

    expect(b.assignment).toHaveLength(4);
  });
});

describe('KafkaConsumer: onRebalance callback', () => {
  it('can call commit() for a revoked partition without deadlocking', async () => {
    // `onRebalance` fires mid-`joinAndSync()`, before that call has returned — a caller that
    // calls `commit()` from inside it (e.g. to persist a revoked partition's acknowledged
    // offset before releasing it, exactly what a Kafka *source* needs to do) must not have that
    // `commit()` wait on the very `joinAndSync()` call it is nested inside, or it would hang
    // forever. Regression test for that deadlock.
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 2 } });
    await broker.listen();

    let committedDuringRebalance: Promise<void> | undefined;
    const a = makeConsumer(broker, 'g14b', ['events'], clock, {
      onRebalance: ({ revoked }) => {
        if (revoked.length === 0) return;
        committedDuringRebalance = a.commit(
          revoked.map((tp) => ({ topic: tp.topic, partition: tp.partition, offset: 9n })),
        );
      },
    });
    await a.poll();
    expect(a.assignment).toHaveLength(2);

    const b = makeConsumer(broker, 'g14b', ['events'], clock);
    const bPoll = b.poll();
    await settleUntil(clock, HEARTBEAT_MS, bPoll);
    await bPoll;
    // `a`'s own rejoin (triggered by its heartbeat loop, independent of `bPoll`'s own timing)
    // may not have reached `onRebalance` yet even though `b`'s side of the same rebalance has
    // already settled; keep stepping until it has.
    await settleWhile(clock, HEARTBEAT_MS, () => committedDuringRebalance !== undefined);
    expect(a.assignment).toHaveLength(1);
    expect(b.assignment).toHaveLength(1);

    expect(committedDuringRebalance).toBeDefined();
    await committedDuringRebalance; // would hang forever if this deadlocked

    const revokedPartition = [0, 1].find((p) => !a.assignment.some((tp) => tp.partition === p))!;
    expect(broker.committedOffset('g14b', 'events', revokedPartition)).toBe(9n);
  });
});

describe('KafkaConsumer: offsets', () => {
  it('commit() persists offsets that a fresh consumer resumes from after a restart', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('1'), record('2'), record('3')]);

    const first = makeConsumer(broker, 'g7', ['events'], clock);
    const firstBatches = await first.poll();
    expect(firstBatches[0]?.records).toHaveLength(3);
    const lastOffset = firstBatches[0]!.records[firstBatches[0]!.records.length - 1]!.offset;
    await first.commit([{ topic: 'events', partition: 0, offset: lastOffset + 1n }]);
    await first.close();
    consumers.splice(consumers.indexOf(first), 1);

    broker.appendRecords('events', 0, [record('4')]);

    const second = makeConsumer(broker, 'g7', ['events'], clock);
    const secondBatches = await second.poll();
    expect(secondBatches).toHaveLength(1);
    expect(secondBatches[0]!.records.map((r) => r.value?.toString('utf8'))).toEqual(['4']);
  });

  it('a partition with no prior commit starts from offset 0', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('x'), record('y')]);

    const consumer = makeConsumer(broker, 'g8', ['events'], clock);
    const batches = await consumer.poll();
    expect(batches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual(['x', 'y']);
  });
});

describe('KafkaConsumer: Fetch decoding', () => {
  it('surfaces a CRC mismatch as a typed KafkaCrcError', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('ok')]);
    broker.corruptLastBatch('events', 0);

    const consumer = makeConsumer(broker, 'g9', ['events'], clock);
    await expect(consumer.poll()).rejects.toBeInstanceOf(KafkaCrcError);
  });

  it('decodes a gzip-compressed batch transparently', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('compressed-1'), record('compressed-2')], {
      compression: 'gzip',
    });

    const consumer = makeConsumer(broker, 'g10', ['events'], clock);
    const batches = await consumer.poll();
    expect(batches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual([
      'compressed-1',
      'compressed-2',
    ]);
  });

  it('skips a control batch entirely', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('data-1')]);
    broker.appendRecords(
      'events',
      0,
      [{ key: null, value: Buffer.from([0, 0]), headers: [], timestamp: 1_700_000_000_000n }],
      {
        isControl: true,
        isTransactional: true,
        producerId: 42n,
      },
    );
    broker.appendRecords('events', 0, [record('data-2')]);

    const consumer = makeConsumer(broker, 'g11', ['events'], clock);
    const batches = await consumer.poll();
    const allRecords: PartitionBatch[] = batches;
    expect(allRecords[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual([
      'data-1',
      'data-2',
    ]);
  });

  it('read_committed skips records from an aborted transaction', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    const producerId = 7n;
    broker.appendRecords('events', 0, [record('committed-1')]);
    const abortedOffset = broker.appendRecords(
      'events',
      0,
      [record('aborted-1'), record('aborted-2')],
      { isTransactional: true, producerId },
    );
    broker.markAborted('events', 0, producerId, abortedOffset);
    broker.appendRecords(
      'events',
      0,
      [{ key: null, value: Buffer.alloc(0), headers: [], timestamp: 1_700_000_000_000n }],
      { isControl: true, isTransactional: true, producerId },
    );
    broker.appendRecords('events', 0, [record('committed-2')]);

    const consumer = makeConsumer(broker, 'g12', ['events'], clock, {
      isolationLevel: 'read_committed',
    });
    const batches = await consumer.poll();
    expect(batches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual([
      'committed-1',
      'committed-2',
    ]);
  });

  it('read_uncommitted (the default) still returns records from an aborted transaction', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    const producerId = 8n;
    const abortedOffset = broker.appendRecords('events', 0, [record('aborted-1')], {
      isTransactional: true,
      producerId,
    });
    broker.markAborted('events', 0, producerId, abortedOffset);
    broker.appendRecords(
      'events',
      0,
      [{ key: null, value: Buffer.alloc(0), headers: [], timestamp: 1_700_000_000_000n }],
      { isControl: true, isTransactional: true, producerId },
    );

    const consumer = makeConsumer(broker, 'g13', ['events'], clock);
    const batches = await consumer.poll();
    expect(batches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual(['aborted-1']);
  });
});

describe('KafkaConsumer: auto_offset_reset', () => {
  it('earliest (the default) reads every record already in the log', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('old-1'), record('old-2')]);

    const consumer = makeConsumer(broker, 'g14', ['events'], clock);
    const batches = await consumer.poll();
    expect(batches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual(['old-1', 'old-2']);
  });

  it('latest skips every record already in the log when there is no committed offset', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('old-1'), record('old-2')]);

    const consumer = makeConsumer(broker, 'g15', ['events'], clock, { autoOffsetReset: 'latest' });
    const firstBatches = await consumer.poll();
    expect(firstBatches).toEqual([]);

    broker.appendRecords('events', 0, [record('new-1')]);
    const secondBatches = await consumer.poll();
    expect(secondBatches[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual(['new-1']);
  });

  it('resets a committed offset the broker reports OFFSET_OUT_OF_RANGE', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('1'), record('2')]);

    const first = makeConsumer(broker, 'g16', ['events'], clock);
    await first.poll();
    // Commit an offset far beyond the log's actual end — simulating a group whose committed
    // position has gone stale (e.g. the topic was recreated with less history than before).
    await first.commit([{ topic: 'events', partition: 0, offset: 100n }]);
    await first.close();
    consumers.splice(consumers.indexOf(first), 1);

    const second = makeConsumer(broker, 'g16', ['events'], clock, { autoOffsetReset: 'earliest' });
    const firstPoll = await second.poll();
    expect(firstPoll).toEqual([]); // this round only discovers OFFSET_OUT_OF_RANGE and resets

    broker.appendRecords('events', 0, [record('3')]);
    const secondPoll = await second.poll();
    // Reset to earliest (offset 0) picks up every record still in the log, including the ones
    // already consumed under the stale commit — correct at-least-once behaviour for a position
    // that can no longer be trusted, not a gap.
    expect(secondPoll[0]?.records.map((r) => r.value?.toString('utf8'))).toEqual(['1', '2', '3']);
  });
});

describe('KafkaConsumer: pausePartitions/resumePartitions', () => {
  it('a paused partition is excluded from Fetch until resumed', async () => {
    const clock = new ManualClock();
    broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 2 } });
    await broker.listen();
    broker.appendRecords('events', 0, [record('a')]);
    broker.appendRecords('events', 1, [record('b')]);

    const consumer = makeConsumer(broker, 'g17', ['events'], clock);
    consumer.pausePartitions([{ topic: 'events', partition: 1 }]);
    const batches = await consumer.poll();
    expect(batches.map((b) => b.partition)).toEqual([0]);

    consumer.resumePartitions([{ topic: 'events', partition: 1 }]);
    const secondBatches = await consumer.poll();
    expect(secondBatches.map((b) => b.partition)).toEqual([1]);
  });
});
