import { describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { createBlackholeSink } from '../../src/stream/blackhole.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

describe('blackhole sink', () => {
  it('finishes every event as delivered without side effects', async () => {
    const sink = createBlackholeSink({});
    const harness = createTestSinkContext();
    const events = [
      LogEvent.fromMessage('a'),
      LogEvent.fromMessage('b'),
      LogEvent.fromMessage('c'),
    ];
    const completions = events.map(withFinalizer);

    const running = sink.run(harness.ctx);
    await harness.feed(events);
    harness.close();
    await running;

    for (const c of completions) await expect(c).resolves.toBe('delivered');
  });

  it('logs progress periodically when logInterval is set, driven by the manual clock', async () => {
    const sink = createBlackholeSink({ logInterval: 1000 });
    const harness = createTestSinkContext();

    const running = sink.run(harness.ctx);
    await harness.feed([LogEvent.fromMessage('a'), LogEvent.fromMessage('b')]);
    // Let the sink's for-await loop actually pull the fed batch off the channel before the
    // clock advances, since `feed()` only waits for the channel to accept the batch.
    await new Promise((resolve) => setImmediate(resolve));
    await harness.clock.advance(1000);
    await harness.clock.advance(1000);
    harness.close();
    await running;

    const progressLogs = harness.logs.filter((l) => l.message === 'blackhole sink progress');
    expect(progressLogs.length).toBeGreaterThanOrEqual(2);
    expect(progressLogs[0]?.fields['totalEvents']).toBe(2);
    const stopped = harness.logs.find((l) => l.message === 'blackhole sink stopped');
    expect(stopped?.fields['totalEvents']).toBe(2);
  });
});
