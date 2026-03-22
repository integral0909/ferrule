import { describe, expect, it } from 'vitest';
import { BatchNotifier, type LogEvent } from '@ferrule/core';
import { assertPortOrder, log, testSink, testSource, testTransform } from '@ferrule/testkit';
import { fakeSinkDefinition, fakeSourceDefinition, upcaseTransformDefinition } from './helpers.js';

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
