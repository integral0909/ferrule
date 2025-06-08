import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RetryPolicy } from '@ferrule/runtime';

describe('RetryPolicy', () => {
  it('caps the delay at maxDelayMs regardless of attempt count', () => {
    const policy = new RetryPolicy({
      initialDelayMs: 100,
      multiplier: 10,
      maxDelayMs: 1_000,
      random: () => 1,
    });
    const decision = policy.next(5, 0);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBeLessThanOrEqual(1_000);
  });

  it('full jitter produces a delay uniformly within [0, cap]', () => {
    const policy = new RetryPolicy({ initialDelayMs: 100, multiplier: 2, random: () => 0.5 });
    expect(policy.next(1, 0).delayMs).toBeCloseTo(50, 5); // cap = 100
    expect(policy.next(2, 0).delayMs).toBeCloseTo(100, 5); // cap = 200
  });

  it('stops retrying once maxAttempts is reached', () => {
    const policy = new RetryPolicy({ maxAttempts: 3 });
    expect(policy.next(1, 0).shouldRetry).toBe(true);
    expect(policy.next(2, 0).shouldRetry).toBe(true);
    expect(policy.next(3, 0).shouldRetry).toBe(false);
  });

  it('stops retrying once maxElapsedMs is reached', () => {
    const policy = new RetryPolicy({ maxElapsedMs: 1_000 });
    expect(policy.next(1, 999).shouldRetry).toBe(true);
    expect(policy.next(1, 1_000).shouldRetry).toBe(false);
  });

  it('never returns a delay shorter than a server-provided retryAfterMs', () => {
    const policy = new RetryPolicy({ initialDelayMs: 10, random: () => 0 });
    const decision = policy.next(1, 0, 5_000);
    expect(decision.delayMs).toBeGreaterThanOrEqual(5_000);
  });

  it('delay is always within [0, cap] for any attempt and random draw (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, r) => {
          const policy = new RetryPolicy({
            initialDelayMs: 50,
            maxDelayMs: 5_000,
            multiplier: 2,
            random: () => r,
          });
          const decision = policy.next(attempt, 0);
          if (decision.shouldRetry) {
            expect(decision.delayMs).toBeGreaterThanOrEqual(0);
            expect(decision.delayMs).toBeLessThanOrEqual(5_000);
          }
        },
      ),
    );
  });
});
