import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BatchNotifier,
  FerruleError,
  LogEvent,
  utf8Encode,
  type DeliveryStatus,
} from '@ferrule/core';
import { CodecRegistry, defaultCodecs, type Codec } from '@ferrule/codecs';
import { createTestSinkContext } from '@ferrule/runtime';
import { createConsoleSink, type ConsoleSinkOptions } from '../../src/stream/console.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function baseOptions(overrides: Partial<ConsoleSinkOptions> = {}): ConsoleSinkOptions {
  return {
    stream: 'stdout',
    encoding: { codec: 'json' },
    framing: { method: 'newline' },
    ...overrides,
  };
}

describe('console sink', () => {
  it('encodes and newline-frames every event it receives, delivering each', async () => {
    const target = new PassThrough();
    const chunks: Buffer[] = [];
    target.on('data', (chunk: Buffer) => chunks.push(chunk));
    const sink = createConsoleSink(baseOptions(), target);
    const harness = createTestSinkContext();

    const a = LogEvent.fromMessage('hello');
    const b = LogEvent.fromMessage('world');
    const done1 = withFinalizer(a);
    const done2 = withFinalizer(b);

    const running = sink.run(harness.ctx);
    await harness.feed([a, b]);
    harness.close();
    await running;

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toBe('{"message":"hello"}\n{"message":"world"}\n');
    await expect(done1).resolves.toBe('delivered');
    await expect(done2).resolves.toBe('delivered');
  });

  it('respects backpressure: does not write the next event until the stream drains', async () => {
    const target = new PassThrough({ highWaterMark: 1 });
    // Pause the stream so its internal buffer fills up and write() starts returning false.
    target.pause();
    const sink = createConsoleSink(baseOptions({ encoding: { codec: 'text' } }), target);
    const harness = createTestSinkContext();

    const events = Array.from({ length: 50 }, (_, i) => LogEvent.fromMessage('x'.repeat(200) + i));
    const completions = events.map(withFinalizer);

    const running = sink.run(harness.ctx);
    await harness.feed(events);
    harness.close();

    // Give the sink a chance to run; it should be blocked on backpressure, not yet finished.
    await new Promise((resolve) => setImmediate(resolve));
    let resumed = false;
    setTimeout(() => {
      resumed = true;
      target.resume();
    }, 5);
    await running;
    expect(resumed).toBe(true);
    for (const c of completions) await expect(c).resolves.toBe('delivered');
  });

  it('finishes an event as errored when encoding fails, without aborting the batch', async () => {
    const throwing: Codec = {
      name: 'throwing',
      createEncoder: () => ({
        name: 'throwing',
        encode: (event) => {
          if (event instanceof LogEvent && event.get('message') === 'boom') {
            throw new FerruleError('E_TEST_BOOM', 'synthetic failure');
          }
          return utf8Encode('ok');
        },
      }),
    };
    const registry = new CodecRegistry().register(throwing);
    const target = new PassThrough();
    target.resume();
    const sink = createConsoleSink(
      baseOptions({ encoding: { codec: 'throwing' } }),
      target,
      registry,
    );
    const harness = createTestSinkContext();

    const good = LogEvent.fromMessage('fine');
    const bad = LogEvent.fromMessage('boom');
    const doneGood = withFinalizer(good);
    const doneBad = withFinalizer(bad);

    const running = sink.run(harness.ctx);
    await harness.feed([bad, good]);
    harness.close();
    await running;

    await expect(doneBad).resolves.toBe('errored');
    await expect(doneGood).resolves.toBe('delivered');
  });

  it('writes length-prefixed frames when configured', async () => {
    const target = new PassThrough();
    const chunks: Buffer[] = [];
    target.on('data', (chunk: Buffer) => chunks.push(chunk));
    const sink = createConsoleSink(
      baseOptions({
        framing: { method: 'length_prefixed', width: 'u16', endianness: 'BE' },
        encoding: { codec: 'text' },
      }),
      target,
      defaultCodecs,
    );
    const harness = createTestSinkContext();
    const event = LogEvent.fromMessage('abc');
    const done = withFinalizer(event);
    const running = sink.run(harness.ctx);
    await harness.feed(event);
    harness.close();
    await running;
    const buf = Buffer.concat(chunks);
    expect(buf.readUInt16BE(0)).toBe(3);
    expect(buf.subarray(2).toString('utf8')).toBe('abc');
    await expect(done).resolves.toBe('delivered');
  });
});
