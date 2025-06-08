import type { Clock, LogLevel, Logger } from './component.js';
import { SystemClock } from './clock.js';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** A minimal subset of `NodeJS.WritableStream` this module needs. */
export interface LogSink {
  write(chunk: string): unknown;
}

export type LogFormat = 'json' | 'pretty';

export interface RateLimitOptions {
  /** Window over which repeats of the same message are counted. */
  intervalMs: number;
  /** How many occurrences of an identical (level, message) pair are emitted per window before
   * later ones are suppressed and rolled up into a summary line at the end of the window. */
  burst: number;
}

export interface LoggerOptions {
  /** Minimum level emitted. Default `info`. */
  level?: LogLevel;
  format?: LogFormat;
  /** Where formatted lines are written. Default `process.stdout`. */
  sink?: LogSink;
  clock?: Clock;
  rateLimit?: RateLimitOptions;
  /** Fields attached to every record, e.g. component identity. */
  fields?: Record<string, unknown>;
}

interface RateLimitState {
  windowStart: number;
  emitted: number;
  suppressed: number;
}

/**
 * A structured logger that writes JSON-lines or human-readable lines to a {@link LogSink}.
 * Repeated identical (level, message) pairs can be rate-limited: after `burst` occurrences within
 * `intervalMs`, further ones are counted rather than written, and a summary is emitted the next
 * time that window is crossed.
 */
export class RuntimeLogger implements Logger {
  private readonly level: LogLevel;
  private readonly format: LogFormat;
  private readonly sink: LogSink;
  private readonly clock: Clock;
  private readonly rateLimit: RateLimitOptions | undefined;
  private readonly fields: Record<string, unknown>;
  /** Shared across child loggers derived from the same root, so limits apply pipeline-wide. */
  private readonly rateLimitState: Map<string, RateLimitState>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.format = options.format ?? 'json';
    this.sink = options.sink ?? processStdoutSink();
    this.clock = options.clock ?? new SystemClock();
    this.rateLimit = options.rateLimit;
    this.fields = options.fields ?? {};
    this.rateLimitState = new Map();
  }

  private constructChild(
    fields: Record<string, unknown>,
    state: Map<string, RateLimitState>,
  ): RuntimeLogger {
    const child = Object.create(RuntimeLogger.prototype) as RuntimeLogger;
    Object.assign(child, {
      level: this.level,
      format: this.format,
      sink: this.sink,
      clock: this.clock,
      rateLimit: this.rateLimit,
      fields: { ...this.fields, ...fields },
      rateLimitState: state,
    });
    return child;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }

  child(fields: Record<string, unknown>): Logger {
    return this.constructChild(fields, this.rateLimitState);
  }

  private log(level: LogLevel, message: string, fields: Record<string, unknown> | undefined): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    if (this.rateLimit !== undefined && !this.admit(level, message)) return;
    const merged = fields === undefined ? this.fields : { ...this.fields, ...fields };
    this.write(level, message, merged);
  }

  /** Applies the rate limit; returns whether this occurrence should be emitted. */
  private admit(level: LogLevel, message: string): boolean {
    const rateLimit = this.rateLimit!;
    const key = `${level}\u0000${message}`;
    const now = this.clock.monotonic();
    let state = this.rateLimitState.get(key);
    if (state === undefined || now - state.windowStart >= rateLimit.intervalMs) {
      if (state !== undefined && state.suppressed > 0) {
        this.write('warn', `suppressed ${state.suppressed} repeat(s) of a rate-limited message`, {
          ...this.fields,
          originalMessage: message,
          originalLevel: level,
        });
      }
      state = { windowStart: now, emitted: 0, suppressed: 0 };
      this.rateLimitState.set(key, state);
    }
    if (state.emitted < rateLimit.burst) {
      state.emitted++;
      return true;
    }
    state.suppressed++;
    return false;
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    const time = this.clock.now().toISOString();
    if (this.format === 'json') {
      this.sink.write(`${JSON.stringify({ time, level, message, ...serializeFields(fields) })}\n`);
      return;
    }
    const suffix = Object.keys(fields).length === 0 ? '' : ` ${formatFieldsPretty(fields)}`;
    this.sink.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
  }
}

function serializeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = toJsonSafe(value);
  return out;
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function formatFieldsPretty(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${formatValuePretty(v)}`)
    .join(' ');
}

function formatValuePretty(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return JSON.stringify(value.message);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(toJsonSafe(value));
  } catch {
    return '[unserializable value]';
  }
}

function processStdoutSink(): LogSink {
  return { write: (chunk: string) => process.stdout.write(chunk) };
}

/** Convenience constructor; see {@link RuntimeLogger}. */
export function createLogger(options?: LoggerOptions): Logger {
  return new RuntimeLogger(options);
}

/** A logger that writes nothing. Useful as a default when the caller doesn't care about logs. */
export function createNullLogger(): Logger {
  return createLogger({ sink: { write: () => undefined }, level: 'error' });
}
