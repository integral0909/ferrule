import { describe, expect, it } from 'vitest';
import type { MetricEvent } from '@ferrule/core';
import { metricTagsTransform } from '@ferrule/operators';
import { buildTransform, counterMetric } from './helpers.js';

describe('metric_tags', () => {
  it('adds constant and templated tags', async () => {
    const { transform, harness } = await buildTransform(metricTagsTransform, {
      add_tags: { env: 'prod', copy_of_name: '{name}' },
    });
    transform.process([counterMetric('reqs', 1)], harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.series.tags.get('env')).toBe('prod');
    expect(out.series.tags.get('copy_of_name')).toBe('reqs');
  });

  it('removes tags', async () => {
    const { transform, harness } = await buildTransform(metricTagsTransform, {
      remove_tags: ['secret'],
    });
    transform.process([counterMetric('reqs', 1, { secret: 'x', keep: 'y' })], harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.series.tags.has('secret')).toBe(false);
    expect(out.series.tags.get('keep')).toBe('y');
  });

  it('renames tags, preserving the value', async () => {
    const { transform, harness } = await buildTransform(metricTagsTransform, {
      rename_tags: { host: 'hostname' },
    });
    transform.process([counterMetric('reqs', 1, { host: 'a.example' })], harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.series.tags.has('host')).toBe(false);
    expect(out.series.tags.get('hostname')).toBe('a.example');
  });

  it('renames the metric and sets a namespace', async () => {
    const { transform, harness } = await buildTransform(metricTagsTransform, {
      rename_metric: '{name}_v2',
      set_namespace: 'infra',
    });
    transform.process([counterMetric('reqs', 1)], harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.series.name).toBe('reqs_v2');
    expect(out.series.namespace).toBe('infra');
  });

  it('applies operations in order: remove, then rename, then add', async () => {
    const { transform, harness } = await buildTransform(metricTagsTransform, {
      remove_tags: ['a'],
      rename_tags: { b: 'a' },
      add_tags: { c: '{tags.a}' },
    });
    transform.process([counterMetric('m', 1, { a: 'old', b: 'new' })], harness.out);
    const out = harness.pushed[0]!.event as MetricEvent;
    expect(out.series.tags.get('a')).toBe('new');
    expect(out.series.tags.get('c')).toBe('new');
  });
});
