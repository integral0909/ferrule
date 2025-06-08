import { describe, expect, it } from 'vitest';
import { s } from '@ferrule/schema';
import { LogEvent, type Event, type Timestamp } from '@ferrule/core';
import {
  ManualClock,
  MetricsRegistry,
  Metrics,
  Pipeline,
  TopologyValidationError,
  createCollectingSinkDefinition,
  createScriptedSourceDefinition,
  defineSink,
  defineTransform,
  type TopologySpec,
} from '@ferrule/runtime';
import { basicTransformDefinition, createRegistry } from './fixtures.js';

function messagesOf(events: readonly Event[]): string[] {
  return events.map((e) => (e as LogEvent).get('message') as string);
}

describe('Pipeline end to end', () => {
  it('delivers events from a scripted source through the default port to a collecting sink', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')] },
    ]);
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    expect(messagesOf(collector.events).sort()).toEqual(['a', 'b']);
    expect(await Promise.all(handle.completions)).toEqual(['delivered']);
  });

  it('acknowledges rejected when the sink finishes an event as rejected', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snk } = createCollectingSinkDefinition({ finish: () => 'rejected' });
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('rejected');
    await pipeline.stop();
  });

  it('acknowledges errored when the sink finishes an event as errored', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snk } = createCollectingSinkDefinition({ finish: () => 'errored' });
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
    await pipeline.stop();
  });

  it('fans out one source to two sinks, requiring both to acknowledge before the batch completes', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('x')] },
    ]);
    const { definition: snkA, collector: collectorA } = createCollectingSinkDefinition({
      type: 'collect_a',
    });
    const { definition: snkB, collector: collectorB } = createCollectingSinkDefinition({
      type: 'collect_b',
    });
    const registry = createRegistry(src, snkA, snkB);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: {
        a: { type: snkA.type, options: {}, inputs: ['in'] },
        b: { type: snkB.type, options: {}, inputs: ['in'] },
      },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('delivered');
    await pipeline.stop();

    expect(messagesOf(collectorA.events)).toEqual(['x']);
    expect(messagesOf(collectorB.events)).toEqual(['x']);
    // Fan-out clones: the two sinks must never have observed the same event object.
    expect(collectorA.events[0]).not.toBe(collectorB.events[0]);
  });

  it("drives a transform's tick() on its declared interval via the pipeline clock", async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const buffering = defineTransform({
      kind: 'transform',
      type: 'buffer_and_tick',
      description: 'buffers messages and emits a combined event on each tick',
      options: s.object({}),
      accepts: ['log'],
      build: () => {
        let pending: string[] = [];
        return {
          tickIntervalMs: 100,
          process: (events, _out) => {
            for (const event of events) pending.push((event as LogEvent).get('message') as string);
            for (const event of events) event.metadata.finalizers.finish('delivered');
          },
          tick: (now: Timestamp, out) => {
            if (pending.length === 0) return;
            out.push(LogEvent.fromMessage(`tick:${pending.join(',')}@${now.toMillis()}`));
            pending = [];
          },
        };
      },
    });
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, buffering, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: buffering.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry, clock });
    await pipeline.start();
    await handle.allSent;

    // Give the transform's process loop a chance to consume the batch before the tick fires.
    await new Promise((resolve) => setImmediate(resolve));
    expect(collector.events).toHaveLength(0);

    await clock.advance(100);
    await new Promise((resolve) => setImmediate(resolve));
    expect(messagesOf(collector.events)).toEqual(['tick:a@100']);

    await pipeline.stop();
  });

  it("calls a transform's flush() during shutdown so buffered state is not lost", async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const holding = defineTransform({
      kind: 'transform',
      type: 'hold_until_flush',
      description: 'holds events until flush',
      options: s.object({}),
      accepts: ['log'],
      build: () => {
        const held: Event[] = [];
        return {
          process: (events) => {
            held.push(...events);
          },
          flush: (out) => {
            for (const event of held.splice(0, held.length)) out.push(event);
          },
        };
      },
    });
    const { definition: snk, collector } = createCollectingSinkDefinition();
    const registry = createRegistry(src, holding, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: holding.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    await pipeline.stop();

    expect(messagesOf(collector.events)).toEqual(['a']);
  });

  it('force-finalizes remaining buffered events as errored once the shutdown deadline elapses', async () => {
    const clock = new ManualClock();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    // A sink that respects cancellation but never reads ctx.input, simulating a stuck delivery.
    const hangingSink = defineSink({
      kind: 'sink',
      type: 'hangs',
      description: 'never drains its input; stops only when aborted',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        run: (ctx) =>
          new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve();
              return;
            }
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
      }),
    });
    const registry = createRegistry(src, hangingSink);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: hangingSink.type, options: {}, inputs: ['in'] } },
      settings: { shutdownDeadlineMs: 50 },
    };
    const pipeline = await Pipeline.create(spec, { registry, clock });
    await pipeline.start();
    await handle.allSent;

    const stopPromise = pipeline.stop();
    await clock.advance(50);
    await stopPromise;

    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
    expect(pipeline.health().overall).toBe('stopped');
  });
});

describe('Pipeline failure isolation', () => {
  it('a failing transform stops the whole pipeline by default', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const failing = defineTransform({
      kind: 'transform',
      type: 'always_fails',
      description: 'x',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        process: () => {
          throw new Error('kaboom');
        },
      }),
    });
    const { definition: snk } = createCollectingSinkDefinition();
    const registry = createRegistry(src, failing, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: { t: { type: failing.type, options: {}, inputs: ['in'] } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['t'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    // The failing transform triggers the pipeline's own stop(); waiting on stop() here attaches
    // to that same shutdown (it is idempotent) and resolves once it has fully settled.
    await pipeline.stop();

    const health = pipeline.health();
    expect(health.components.find((c) => c.id === 't')?.state).toBe('failed');
    expect(health.overall).toBe('stopped');
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
  });

  it('with continueOnComponentFailure, a failing component is isolated and the rest keeps running', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const failing = defineTransform({
      kind: 'transform',
      type: 'always_fails_2',
      description: 'x',
      options: s.object({}),
      accepts: ['log'],
      build: () => ({
        process: () => {
          throw new Error('kaboom');
        },
      }),
    });
    const { definition: passthrough } = { definition: basicTransformDefinition('passthrough') };
    const { definition: snkFailing } = createCollectingSinkDefinition({
      type: 'collect_failing_input',
    });
    const { definition: snkHealthy, collector } = createCollectingSinkDefinition({
      type: 'collect_healthy',
    });
    const registry = createRegistry(src, failing, passthrough, snkFailing, snkHealthy);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      transforms: {
        broken: { type: failing.type, options: {}, inputs: ['in'] },
        ok: { type: passthrough.type, options: {}, inputs: ['in'] },
      },
      sinks: {
        deadend: { type: snkFailing.type, options: {}, inputs: ['broken'] },
        healthy: { type: snkHealthy.type, options: {}, inputs: ['ok'] },
      },
      settings: { continueOnComponentFailure: true },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;

    // The batch completes once both fan-out clones settle: 'broken' finalizes its copy errored
    // (the transform crashed) and 'healthy' finalizes its copy delivered, deterministically, with
    // no need to poll.
    const [status] = await Promise.all(handle.completions);
    expect(status).toBe('errored');
    expect(messagesOf(collector.events)).toEqual(['a']);
    const health = pipeline.health();
    expect(health.overall).toBe('degraded');
    expect(health.components.find((c) => c.id === 'broken')?.state).toBe('failed');
    expect(health.components.find((c) => c.id === 'healthy')?.state).toBe('running');
    await pipeline.stop();
  });
});

describe('Pipeline.create validation', () => {
  it('throws TopologyValidationError for an invalid spec', async () => {
    const registry = createRegistry();
    const spec: TopologySpec = {
      sources: { in: { type: 'nope', options: {} } },
      sinks: {},
    };
    await expect(Pipeline.create(spec, { registry })).rejects.toBeInstanceOf(
      TopologyValidationError,
    );
  });
});

describe('Pipeline health() and snapshot()', () => {
  it('reflects running components and the topology shape', async () => {
    const { definition: src, handle } = createScriptedSourceDefinition([{ events: [] }]);
    const { definition: snk } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry });
    await pipeline.start();
    await handle.allSent;
    const health = pipeline.health();
    expect(health.overall).toBe('running');
    expect(health.components.map((c) => c.id).sort()).toEqual(['in', 'out']);

    const snapshot = pipeline.snapshot();
    expect(snapshot.components.find((c) => c.id === 'out')?.inputs).toEqual(['in']);
    await pipeline.stop();
    expect(pipeline.health().overall).toBe('stopped');
  });
});

describe('Pipeline metrics', () => {
  it('records sent/received event counters at component boundaries automatically', async () => {
    const metrics = new MetricsRegistry();
    const { definition: src, handle } = createScriptedSourceDefinition([
      { events: [LogEvent.fromMessage('a')] },
    ]);
    const { definition: snk } = createCollectingSinkDefinition();
    const registry = createRegistry(src, snk);
    const spec: TopologySpec = {
      sources: { in: { type: src.type, options: {} } },
      sinks: { out: { type: snk.type, options: {}, inputs: ['in'] } },
    };
    const pipeline = await Pipeline.create(spec, { registry, metrics });
    await pipeline.start();
    await handle.allSent;
    await Promise.all(handle.completions);
    await pipeline.stop();

    const snapshot = metrics.snapshot();
    const sent = snapshot.find(
      (m) => m.name === Metrics.sentEvents && m.tags.get('component_id') === 'in',
    );
    const received = snapshot.find(
      (m) => m.name === Metrics.receivedEvents && m.tags.get('component_id') === 'out',
    );
    expect(sent?.value).toEqual({ type: 'counter', value: 1 });
    expect(received?.value).toEqual({ type: 'counter', value: 1 });
  });
});
