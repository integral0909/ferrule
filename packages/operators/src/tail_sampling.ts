import { toHex, type Event, type SpanEvent } from '@ferrule/core';
import { s, type Infer, type Schema } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  type TransformContext,
  type TransformOutput,
} from '@ferrule/runtime';
import { conditionSchema, evaluateCondition, type ConditionSpec } from './util/condition.js';
import { getEventField } from './util/fields.js';
import { hashBytes, unitInterval } from './util/hash.js';
import { LruCache } from './util/lru.js';
import { refillRatePerMs, TokenBucket } from './util/token-bucket.js';

/**
 * `tail_sampling` — buffers spans per trace ID until the trace looks complete (a root span has
 * been seen and no new span has arrived for `quiet_period`) or `decision_wait` elapses, then
 * decides whether to keep the whole trace using composable policies, combined with OR (the trace
 * is sampled if *any* top-level policy says so). A late span for an already-decided trace
 * follows the cached decision rather than reopening it; the decision cache itself is bounded
 * (`decision_cache_size`, LRU), so a trace that falls out of it is treated as new.
 *
 * Memory is bounded three ways: `max_spans_per_trace` forces an early decision for one runaway
 * trace (using whatever spans it has so far — later spans for it then follow that decision, like
 * any other late arrival); `max_bytes` forces early decisions for the least-recently-active
 * traces when the *total* buffered size crosses the limit; `max_traces` LRU-evicts the
 * least-recently-active trace (also via an early decision) once too many are open at once. None
 * of these lose spans — they only decide earlier than `quiet_period`/`decision_wait` would have.
 */

const policyBase = () => ({});

function tailSamplingPolicySchemaImpl(): Schema<TailSamplingPolicy> {
  return s
    .tagged('type', {
      status_error: s.object({ ...policyBase() }).describe('sample if any span has status: error'),
      latency: s.object({
        threshold: s.duration({ minMs: 1 }).describe('minimum span duration to trigger sampling'),
        scope: s.enum(['root', 'any'] as const).default('root'),
      }),
      probabilistic: s.object({
        rate: s.number({ min: 0, max: 1 }).describe('fraction of traces to sample, by trace ID'),
      }),
      attribute: s.object({
        condition: conditionSchema().describe('e.g. { type: "attributes.http.status_code" }'),
        scope: s.enum(['root', 'any'] as const).default('any'),
      }),
      rate_limit: s.object({
        spans_per_second: s.number({ greaterThan: 0 }).describe('shared budget across all traces'),
      }),
      and: s.object({ policies: s.array(s.lazy(tailSamplingPolicySchemaImpl), { minItems: 1 }) }),
      or: s.object({ policies: s.array(s.lazy(tailSamplingPolicySchemaImpl), { minItems: 1 }) }),
      not: s.object({ policy: s.lazy(tailSamplingPolicySchemaImpl) }),
    })
    .describe('a tail-sampling policy; top-level policies combine with OR');
}

export type TailSamplingPolicy =
  | { readonly type: 'status_error' }
  | { readonly type: 'latency'; readonly threshold: number; readonly scope: 'root' | 'any' }
  | { readonly type: 'probabilistic'; readonly rate: number }
  | {
      readonly type: 'attribute';
      readonly condition: ConditionSpec;
      readonly scope: 'root' | 'any';
    }
  | { readonly type: 'rate_limit'; readonly spans_per_second: number }
  | { readonly type: 'and'; readonly policies: readonly TailSamplingPolicy[] }
  | { readonly type: 'or'; readonly policies: readonly TailSamplingPolicy[] }
  | { readonly type: 'not'; readonly policy: TailSamplingPolicy };

export const tailSamplingOptions = s.object({
  decision_wait: s
    .duration({ minMs: 1 })
    .default(5000)
    .describe('force a decision this long after a trace is first seen, root span or not'),
  quiet_period: s
    .duration({ minMs: 1 })
    .default(2000)
    .describe('once a root span has been seen, decide this long after the most recent span'),
  max_traces: s.integer({ min: 1 }).default(50_000).describe('maximum traces buffered at once'),
  max_spans_per_trace: s
    .integer({ min: 1 })
    .default(10_000)
    .describe('maximum spans buffered per trace'),
  max_bytes: s
    .byteSize()
    .default(256 * 1024 * 1024)
    .describe('maximum total estimated size of buffered spans'),
  decision_cache_size: s
    .integer({ min: 1 })
    .default(200_000)
    .describe('decisions remembered for late-arriving spans (LRU-evicted beyond this)'),
  policies: s
    .array(tailSamplingPolicySchemaImpl(), {})
    .default([])
    .describe('sampling policies, combined with OR; an empty list samples every trace'),
});

export type TailSamplingOptions = Infer<typeof tailSamplingOptions>;

interface TraceState {
  readonly traceIdHex: string;
  readonly traceIdBytes: Uint8Array;
  readonly spans: SpanEvent[];
  rootSeen: boolean;
  bytes: number;
  firstSeenMonoMs: number;
  lastSeenMonoMs: number;
}

function spanAccessor(span: SpanEvent) {
  return (path: Parameters<typeof getEventField>[1]): ReturnType<typeof getEventField> =>
    getEventField(span, path);
}

function evaluatePolicy(
  policy: TailSamplingPolicy,
  trace: TraceState,
  env: { rateLimiter: TokenBucket; nowMs: number },
): boolean {
  switch (policy.type) {
    case 'status_error':
      return trace.spans.some((span) => span.status.code === 'error');
    case 'latency': {
      const spans = policy.scope === 'root' ? trace.spans.filter((s) => s.isRoot) : trace.spans;
      return spans.some((span) => Number(span.durationNanos) / 1_000_000 >= policy.threshold);
    }
    case 'probabilistic':
      return unitInterval(hashBytes(trace.traceIdBytes)) < policy.rate;
    case 'attribute': {
      const spans = policy.scope === 'root' ? trace.spans.filter((s) => s.isRoot) : trace.spans;
      return spans.some((span) => evaluateCondition(policy.condition, spanAccessor(span)));
    }
    case 'rate_limit':
      return env.rateLimiter.tryRemove(trace.spans.length, env.nowMs);
    case 'and':
      return policy.policies.every((p) => evaluatePolicy(p, trace, env));
    case 'or':
      return policy.policies.some((p) => evaluatePolicy(p, trace, env));
    case 'not':
      return !evaluatePolicy(policy.policy, trace, env);
  }
}

export const tailSamplingTransform = defineTransform<TailSamplingOptions>({
  kind: 'transform',
  type: 'tail_sampling',
  description: 'Buffers spans per trace and samples whole traces using composable policies.',
  options: tailSamplingOptions,
  accepts: ['span'],
  examples: [
    {
      title: 'Always keep errors and slow traces; sample 5% of the rest',
      config: {
        decision_wait: '10s',
        quiet_period: '3s',
        policies: [
          { type: 'status_error' },
          { type: 'latency', threshold: '500ms', scope: 'any' },
          { type: 'probabilistic', rate: 0.05 },
        ],
      },
    },
  ],
  build: (options) => {
    let ctx!: TransformContext;
    // A shared budget for the `rate_limit` policy type, if any policy uses one; unused (and
    // harmless) otherwise.
    const rateLimitCapacity = findRateLimitCapacity(options.policies) || 1;
    let rateLimiter!: TokenBucket;

    const decisionCache = new LruCache<boolean>({ maxSize: options.decision_cache_size });
    let totalBytes = 0;
    let currentOut: TransformOutput | undefined;

    const decide = (trace: TraceState): boolean => {
      if (options.policies.length === 0) return true;
      const nowMs = ctx.clock.monotonic();
      return options.policies.some((p) => evaluatePolicy(p, trace, { rateLimiter, nowMs }));
    };

    const decideAndFlush = (trace: TraceState, out: TransformOutput): void => {
      const sampled = decide(trace);
      decisionCache.set(trace.traceIdHex, sampled);
      ctx.metrics
        .counter('tail_sampling_decisions_total', { decision: sampled ? 'sampled' : 'dropped' })
        .increment();
      for (const span of trace.spans) {
        if (sampled) out.push(span, DEFAULT_PORT);
        else span.metadata.finalizers.finish('delivered');
      }
    };

    const traces = new LruCache<TraceState>({
      maxSize: options.max_traces,
      onEvict: (_key, trace) => {
        ctx.metrics.counter('tail_sampling_evictions_total', { reason: 'max_traces' }).increment();
        if (currentOut !== undefined) decideAndFlush(trace, currentOut);
      },
    });

    const removeTrace = (trace: TraceState): void => {
      traces.delete(trace.traceIdHex);
      totalBytes -= trace.bytes;
    };

    const enforceByteBudget = (out: TransformOutput): void => {
      while (totalBytes > options.max_bytes) {
        const oldest = traces.oldest();
        if (oldest === undefined) return;
        const [, trace] = oldest;
        removeTrace(trace);
        ctx.metrics.counter('tail_sampling_evictions_total', { reason: 'max_bytes' }).increment();
        decideAndFlush(trace, out);
      }
    };

    return {
      start(context) {
        ctx = context;
        rateLimiter = new TokenBucket(
          rateLimitCapacity,
          refillRatePerMs(rateLimitCapacity, 1000),
          ctx.clock.monotonic(),
        );
      },
      process(events: Event[], out: TransformOutput) {
        currentOut = out;
        const nowMs = ctx.clock.monotonic();
        for (const event of events) {
          const span = event as SpanEvent;
          const traceIdHex = toHex(span.traceId);
          const cached = decisionCache.get(traceIdHex);
          if (cached !== undefined) {
            ctx.metrics.counter('tail_sampling_late_spans_total').increment();
            if (cached) out.push(span, DEFAULT_PORT);
            else span.metadata.finalizers.finish('delivered');
            continue;
          }

          let trace = traces.get(traceIdHex);
          if (trace === undefined) {
            trace = {
              traceIdHex,
              traceIdBytes: span.traceId,
              spans: [],
              rootSeen: false,
              bytes: 0,
              firstSeenMonoMs: nowMs,
              lastSeenMonoMs: nowMs,
            };
            traces.set(traceIdHex, trace);
          }

          if (trace.spans.length >= options.max_spans_per_trace) {
            removeTrace(trace);
            ctx.metrics
              .counter('tail_sampling_evictions_total', { reason: 'max_spans_per_trace' })
              .increment();
            decideAndFlush(trace, out);
            const decision = decisionCache.get(traceIdHex)!;
            if (decision) out.push(span, DEFAULT_PORT);
            else span.metadata.finalizers.finish('delivered');
            continue;
          }

          const size = span.estimatedSize();
          trace.spans.push(span);
          trace.bytes += size;
          totalBytes += size;
          if (span.isRoot) trace.rootSeen = true;
          trace.lastSeenMonoMs = nowMs;
          enforceByteBudget(out);
        }
        ctx.metrics.gauge('tail_sampling_active_traces').set(traces.size);
        currentOut = undefined;
      },
      tickIntervalMs: Math.max(1, Math.min(options.quiet_period, options.decision_wait)),
      tick(_now, out) {
        currentOut = out;
        const nowMs = ctx.clock.monotonic();
        for (const [, trace] of [...traces.entries()]) {
          const waited = nowMs - trace.firstSeenMonoMs;
          const quiet = nowMs - trace.lastSeenMonoMs;
          if (
            (trace.rootSeen && quiet >= options.quiet_period) ||
            waited >= options.decision_wait
          ) {
            removeTrace(trace);
            decideAndFlush(trace, out);
          }
        }
        ctx.metrics.gauge('tail_sampling_active_traces').set(traces.size);
        currentOut = undefined;
      },
      flush(out) {
        currentOut = out;
        for (const [, trace] of [...traces.entries()]) {
          removeTrace(trace);
          decideAndFlush(trace, out);
        }
        currentOut = undefined;
      },
    };
  },
});

function findRateLimitCapacity(policies: readonly TailSamplingPolicy[]): number {
  for (const policy of policies) {
    if (policy.type === 'rate_limit') return Math.max(1, policy.spans_per_second);
    if (policy.type === 'and' || policy.type === 'or') {
      const nested = findRateLimitCapacity(policy.policies);
      if (nested > 0) return nested;
    }
    if (policy.type === 'not') {
      const nested = findRateLimitCapacity([policy.policy]);
      if (nested > 0) return nested;
    }
  }
  return 0;
}
