import { describe, expect, it, vi } from 'vitest';
import { BatchNotifier, FerruleError, Finalizers, worseStatus } from '@ferrule/core';

describe('worseStatus', () => {
  it('keeps the more severe status', () => {
    expect(worseStatus('delivered', 'errored')).toBe('errored');
    expect(worseStatus('rejected', 'errored')).toBe('rejected');
    expect(worseStatus('delivered', 'delivered')).toBe('delivered');
  });
});

describe('BatchNotifier', () => {
  it('does not complete before it is sealed', async () => {
    const onComplete = vi.fn();
    const batch = new BatchNotifier(onComplete);
    const f = batch.createFinalizer();
    f.finish();
    expect(onComplete).not.toHaveBeenCalled();
    batch.seal();
    expect(onComplete).toHaveBeenCalledWith('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
    expect(batch.isComplete).toBe(true);
  });

  it('completes immediately when sealed empty', async () => {
    const batch = new BatchNotifier();
    batch.seal();
    await expect(batch.completion).resolves.toBe('delivered');
  });

  it('waits for every finalizer and reports the worst status', async () => {
    const batch = new BatchNotifier();
    const a = batch.createFinalizer();
    const b = batch.createFinalizer();
    const c = batch.createFinalizer();
    batch.seal();
    a.finish('delivered');
    b.finish('rejected');
    expect(batch.isComplete).toBe(false);
    expect(batch.pendingCount).toBe(1);
    c.finish('errored');
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('ignores repeated finishes', () => {
    const onComplete = vi.fn();
    const batch = new BatchNotifier(onComplete);
    const a = batch.createFinalizer();
    batch.createFinalizer();
    batch.seal();
    a.finish();
    a.finish();
    expect(onComplete).not.toHaveBeenCalled();
    expect(a.isFinished).toBe(true);
  });

  it('refuses new finalizers once complete', () => {
    const batch = new BatchNotifier();
    batch.seal();
    expect(() => batch.createFinalizer()).toThrow(FerruleError);
  });

  it('tracks clones created for fan-out', async () => {
    const batch = new BatchNotifier();
    const original = batch.createFinalizer();
    original.update('errored');
    const copy = original.clone();
    batch.seal();
    original.finish();
    expect(batch.isComplete).toBe(false);
    copy.finish();
    // The clone inherits the status recorded before cloning.
    await expect(batch.completion).resolves.toBe('errored');
  });
});

describe('Finalizers', () => {
  it('finishes all members with a status and empties itself', async () => {
    const batch = new BatchNotifier();
    const set = new Finalizers();
    set.add(batch.createFinalizer());
    set.add(batch.createFinalizer());
    batch.seal();
    expect(set.size).toBe(2);
    set.finish('rejected');
    expect(set.isEmpty).toBe(true);
    await expect(batch.completion).resolves.toBe('rejected');
  });

  it('merges by moving finalizers from another set', async () => {
    const b1 = new BatchNotifier();
    const b2 = new BatchNotifier();
    const aggregate = new Finalizers();
    const input1 = new Finalizers();
    const input2 = new Finalizers();
    input1.add(b1.createFinalizer());
    input2.add(b2.createFinalizer());
    b1.seal();
    b2.seal();
    aggregate.merge(input1);
    aggregate.merge(input2);
    aggregate.merge(aggregate);
    expect(input1.isEmpty && input2.isEmpty).toBe(true);
    expect(aggregate.size).toBe(2);
    aggregate.finish();
    await expect(Promise.all([b1.completion, b2.completion])).resolves.toEqual([
      'delivered',
      'delivered',
    ]);
  });

  it('records a status on all members without finishing them', async () => {
    const batch = new BatchNotifier();
    const set = new Finalizers();
    set.add(batch.createFinalizer());
    batch.seal();
    set.update('errored');
    expect(batch.isComplete).toBe(false);
    set.finish();
    await expect(batch.completion).resolves.toBe('errored');
  });

  it('clones and takes', async () => {
    const batch = new BatchNotifier();
    const set = new Finalizers();
    set.add(batch.createFinalizer());
    batch.seal();
    const copy = set.clone();
    const taken = set.take();
    expect(set.isEmpty).toBe(true);
    expect(taken.size).toBe(1);
    taken.finish();
    expect(batch.isComplete).toBe(false);
    copy.finish('errored');
    await expect(batch.completion).resolves.toBe('errored');
  });
});
