import { LogEvent, Timestamp } from '@ferrule/core';
import { RateLimiter, type CallArgs, type RunCtx, type RuntimeValue } from '@ferrule/script';
import { DEFAULT_LIMITS } from '@ferrule/script';

/** A minimal `RunCtx` for calling a `FunctionImplementation` directly in a unit test. */
export function fakeCtx(overrides: Partial<RunCtx> = {}): RunCtx {
  return {
    event: new LogEvent(),
    limits: DEFAULT_LIMITS,
    clock: () => Timestamp.now(),
    onLog: () => {},
    logLimiter: new RateLimiter(1000),
    emitted: [],
    currentSpan: { start: 0, end: 0 },
    ...overrides,
  };
}

export function args(
  positional: readonly RuntimeValue[],
  named: ReadonlyMap<string, RuntimeValue> = new Map(),
): CallArgs {
  return {
    positional,
    named,
    closures: [],
    positionalSupplied: positional.map(() => true),
  };
}
