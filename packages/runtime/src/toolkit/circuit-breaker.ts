import type { Clock } from '../component.js';
import { SystemClock } from '../clock.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. Default 5. */
  readonly failureThreshold?: number;
  /** How long the breaker stays open before allowing a trial call. Default 30000ms. */
  readonly openDurationMs?: number;
  /** Concurrent trial calls allowed while half-open. Default 1. */
  readonly halfOpenMaxAttempts?: number;
  readonly clock?: Clock;
}

/**
 * A classic closed / open / half-open circuit breaker. Closed lets everything through and counts
 * consecutive failures; `failureThreshold` of them trips it open, rejecting calls until
 * `openDurationMs` has passed. It then allows up to `halfOpenMaxAttempts` trial calls
 * (half-open); any failure among them reopens the circuit, and a success closes it.
 */
export class CircuitBreaker {
  private readonly clock: Clock;
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMono = 0;
  private halfOpenInFlight = 0;

  constructor(private readonly options: CircuitBreakerOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** The breaker's state, resolving an expired `open` period into `half_open` first. */
  get currentState(): CircuitState {
    this.maybeExpireOpen();
    return this.state;
  }

  /**
   * Whether a call may proceed right now. If it returns `true` while half-open, it reserves one
   * of the limited trial slots; the caller must report the outcome with {@link recordSuccess} or
   * {@link recordFailure} exactly once afterward.
   */
  tryAcquire(): boolean {
    this.maybeExpireOpen();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    const limit = this.options.halfOpenMaxAttempts ?? 1;
    if (this.halfOpenInFlight >= limit) return false;
    this.halfOpenInFlight++;
    return true;
  }

  private maybeExpireOpen(): void {
    if (this.state !== 'open') return;
    const openDurationMs = this.options.openDurationMs ?? 30_000;
    if (this.clock.monotonic() - this.openedAtMono >= openDurationMs) {
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
    }
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.state = 'closed';
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.open();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= (this.options.failureThreshold ?? 5)) this.open();
  }

  private open(): void {
    this.state = 'open';
    this.openedAtMono = this.clock.monotonic();
    this.consecutiveFailures = 0;
  }
}
