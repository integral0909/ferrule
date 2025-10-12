import { describe, expect, it } from 'vitest';
import { Timestamp } from '@ferrule/core';
import { ERROR_PORT } from '@ferrule/runtime';
import { remapFieldsTransform } from '@ferrule/operators';
import { buildTransform, logEvent, sealedBatch } from './helpers.js';

describe('remap_fields', () => {
  it('renames, sets, deletes, and coerces in order', async () => {
    const { transform, harness } = await buildTransform(remapFieldsTransform, {
      operations: [
        { op: 'rename', from: 'lvl', to: 'level' },
        { op: 'coerce', field: 'status', to: 'int' },
        { op: 'set', field: 'source', value: 'edge' },
        { op: 'delete', field: 'debug' },
      ],
    });
    const event = logEvent({ lvl: 'info', status: '200', debug: true });
    transform.process([event], harness.out);

    expect(harness.pushed).toHaveLength(1);
    const { event: out, port } = harness.pushed[0]!;
    expect(port).toBe('_default');
    expect((out as typeof event).get('level')).toBe('info');
    expect((out as typeof event).has('lvl')).toBe(false);
    expect((out as typeof event).get('status')).toBe(200n);
    expect((out as typeof event).get('source')).toBe('edge');
    expect((out as typeof event).has('debug')).toBe(false);
  });

  it('copy keeps the original field and duplicates the value', async () => {
    const { transform, harness } = await buildTransform(remapFieldsTransform, {
      operations: [{ op: 'copy', from: 'a', to: 'b' }],
    });
    const event = logEvent({ a: 1 });
    transform.process([event], harness.out);
    const out = harness.pushed[0]!.event as typeof event;
    expect(out.get('a')).toBe(1n);
    expect(out.get('b')).toBe(1n);
  });

  it('coerces every supported target type', async () => {
    const { transform, harness } = await buildTransform(remapFieldsTransform, {
      operations: [
        { op: 'coerce', field: 'i', to: 'string' },
        { op: 'coerce', field: 'f', to: 'int' },
        { op: 'coerce', field: 's', to: 'bool' },
        { op: 'coerce', field: 'b', to: 'float' },
        { op: 'coerce', field: 't', to: 'timestamp', format: 'unix_seconds' },
      ],
    });
    const event = logEvent({ i: 42, f: 3.9, s: 'true', b: true, t: 1700000000 });
    transform.process([event], harness.out);
    const out = harness.pushed[0]!.event as typeof event;
    expect(out.get('i')).toBe('42');
    expect(out.get('f')).toBe(3n);
    expect(out.get('s')).toBe(true);
    expect(out.get('b')).toBe(1);
    expect(out.get('t')).toEqual(Timestamp.fromSeconds(1700000000));
  });

  describe('on_error', () => {
    it('keep: leaves the field untouched and still emits the event', async () => {
      const { transform, harness } = await buildTransform(remapFieldsTransform, {
        operations: [{ op: 'coerce', field: 'missing', to: 'int' }],
        on_error: 'keep',
      });
      const event = logEvent({ a: 1 });
      transform.process([event], harness.out);
      expect(harness.pushed).toHaveLength(1);
      expect(harness.pushed[0]!.port).toBe('_default');
    });

    it('route: sends the event to the errors port instead of default', async () => {
      const { transform, harness } = await buildTransform(remapFieldsTransform, {
        operations: [{ op: 'rename', from: 'missing', to: 'x' }],
        on_error: 'route',
      });
      const event = logEvent({ a: 1 });
      transform.process([event], harness.out);
      expect(harness.pushed).toHaveLength(1);
      expect(harness.pushed[0]!.port).toBe(ERROR_PORT);
    });

    it('drop: finishes the finalizer as rejected and pushes nothing', async () => {
      const { transform, harness } = await buildTransform(remapFieldsTransform, {
        operations: [{ op: 'rename', from: 'missing', to: 'x' }],
        on_error: 'drop',
      });
      const event = logEvent({ a: 1 });
      const batch = sealedBatch([event]);
      transform.process([event], harness.out);
      expect(harness.pushed).toHaveLength(0);
      await expect(batch.completion).resolves.toBe('rejected');
    });
  });

  it('declares the errors port only when on_error is route', () => {
    const optsRoute = remapFieldsTransform.options.parse({
      operations: [{ op: 'delete', field: 'x' }],
      on_error: 'route',
    });
    const optsKeep = remapFieldsTransform.options.parse({
      operations: [{ op: 'delete', field: 'x' }],
      on_error: 'keep',
    });
    expect(remapFieldsTransform.outputs?.(optsRoute)).toEqual([
      { name: ERROR_PORT, description: expect.any(String) as string },
    ]);
    expect(remapFieldsTransform.outputs?.(optsKeep)).toEqual([]);
  });

  it('finishes every event exactly once across a mixed batch', async () => {
    const { transform, harness } = await buildTransform(remapFieldsTransform, {
      operations: [{ op: 'coerce', field: 'n', to: 'int' }],
      on_error: 'drop',
    });
    const ok = logEvent({ n: '5' });
    const bad = logEvent({ other: 1 });
    const batch = sealedBatch([ok, bad]);
    transform.process([ok, bad], harness.out);
    expect(harness.pushed).toHaveLength(1);
    for (const p of harness.pushed) p.event.metadata.finalizers.finish('delivered');
    await expect(batch.completion).resolves.toBe('rejected'); // worst status across the batch
  });
});
