import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLogEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { heartbeatSource, type HeartbeatOptions } from '../src/heartbeat.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(): BuildContext {
  const { logger } = createCapturingLogger();
  return { id: 'hb', logger, dataDir: undefined, inputs: [] };
}

function parse(raw: Record<string, unknown> = {}): HeartbeatOptions {
  return heartbeatSource.options.parse(raw);
}

describe('heartbeat: declared shape', () => {
  it('produces log events only', () => {
    expect(heartbeatSource.produces(parse())).toEqual(['log']);
  });
});

describe('heartbeat: emission timing', () => {
  it('emits nothing before the first interval elapses', async () => {
    const opts = parse({ intervalMs: 1000 });
    const handle = await heartbeatSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.clock.pendingCount === 1);
    expect(harness.sent).toHaveLength(0);

    harness.abort();
    await runPromise;
    expect(harness.sent).toHaveLength(0);
  });

  it('emits exactly one event per interval tick', async () => {
    const opts = parse({ intervalMs: 1000 });
    const handle = await heartbeatSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    expect(harness.sent[0]!.events).toHaveLength(1);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 2);
    expect(harness.sent[1]!.events).toHaveLength(1);

    // No third tick yet: still exactly two batches.
    expect(harness.sent).toHaveLength(2);

    harness.abort();
    await runPromise;
  });
});

describe('heartbeat: event fields', () => {
  it("includes this host's hostname and a numeric uptime", async () => {
    const opts = parse({ intervalMs: 1000, message: 'ping' });
    const handle = await heartbeatSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(isLogEvent(event)).toBe(true);
    if (isLogEvent(event)) {
      expect(event.get('message')).toBe('ping');
      expect(event.get('hostname')).toBe(hostname());
      expect(typeof event.get('uptime_seconds')).toBe('number');
      expect(event.has('timestamp')).toBe(true);
    }

    harness.abort();
    await runPromise;
  });
});

describe('heartbeat: acknowledgements', () => {
  it('logs a warning when an event is not delivered', async () => {
    const opts = parse({ intervalMs: 1000 });
    const handle = await heartbeatSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: true });
    const runPromise = handle.run(harness.ctx);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('rejected');
    await waitUntil(() =>
      harness.logs.some((r) => r.level === 'warn' && r.fields['status'] === 'rejected'),
    );

    harness.abort();
    await runPromise;
  });
});

describe('heartbeat: graceful shutdown', () => {
  it('stops emitting and lets run() resolve promptly once ctx.signal aborts', async () => {
    const opts = parse({ intervalMs: 1000 });
    const handle = await heartbeatSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.clock.pendingCount === 1);
    harness.abort();
    await runPromise; // must not hang on the pending sleep

    // Advancing the clock further after shutdown must not produce any more events.
    await harness.clock.advance(5000);
    expect(harness.sent).toHaveLength(0);
  });
});
