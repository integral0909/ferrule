import { describe, expect, it } from 'vitest';
import { CircuitBreaker, ManualClock } from '@ferrule/runtime';

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.currentState).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens after failureThreshold consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('closed');
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('a success resets the consecutive failure count', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('closed');
  });

  it('moves to half-open after openDurationMs and allows a limited trial', async () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1_000, clock });
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);

    await clock.advance(1_000);
    expect(breaker.currentState).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('limits concurrent half-open trials to halfOpenMaxAttempts', async () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 100,
      halfOpenMaxAttempts: 2,
      clock,
    });
    breaker.recordFailure();
    await clock.advance(100);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('a success while half-open closes the breaker', async () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 100, clock });
    breaker.recordFailure();
    await clock.advance(100);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.currentState).toBe('closed');
  });

  it('a failure while half-open reopens the breaker', async () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 100, clock });
    breaker.recordFailure();
    await clock.advance(100);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
  });
});
