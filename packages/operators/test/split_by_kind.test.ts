import { describe, expect, it } from 'vitest';
import { splitByKindTransform } from '@ferrule/operators';
import { buildTransform, counterMetric, logEvent, spanEvent } from './helpers.js';

describe('split_by_kind', () => {
  it('routes each event kind to its default port', async () => {
    const { transform, harness } = await buildTransform(splitByKindTransform, {});
    transform.process([logEvent({}), counterMetric('m', 1), spanEvent({})], harness.out);
    expect(harness.pushed.map((p) => p.port)).toEqual(['logs', 'metrics', 'spans']);
  });

  it('uses custom port names when configured', async () => {
    const { transform, harness } = await buildTransform(splitByKindTransform, {
      log_port: 'l',
      metric_port: 'm',
      span_port: 's',
    });
    transform.process([logEvent({}), counterMetric('x', 1), spanEvent({})], harness.out);
    expect(harness.pushed.map((p) => p.port)).toEqual(['l', 'm', 's']);
  });

  it('declares exactly the three configured ports', () => {
    const options = splitByKindTransform.options.parse({});
    expect(splitByKindTransform.outputs?.(options)).toEqual([
      { name: 'logs', description: expect.any(String) as string },
      { name: 'metrics', description: expect.any(String) as string },
      { name: 'spans', description: expect.any(String) as string },
    ]);
  });
});
