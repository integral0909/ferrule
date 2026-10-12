import { afterEach, describe, expect, it } from 'vitest';
import { isLogEvent, type DeliveryStatus, type Event } from '@ferrule/core';
import { createCapturingLogger, ManualClock, type BuildContext } from '@ferrule/runtime';
import { kafkaSource, type KafkaSourceHandle } from '../src/kafka.js';
import {
  createControllableSourceContext,
  type ControllableSourceContextOptions,
} from './support/context.js';
import { FakeGroupCoordinatorBroker, type FakeBrokerClock } from './support/fake-kafka-broker.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

/** Adapts a `@ferrule/runtime` `ManualClock` to the fake broker's own minimal clock shape, so one
 * `clock.advance()` call moves the broker's session-timeout bookkeeping and a source's
 * `KafkaConsumer` heartbeats in lockstep. */
function brokerClock(clock: ManualClock): FakeBrokerClock {
  return { now: () => clock.monotonic(), sleep: (ms) => clock.sleep(ms) };
}

interface Started {
  readonly handle: KafkaSourceHandle;
  readonly harness: ReturnType<typeof createControllableSourceContext>;
  readonly runPromise: Promise<void>;
}

const started: Started[] = [];
const brokers: FakeGroupCoordinatorBroker[] = [];

async function startKafkaSource(
  broker: FakeGroupCoordinatorBroker,
  rawOptions: Record<string, unknown>,
  harnessOptions: ControllableSourceContextOptions = {},
): Promise<Started> {
  const parsed = kafkaSource.options.parse({
    brokers: [`127.0.0.1:${broker.port}`],
    ...rawOptions,
  });
  const handle = (await kafkaSource.build(parsed, buildCtx())) as KafkaSourceHandle;
  const harness = createControllableSourceContext(harnessOptions);
  const runPromise = handle.run(harness.ctx);
  const entry = { handle, harness, runPromise };
  started.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { harness, runPromise } of started.splice(0)) {
    harness.abort();
    await runPromise.catch(() => undefined);
  }
  for (const broker of brokers.splice(0)) await broker.close();
});

async function yieldToRealIo(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Polls `condition` against real wall-clock time (not event-loop turns), since this source talks
 * to the fake broker over a real TCP socket. */
async function waitUntilReal(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('waitUntilReal: condition never became true');
}

/** Waits for a new batch (beyond `fromIndex`) to arrive and returns its events, without
 * acknowledging them — the caller decides the outcome. */
async function waitForNextBatch(
  harness: ReturnType<typeof createControllableSourceContext>,
  fromIndex: number,
  timeoutMs = 4000,
): Promise<Event[]> {
  await waitUntilReal(() => harness.sent.length > fromIndex, timeoutMs);
  return harness.sent[harness.sent.length - 1]!.events;
}

function ack(events: readonly Event[], status: DeliveryStatus = 'delivered'): void {
  for (const event of events) event.metadata.finalizers.finish(status);
}

async function waitForCommittedOffset(
  broker: FakeGroupCoordinatorBroker,
  groupId: string,
  topic: string,
  partition: number,
  expected: bigint,
  timeoutMs = 4000,
): Promise<void> {
  await waitUntilReal(
    () => broker.committedOffset(groupId, topic, partition) === expected,
    timeoutMs,
  );
}

/** Advances `clock` in `stepMs` increments, yielding to real socket I/O between each step, until
 * `condition` holds — the pattern `@ferrule/codecs`'s own `KafkaConsumer` tests use for a
 * multi-round-trip convergence (here: a rebalance, which a member only notices on its own next
 * heartbeat tick). */
async function settleUntil(
  clock: ManualClock,
  stepMs: number,
  condition: () => boolean,
  maxSteps = 100,
): Promise<void> {
  for (let i = 0; i < maxSteps && !condition(); i++) {
    await clock.advance(stepMs);
    await yieldToRealIo();
  }
  if (!condition()) throw new Error('settleUntil: condition never became true');
}

function messages(events: readonly Event[]): string[] {
  return events.filter(isLogEvent).map((e) => e.get('message') as string);
}

function partitionOfBatch(events: readonly Event[]): number {
  const [first] = events;
  if (first === undefined || !isLogEvent(first)) {
    throw new Error('partitionOfBatch: no log event to inspect');
  }
  return first.get('kafka.partition') as number;
}

describe('kafka source: acknowledgement-driven offset commits', () => {
  it('delivered and rejected outcomes advance the committed offset; an errored one blocks it', async () => {
    const broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    brokers.push(broker);
    await broker.listen();

    const { harness } = await startKafkaSource(broker, {
      group_id: 'g1',
      topics: ['events'],
      decoding: { codec: 'text' },
      auto_offset_reset: 'earliest',
    });

    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('0'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    const batch0 = await waitForNextBatch(harness, 0);
    expect(messages(batch0)).toEqual(['0']);
    ack(batch0, 'delivered');
    await waitForCommittedOffset(broker, 'g1', 'events', 0, 1n);

    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('1'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    const batch1 = await waitForNextBatch(harness, 1);
    expect(messages(batch1)).toEqual(['1']);
    ack(batch1, 'rejected');
    await waitForCommittedOffset(broker, 'g1', 'events', 0, 2n);

    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('2'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    const batch2 = await waitForNextBatch(harness, 2);
    expect(messages(batch2)).toEqual(['2']);
    ack(batch2, 'errored');

    // An errored batch permanently blocks this partition's committed offset from advancing past
    // it for the rest of this run (matching the `file` source's own at-least-once contract) —
    // give the source's loop plenty of real turns to prove it does *not* move to 3n.
    await yieldToRealIo(20);
    expect(broker.committedOffset('g1', 'events', 0)).toBe(2n);

    // Every event this source ever annotated carries the right metadata fields, regardless of
    // how its batch's acknowledgement later resolved.
    const [event0] = batch0 as [Event];
    expect(isLogEvent(event0) && event0.get('kafka.topic')).toBe('events');
    expect(isLogEvent(event0) && event0.get('kafka.partition')).toBe(0);
    expect(isLogEvent(event0) && event0.get('kafka.offset')).toBe(0n);
  });

  it('acknowledgements off: commits as records are sent downstream', async () => {
    const broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    brokers.push(broker);
    await broker.listen();
    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('a'), headers: [], timestamp: 1_700_000_000_000n },
      { key: null, value: Buffer.from('b'), headers: [], timestamp: 1_700_000_000_000n },
    ]);

    const { harness } = await startKafkaSource(
      broker,
      {
        group_id: 'g2',
        topics: ['events'],
        decoding: { codec: 'text' },
        auto_offset_reset: 'earliest',
      },
      { acknowledgements: false },
    );

    await waitForNextBatch(harness, 0);
    await waitForCommittedOffset(broker, 'g2', 'events', 0, 2n);
  });
});

describe('kafka source: backpressure', () => {
  it('pauses fetching a partition once its outstanding batches reach the limit', async () => {
    const broker = new FakeGroupCoordinatorBroker({ partitionCounts: { events: 1 } });
    brokers.push(broker);
    await broker.listen();

    const { harness } = await startKafkaSource(broker, {
      group_id: 'g3',
      topics: ['events'],
      decoding: { codec: 'text' },
      auto_offset_reset: 'earliest',
      max_outstanding_batches: 1,
    });

    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('first'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    const batch0 = await waitForNextBatch(harness, 0);

    // The one outstanding batch allowed is still unacknowledged: a second record appended now
    // must not be fetched while this partition is paused.
    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('second'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    await yieldToRealIo(20);
    expect(harness.sent).toHaveLength(1);

    ack(batch0, 'delivered');
    const batch1 = await waitForNextBatch(harness, 1);
    expect(messages(batch1)).toEqual(['second']);
  });
});

describe('kafka source: topic_pattern', () => {
  it('resolves against the cluster’s topic list at startup', async () => {
    const broker = new FakeGroupCoordinatorBroker({
      partitionCounts: { 'events-a': 1, 'events-b': 1, other: 1 },
    });
    brokers.push(broker);
    await broker.listen();
    broker.appendRecords('events-a', 0, [
      { key: null, value: Buffer.from('a'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    broker.appendRecords('events-b', 0, [
      { key: null, value: Buffer.from('b'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    broker.appendRecords('other', 0, [
      { key: null, value: Buffer.from('nope'), headers: [], timestamp: 1_700_000_000_000n },
    ]);

    const { handle, harness } = await startKafkaSource(broker, {
      group_id: 'g4',
      topic_pattern: '^events-.*$',
      decoding: { codec: 'text' },
      auto_offset_reset: 'earliest',
    });

    await waitUntilReal(() => handle.assignment().length === 2);
    expect(new Set(handle.assignment().map((tp) => tp.topic))).toEqual(
      new Set(['events-a', 'events-b']),
    );

    await waitUntilReal(() => harness.sent.flatMap((b) => messages(b.events)).length === 2);
    const received = new Set(harness.sent.flatMap((b) => messages(b.events)));
    expect(received).toEqual(new Set(['a', 'b']));
  });
});

describe('kafka source: rebalance', () => {
  it('commits a revoked partition’s acknowledged prefix before releasing it', async () => {
    const clock = new ManualClock();
    const broker = new FakeGroupCoordinatorBroker({
      partitionCounts: { events: 2 },
      clock: brokerClock(clock),
      rebalanceStragglerTimeoutMs: 100,
    });
    brokers.push(broker);
    await broker.listen();
    // Both partitions already have data, so the sole initial member starts owning both.
    broker.appendRecords('events', 0, [
      { key: null, value: Buffer.from('p0-0'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    broker.appendRecords('events', 1, [
      { key: null, value: Buffer.from('p1-0'), headers: [], timestamp: 1_700_000_000_000n },
    ]);

    const commonOptions = {
      group_id: 'g5',
      topics: ['events'],
      decoding: { codec: 'text' },
      auto_offset_reset: 'earliest',
      session_timeout: 300,
      heartbeat_interval: 50,
      rebalance_timeout: 5_000,
      rebalance_commit_timeout: 2_000,
    };

    const first = await startKafkaSource(broker, commonOptions, { clock });
    await waitUntilReal(() => first.handle.assignment().length === 2);

    // The range assignor gives the earliest-sorted member a contiguous slice in partition order,
    // so with partition 0 fully acknowledged and the second member about to join, partition 1 is
    // the one that will move — leave it unacknowledged until the rebalance is actually underway.
    // Both partitions' initial batches may arrive in either order, so identify each by its own
    // `kafka.partition` metadata rather than assuming a fixed arrival order.
    await waitUntilReal(() => first.harness.sent.length >= 2);
    const [batchA, batchB] = first.harness.sent.slice(0, 2).map((b) => b.events);
    const p0Batch = partitionOfBatch(batchA!) === 0 ? batchA! : batchB!;
    const p1Batch = partitionOfBatch(batchA!) === 1 ? batchA! : batchB!;
    ack(p0Batch, 'delivered');
    await waitForCommittedOffset(broker, 'g5', 'events', 0, 1n);

    const second = await startKafkaSource(broker, commonOptions, { clock });

    // Member 1 only notices the rebalance on its own next heartbeat tick; step the shared clock
    // (which also drives the broker's session-timeout bookkeeping) until partition 1 moves.
    await settleUntil(clock, 50, () => !first.handle.assignment().some((tp) => tp.partition === 1));

    // The revoked partition's acknowledgement resolves *during* onRebalance's bounded wait.
    ack(p1Batch, 'delivered');

    await waitForCommittedOffset(broker, 'g5', 'events', 1, 1n);
    expect(first.handle.assignment().map((tp) => tp.partition)).toEqual([0]);

    await settleUntil(clock, 50, () => second.handle.assignment().some((tp) => tp.partition === 1));

    // The new owner never loses 'p1-0' — whether it also sees it again is a separate, genuinely
    // racy question (its own OffsetFetch, triggered the moment the rebalance assigns it this
    // partition, is not synchronized against the old owner's onRebalance-driven commit landing
    // first; real Kafka has this exact race too), which is exactly what "at-least-once" allows
    // and "the acknowledged prefix is committed before releasing" only narrows the window of,
    // rather than closing outright.
    broker.appendRecords('events', 1, [
      { key: null, value: Buffer.from('p1-1'), headers: [], timestamp: 1_700_000_000_000n },
    ]);
    await waitUntilReal(() =>
      second.harness.sent.flatMap((b) => messages(b.events)).includes('p1-1'),
    );
    expect(second.harness.sent.flatMap((b) => messages(b.events))).toContain('p1-1');
  });
});
