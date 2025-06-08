import { describe, expect, it } from 'vitest';
import { createLogger, createNullLogger, ManualClock, type LogSink } from '@ferrule/runtime';

function captureSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return { sink: { write: (chunk: string) => lines.push(chunk) }, lines };
}

describe('createLogger', () => {
  it('writes JSON lines by default, including merged fields', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink, clock: new ManualClock() });
    logger.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!.trimEnd()) as Record<string, unknown>;
    expect(record['message']).toBe('hello');
    expect(record['level']).toBe('info');
    expect(record['a']).toBe(1);
    expect(record['time']).toBe('1970-01-01T00:00:00Z');
  });

  it('filters records below the configured level', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink, level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes too');
    expect(lines).toHaveLength(2);
  });

  it('writes human-readable lines in pretty format', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink, format: 'pretty', clock: new ManualClock() });
    logger.warn('disk almost full', { pct: 91 });
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).toContain('disk almost full');
    expect(lines[0]).toContain('pct=91');
  });

  it('child loggers merge in their own fields without mutating the parent', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink });
    const child = logger.child({ component: 'my-sink' });
    child.info('child message');
    logger.info('parent message');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first['component']).toBe('my-sink');
    expect(second['component']).toBeUndefined();
  });

  it('grandchildren accumulate fields from every ancestor', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink });
    const grandchild = logger.child({ a: 1 }).child({ b: 2 });
    grandchild.info('nested');
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record['a']).toBe(1);
    expect(record['b']).toBe(2);
  });

  it('serializes bigints and errors safely as JSON', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink });
    logger.error('boom', { count: 9_007_199_254_740_993n, err: new Error('bad') });
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record['count']).toBe('9007199254740993');
    expect((record['err'] as { message: string }).message).toBe('bad');
  });

  it('rate limits repeated identical messages and summarizes suppressions', async () => {
    const { sink, lines } = captureSink();
    const clock = new ManualClock();
    const logger = createLogger({ sink, clock, rateLimit: { intervalMs: 1_000, burst: 2 } });
    for (let i = 0; i < 5; i++) logger.info('repeated');
    // 2 emitted immediately; the rest suppressed until the window is crossed.
    expect(lines).toHaveLength(2);

    // Crossing the window with another call emits a summary line before the new occurrence.
    await clock.advance(1_000);
    logger.info('repeated');
    expect(lines).toHaveLength(4);
    const summary = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(String(summary['message'])).toContain('suppressed 3');
  });

  it('does not rate limit distinct messages', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ sink, rateLimit: { intervalMs: 1_000, burst: 1 } });
    logger.info('a');
    logger.info('b');
    logger.info('c');
    expect(lines).toHaveLength(3);
  });
});

describe('createNullLogger', () => {
  it('never throws and writes nothing observable', () => {
    const logger = createNullLogger();
    expect(() => {
      logger.debug('x');
      logger.info('y');
      logger.warn('z');
      logger.error('w');
      logger.child({ a: 1 }).info('nested');
    }).not.toThrow();
  });
});
