import { describe, expect, it } from 'vitest';
import { ManualClock, SystemClock } from '@ferrule/runtime';

describe('SystemClock', () => {
  it('reports increasing monotonic time', () => {
    const clock = new SystemClock();
    const a = clock.monotonic();
    const b = clock.monotonic();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('sleep resolves after roughly the requested duration', async () => {
    const clock = new SystemClock();
    const start = clock.monotonic();
    await clock.sleep(5);
    expect(clock.monotonic() - start).toBeGreaterThanOrEqual(0);
  });

  it('sleep rejects immediately if the signal is already aborted', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    await expect(clock.sleep(1000, controller.signal)).rejects.toThrow('nope');
  });

  it('sleep rejects when aborted mid-wait', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    const p = clock.sleep(10_000, controller.signal);
    queueMicrotask(() => controller.abort(new Error('cancelled')));
    await expect(p).rejects.toThrow('cancelled');
  });
});

describe('ManualClock', () => {
  it('does not move time on its own', () => {
    const clock = new ManualClock();
    expect(clock.monotonic()).toBe(0);
    expect(clock.now().nanos).toBe(0n);
  });

  it('resolves a pending sleep once advanced past its deadline', async () => {
    const clock = new ManualClock();
    let resolved = false;
    const p = clock.sleep(100).then(() => {
      resolved = true;
    });
    await clock.advance(50);
    expect(resolved).toBe(false);
    await clock.advance(50);
    await p;
    expect(resolved).toBe(true);
    expect(clock.monotonic()).toBe(100);
  });

  it('advances wall time in step with monotonic time', async () => {
    const clock = new ManualClock();
    await clock.advance(1_500);
    expect(clock.now().toMillis()).toBe(1_500);
  });

  it('resolves multiple pending sleeps in deadline order', async () => {
    const clock = new ManualClock();
    const order: string[] = [];
    const p1 = clock.sleep(30).then(() => order.push('a'));
    const p2 = clock.sleep(10).then(() => order.push('b'));
    const p3 = clock.sleep(20).then(() => order.push('c'));
    await clock.advance(30);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('lets a resolved sleep schedule another sleep that still resolves within the same advance', async () => {
    const clock = new ManualClock();
    const order: string[] = [];
    const chained = clock.sleep(10).then(async () => {
      order.push('first');
      await clock.sleep(10);
      order.push('second');
    });
    await clock.advance(20);
    await chained;
    expect(order).toEqual(['first', 'second']);
  });

  it('tick resolves only the next pending sleep', async () => {
    const clock = new ManualClock();
    const order: string[] = [];
    const p1 = clock.sleep(10).then(() => order.push('a'));
    const p2 = clock.sleep(20).then(() => order.push('b'));
    const advanced = await clock.tick();
    expect(advanced).toBe(true);
    expect(clock.monotonic()).toBe(10);
    expect(order).toEqual(['a']);
    await clock.tick();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a', 'b']);
  });

  it('tick returns false when nothing is pending', async () => {
    const clock = new ManualClock();
    await expect(clock.tick()).resolves.toBe(false);
  });

  it('sleep rejects and unregisters when aborted before its deadline', async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const p = clock.sleep(100, controller.signal);
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(clock.pendingCount).toBe(0);
  });

  it('sleep rejects immediately if the signal is already aborted', async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(clock.sleep(100, controller.signal)).rejects.toThrow('already gone');
  });

  it('rejects a negative or non-finite duration', async () => {
    const clock = new ManualClock();
    await expect(clock.sleep(-1)).rejects.toThrow(RangeError);
    await expect(clock.sleep(Infinity)).rejects.toThrow(RangeError);
  });

  it('zero-duration sleep resolves without needing an advance', async () => {
    const clock = new ManualClock();
    await expect(clock.sleep(0)).resolves.toBeUndefined();
  });
});
