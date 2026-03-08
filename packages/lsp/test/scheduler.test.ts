import { describe, expect, it, vi } from 'vitest';
import { createImmediateScheduler, createTimeoutScheduler, ManualScheduler } from '@ferrule/lsp';

describe('ManualScheduler', () => {
  it('does not run a scheduled callback until flush() is called', () => {
    const scheduler = new ManualScheduler();
    const fn = vi.fn();
    scheduler.schedule('a', 500, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(scheduler.pendingKeys).toEqual(['a']);
    scheduler.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingKeys).toEqual([]);
  });

  it('re-scheduling the same key replaces the pending callback (debounce)', () => {
    const scheduler = new ManualScheduler();
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule('doc', 100, first);
    scheduler.schedule('doc', 100, second);
    scheduler.flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel removes a pending callback without running it', () => {
    const scheduler = new ManualScheduler();
    const fn = vi.fn();
    scheduler.schedule('doc', 100, fn);
    scheduler.cancel('doc');
    scheduler.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('tracks independent keys separately', () => {
    const scheduler = new ManualScheduler();
    const a = vi.fn();
    const b = vi.fn();
    scheduler.schedule('a', 10, a);
    scheduler.schedule('b', 10, b);
    scheduler.cancel('a');
    scheduler.flush();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('dispose clears every pending callback', () => {
    const scheduler = new ManualScheduler();
    const fn = vi.fn();
    scheduler.schedule('a', 10, fn);
    scheduler.dispose();
    expect(scheduler.pendingKeys).toEqual([]);
    scheduler.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createImmediateScheduler', () => {
  it('runs the callback synchronously, ignoring the delay', () => {
    const scheduler = createImmediateScheduler();
    const fn = vi.fn();
    scheduler.schedule('a', 10_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createTimeoutScheduler', () => {
  it('debounces repeated schedules for the same key using real timers', () => {
    vi.useFakeTimers();
    try {
      const scheduler = createTimeoutScheduler();
      const fn = vi.fn();
      scheduler.schedule('doc', 50, fn);
      vi.advanceTimersByTime(20);
      scheduler.schedule('doc', 50, fn); // resets the debounce window
      vi.advanceTimersByTime(40);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(fn).toHaveBeenCalledTimes(1);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel prevents the callback from firing', () => {
    vi.useFakeTimers();
    try {
      const scheduler = createTimeoutScheduler();
      const fn = vi.fn();
      scheduler.schedule('doc', 10, fn);
      scheduler.cancel('doc');
      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
