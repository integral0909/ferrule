import { describe, expect, it } from 'vitest';
import { isLogEvent, toPlain, type LogEvent, type Timestamp } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { demoLogsSource, type DemoLogsOptions } from '../src/demo_logs.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(): BuildContext {
  const { logger } = createCapturingLogger();
  return { id: 'demo', logger, dataDir: undefined, inputs: [] };
}

function parse(raw: Record<string, unknown> = {}): DemoLogsOptions {
  return demoLogsSource.options.parse(raw);
}

async function collectAll(
  raw: Record<string, unknown>,
  acknowledgements = false,
): Promise<LogEvent[]> {
  const opts = parse(raw);
  const handle = await demoLogsSource.build(opts, buildCtx());
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  await runPromise;
  const events: LogEvent[] = [];
  for (const batch of harness.sent) {
    for (const event of batch.events) {
      if (isLogEvent(event)) events.push(event);
      if (acknowledgements) event.metadata.finalizers.finish('delivered');
    }
  }
  return events;
}

describe('demo_logs: declared shape', () => {
  it('produces log events only', () => {
    expect(demoLogsSource.produces(parse())).toEqual(['log']);
  });
});

describe('demo_logs: pacing', () => {
  it('emits events_per_second events per tick, paced with ctx.clock.sleep', async () => {
    const opts = parse({ format: 'json', events_per_second: 2, count: 5 });
    const handle = await demoLogsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.sent.length === 1);
    expect(harness.sent[0]!.events).toHaveLength(2);
    expect(harness.clock.pendingCount).toBe(1); // waiting on the paced sleep, not blasting ahead

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 2);
    expect(harness.sent[1]!.events).toHaveLength(2);

    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 3);
    expect(harness.sent[2]!.events).toHaveLength(1); // remaining events to reach count: 5

    // count is reached exactly when the third batch is sent, so run() resolves without a
    // further sleep.
    await runPromise;
  });

  it('runs until ctx.signal aborts when count is omitted', async () => {
    const opts = parse({ format: 'json', events_per_second: 1 });
    const handle = await demoLogsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.sent.length === 1);
    harness.abort();
    await runPromise;
  });
});

describe('demo_logs: determinism', () => {
  it('produces byte-for-byte identical output for the same seed, start_time, and count', async () => {
    const raw = {
      format: 'all',
      seed: 42,
      count: 40,
      events_per_second: 40,
      start_time: '2024-01-01T00:00:00Z',
    };
    const first = await collectAll(raw);
    const second = await collectAll(raw);

    expect(first).toHaveLength(40);
    expect(second).toHaveLength(40);
    const canon = (events: LogEvent[]): unknown[] => events.map((e) => toPlain(e.fields));
    expect(canon(first)).toEqual(canon(second));
  });

  it('produces different output for a different seed', async () => {
    const raw = {
      format: 'all',
      count: 20,
      events_per_second: 20,
      start_time: '2024-01-01T00:00:00Z',
    };
    const first = await collectAll({ ...raw, seed: 1 });
    const second = await collectAll({ ...raw, seed: 2 });
    const canon = (events: LogEvent[]): unknown[] => events.map((e) => toPlain(e.fields));
    expect(canon(first)).not.toEqual(canon(second));
  });
});

describe('demo_logs: timestamps', () => {
  it('anchors generated events to ctx.clock.now() when start_time is omitted, advancing tick over tick', async () => {
    const opts = parse({ format: 'json', events_per_second: 2, count: 4 });
    const handle = await demoLogsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    // The harness's ManualClock starts at a fixed, known instant (the Unix epoch); run() reads
    // it once, at the very start, as the base for every generated timestamp.
    const startMs = harness.clock.now().toMillis();
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.sent.length === 1);
    await harness.clock.advance(1000);
    await waitUntil(() => harness.sent.length === 2);
    await runPromise;

    const firstTick = harness.sent[0]!.events.filter(isLogEvent);
    const secondTick = harness.sent[1]!.events.filter(isLogEvent);
    expect(firstTick).toHaveLength(2);
    expect(secondTick).toHaveLength(2);

    for (const event of firstTick) {
      const ts = event.get('timestamp') as Timestamp;
      expect(ts.toMillis()).toBeGreaterThanOrEqual(startMs);
      expect(ts.toMillis()).toBeLessThan(startMs + 1000);
    }
    for (const event of secondTick) {
      const ts = event.get('timestamp') as Timestamp;
      expect(ts.toMillis()).toBeGreaterThanOrEqual(startMs + 1000);
      expect(ts.toMillis()).toBeLessThan(startMs + 2000);
    }
  });
});

describe('demo_logs: formats', () => {
  it('generates apache_common lines shaped like an access log', async () => {
    const events = await collectAll({ format: 'apache_common', seed: 7, count: 10 });
    expect(events).toHaveLength(10);
    const pattern =
      /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3} - - \[\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000\] "[A-Z]+ \S+ HTTP\/1\.1" \d{3} \d+$/;
    for (const event of events) {
      const message = event.get('message');
      expect(typeof message).toBe('string');
      expect(message as string).toMatch(pattern);
    }
  });

  it('generates apache_combined lines including referrer and user-agent', async () => {
    const events = await collectAll({ format: 'apache_combined', seed: 7, count: 10 });
    for (const event of events) {
      const message = event.get('message') as string;
      expect(message).toMatch(/^\S+ - - \[.+\] ".+" \d{3} \d+ ".*" ".*"$/);
    }
  });

  it('generates json events with structured fields', async () => {
    const events = await collectAll({ format: 'json', seed: 7, count: 10 });
    for (const event of events) {
      expect(typeof event.get('service')).toBe('string');
      expect(typeof event.get('level')).toBe('string');
      expect(typeof event.get('message')).toBe('string');
      expect(typeof event.get('host')).toBe('string');
      expect(typeof event.get('request_id')).toBe('string');
      expect(typeof event.get('duration_ms')).toBe('number');
    }
  });

  it('generates syslog events decoded to the standard syslog field names', async () => {
    const events = await collectAll({ format: 'syslog', seed: 7, count: 10 });
    for (const event of events) {
      expect(typeof event.get('message')).toBe('string');
      expect(typeof event.get('hostname')).toBe('string');
      expect(typeof event.get('severity')).toBe('bigint');
      expect(typeof event.get('facility')).toBe('bigint');
    }
  });

  it('round-robins through every format when format is "all"', async () => {
    const events = await collectAll({ format: 'all', seed: 3, count: 8 });
    // apache_common and apache_combined both decode to a plain message; json/syslog carry
    // distinguishing fields, so checking field presence across the first four (one full cycle)
    // is enough to prove all formats were actually produced.
    expect(typeof events[2]!.get('service')).toBe('string'); // json is 3rd in FORMATS order
    expect(typeof events[3]!.get('hostname')).toBe('string'); // syslog is 4th
  });
});

describe('demo_logs: acknowledgements', () => {
  it('logs a warning when a batch is not delivered', async () => {
    const opts = parse({ format: 'json', events_per_second: 1, count: 1 });
    const handle = await demoLogsSource.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: true });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('errored');
    await runPromise;

    expect(harness.logs.some((r) => r.level === 'warn' && r.fields['status'] === 'errored')).toBe(
      true,
    );
  });
});
