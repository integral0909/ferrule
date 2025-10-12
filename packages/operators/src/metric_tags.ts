import type { Event, MetricEvent } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import { defineTransform, DEFAULT_PORT, type TransformOutput } from '@ferrule/runtime';
import { getEventField } from './util/fields.js';
import { compileTemplate } from './util/template.js';

/**
 * `metric_tags` — the metric-metadata equivalent of `remap_fields`: add, remove, or rename tags,
 * rename the metric, or move it to a namespace. Operations are applied in a fixed order —
 * `remove_tags`, then `rename_tags`, then `add_tags`, then `rename_metric` / `set_namespace` —
 * so a rename can reuse a tag that a preceding `add_tags` just introduced.
 *
 * `add_tags` values and `rename_metric` / `set_namespace` are `{field.path}` templates (see
 * `log_to_metric`), rendered against the metric's own `name`, `namespace`, and `tags.<key>`
 * (using the pre-operation values), so e.g. `set_namespace: "{namespace}_v2"` works.
 */

export const metricTagsOptions = s.object({
  add_tags: s
    .record(s.string())
    .default(new Map())
    .describe('tag name -> value template to add or overwrite'),
  remove_tags: s.array(s.string(), {}).default([]).describe('tag names to remove'),
  rename_tags: s.record(s.string()).default(new Map()).describe('old tag name -> new tag name'),
  rename_metric: s.string().optional().describe('new metric name template'),
  set_namespace: s.string().optional().describe('new namespace template'),
});

export type MetricTagsOptions = Infer<typeof metricTagsOptions>;

export const metricTagsTransform = defineTransform<MetricTagsOptions>({
  kind: 'transform',
  type: 'metric_tags',
  description: 'Adds, removes, or renames metric tags; renames metrics; sets a namespace.',
  options: metricTagsOptions,
  accepts: ['metric'],
  examples: [
    {
      title: 'Namespace and relabel host metrics',
      config: {
        set_namespace: 'infra',
        rename_tags: { host: 'hostname' },
        add_tags: { env: 'production' },
        remove_tags: ['internal_id'],
      },
    },
  ],
  build: (options) => {
    const addTags = [...options.add_tags.entries()].map(
      ([k, v]) => [k, compileTemplate(v)] as const,
    );
    const renameMetric =
      options.rename_metric === undefined ? undefined : compileTemplate(options.rename_metric);
    const setNamespace =
      options.set_namespace === undefined ? undefined : compileTemplate(options.set_namespace);

    return {
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          const metric = event as MetricEvent;
          const get = (
            path: Parameters<typeof getEventField>[1],
          ): ReturnType<typeof getEventField> => getEventField(metric, path);

          for (const key of options.remove_tags) metric.series.tags.delete(key);

          for (const [from, to] of options.rename_tags.entries()) {
            if (!metric.series.tags.has(from)) continue;
            const value = metric.series.tags.get(from)!;
            metric.series.tags.delete(from);
            metric.series.tags.set(to, value);
          }

          for (const [key, template] of addTags) metric.series.tags.set(key, template.render(get));

          if (renameMetric !== undefined) metric.series.name = renameMetric.render(get);
          if (setNamespace !== undefined) metric.series.namespace = setNamespace.render(get);

          out.push(metric, DEFAULT_PORT);
        }
      },
    };
  },
});
