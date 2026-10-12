import { describe, expect, it, vi } from 'vitest';
import { BatchNotifier, type LogEvent } from '@ferrule/core';
import { assertPortOrder, log, testSink, testSource, testTransform } from '@ferrule/testkit';
import {
  fakeSinkDefinition,
  fakeSourceDefinition,
  upcaseAsyncTransformDefinition,
  upcaseTransformDefinition,
} from './helpers.js';

describe('testTransform', () => {
  it('validates options against the definition schema', async () => {
    await expect(
      testTransform(upcaseTransformDefinition, { unknown_field: 1 }, []),
    ).rejects.toThrow();
  });

  it('runs process() and reports pushed events', async () => {
    const result = await testTransform(upcaseTransformDefinition, {}, [log({ message: 'hi' })]);
    expect(result.pushed).toHaveLength(1);
    expect((result.pushed[0]!.event as LogEvent).get('message')).toBe('HI');
    expect(result.status).toBe('delivered');
  });

  it('detects a finalizer leak when a bug drops an event without finishing it', async () => {
    const buggyDefinition = { ...upcaseTransformDefinition, build: () => ({ process() {} }) };
    await expect(testTransform(buggyDefinition, {}, [log({ message: 'x' })])).rejects.toThrow(
      /finalizer leak/,
    );
  });

  it('finishPushed: "none" leaves pushed events unfinished for the caller to finish', async () => {
    const result = await testTransform(upcaseTransformDefinition, {}, [log({ message: 'x' })], {
      finishPushed: 'none',
    });
    expect(result.pushed[0]!.event.metadata.finalizers.isEmpty).toBe(false);
  });

  it('assertPortOrder passes/fails based on push order', async () => {
    const result = await testTransform(upcaseTransformDefinition, {}, [
      log({ message: 'a' }),
      log({ message: 'b' }),
    ]);
    expect(() => assertPortOrder(result.pushed, ['_default', '_default'])).not.toThrow();
    expect(() => assertPortOrder(result.pushed, ['_default'])).toThrow(/push order mismatch/);
  });

  it('awaits processAsync() and reports pushed events', async () => {
    const result = await testTransform(upcaseAsyncTransformDefinition, {}, [
      log({ message: 'hi' }),
    ]);
    expect(result.pushed).toHaveLength(1);
    expect((result.pushed[0]!.event as LogEvent).get('message')).toBe('HI');
    expect(result.status).toBe('delivered');
  });

  it('detects a finalizer leak from a buggy processAsync, same as process()', async () => {
    const buggyDefinition = {
      ...upcaseAsyncTransformDefinition,
      build: () => ({ processAsync: async () => {} }),
    };
    await expect(testTransform(buggyDefinition, {}, [log({ message: 'x' })])).rejects.toThrow(
      /finalizer leak/,
    );
  });

  it('rejects a transform implementing both process and processAsync', async () => {
    const bothDefinition = {
      ...upcaseTransformDefinition,
      build: () => ({ process: () => {}, processAsync: async () => {} }),
    };
    await expect(testTransform(bothDefinition, {}, [])).rejects.toMatchObject({
      code: 'E_TRANSFORM_CONTRACT',
    });
  });

  it('rejects a transform implementing neither process nor processAsync', async () => {
    const neitherDefinition = { ...upcaseTransformDefinition, build: () => ({}) };
    await expect(testTransform(neitherDefinition, {}, [])).rejects.toMatchObject({
      code: 'E_TRANSFORM_CONTRACT',
    });
  });

  it('applies the same leak timeout to a processAsync that never resolves', async () => {
    vi.useFakeTimers();
    try {
      const hangingDefinition = {
        ...upcaseAsyncTransformDefinition,
        build: () => ({ processAsync: () => new Promise<void>(() => {}) }),
      };
      const resultPromise = testTransform(hangingDefinition, {}, [log({ message: 'x' })]);
      const assertion = expect(resultPromise).rejects.toThrow(/finalizer leak/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('testSource', () => {
  it('drives a source and collects what it sends', async () => {
    const result = await testSource(fakeSourceDefinition, {}, (harness) => {
      harness.abort();
    });
    expect(result.sent).toEqual([]);
  });
});

describe('testSink', () => {
  it('feeds events and awaits their finalizers finishing', async () => {
    const events = [log({ message: 'a' }), log({ message: 'b' })];
    const batch = new BatchNotifier();
    for (const e of events) e.metadata.finalizers.add(batch.createFinalizer());
    batch.seal();
    const result = await testSink(fakeSinkDefinition, {}, events);
    expect(result.status).toBe('delivered');
    await expect(batch.completion).resolves.toBe('delivered');
  });
});
