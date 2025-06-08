import { describe, expect, it } from 'vitest';
import { ManualClock, MetricsRegistry } from '@ferrule/runtime';

describe('MetricsRegistry', () => {
  it('counters accumulate across calls', () => {
    const registry = new MetricsRegistry();
    const c = registry.counter('requests_total');
    c.increment();
    c.increment(4);
    const [snap] = registry.snapshot();
    expect(snap?.value).toEqual({ type: 'counter', value: 5 });
  });

  it('caches instruments by name and tags', () => {
    const registry = new MetricsRegistry();
    const a = registry.counter('x', { region: 'eu' });
    const b = registry.counter('x', { region: 'eu' });
    const c = registry.counter('x', { region: 'us' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('gauges set and add', () => {
    const registry = new MetricsRegistry();
    const g = registry.gauge('queue_depth');
    g.set(10);
    g.add(-3);
    const [snap] = registry.snapshot();
    expect(snap?.value).toEqual({ type: 'gauge', value: 7 });
  });

  it('histograms bucket observations using default latency buckets', () => {
    const registry = new MetricsRegistry();
    const h = registry.histogram('duration_seconds');
    for (const v of [0.001, 0.02, 0.02, 100]) h.record(v);
    const [snap] = registry.snapshot();
    expect(snap?.value.type).toBe('histogram');
    if (snap?.value.type !== 'histogram') throw new Error('expected histogram');
    expect(snap.value.count).toBe(4);
    expect(snap.value.sum).toBeCloseTo(100.041, 5);
    const total = snap.value.buckets.reduce((sum, b) => sum + b.count, 0);
    // The +Inf tail (values above the last bucket) is not counted in the buckets themselves.
    expect(total).toBe(3);
  });

  it('honors custom histogram buckets registered before first use', () => {
    const registry = new MetricsRegistry();
    registry.defineHistogramBuckets('bytes', [10, 100, 1000]);
    const h = registry.histogram('bytes');
    h.record(5);
    h.record(50);
    h.record(500);
    h.record(5000);
    const [snap] = registry.snapshot();
    if (snap?.value.type !== 'histogram') throw new Error('expected histogram');
    expect(snap.value.buckets.map((b) => b.upperLimit)).toEqual([10, 100, 1000]);
    expect(snap.value.buckets.map((b) => b.count)).toEqual([1, 1, 1]);
  });

  it('forComponent tags every metric with component identity automatically', () => {
    const registry = new MetricsRegistry();
    const scoped = registry.forComponent('my_sink', 'sink', 'http');
    scoped.counter('component_sent_events_total').increment(3);
    const [snap] = registry.snapshot();
    expect(snap?.tags.get('component_id')).toBe('my_sink');
    expect(snap?.tags.get('component_kind')).toBe('sink');
    expect(snap?.tags.get('component_type')).toBe('http');
  });

  it('scoped() merges fixed tags with per-call tags, call tags winning on conflict', () => {
    const registry = new MetricsRegistry();
    const scoped = registry.scoped({ region: 'eu', tier: 'a' });
    scoped.counter('x', { region: 'us' }).increment();
    const [snap] = registry.snapshot();
    expect(snap?.tags.get('region')).toBe('us');
    expect(snap?.tags.get('tier')).toBe('a');
  });

  it('snapshot uses the injected clock for the timestamp', () => {
    const clock = new ManualClock({ startNanos: 123_000_000_000n });
    const registry = new MetricsRegistry({ clock });
    registry.counter('x').increment();
    const [snap] = registry.snapshot();
    expect(snap?.timestamp?.nanos).toBe(123_000_000_000n);
  });

  it('clear() removes every instrument', () => {
    const registry = new MetricsRegistry();
    registry.counter('x').increment();
    registry.clear();
    expect(registry.snapshot()).toHaveLength(0);
  });

  it('snapshot includes every distinct series', () => {
    const registry = new MetricsRegistry();
    registry.counter('a').increment();
    registry.gauge('b').set(1);
    registry.histogram('c').record(1);
    expect(registry.snapshot()).toHaveLength(3);
  });
});
