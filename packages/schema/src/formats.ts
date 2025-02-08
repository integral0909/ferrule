import { FerruleError, parseByteSize, parseDuration, parsePath, type Path } from '@ferrule/core';
import { describeInput } from './issues.js';
import type { invalid } from './schema.js';
import { type ParseContext, Schema, type SchemaDoc } from './schema.js';

type Result<T> = T | typeof invalid;

export interface DurationOptions {
  /** Minimum duration in milliseconds (inclusive). */
  minMs?: number;
  /** Maximum duration in milliseconds (inclusive). */
  maxMs?: number;
}

/**
 * A duration, written either as a string (`"250ms"`, `"1h30m"`) or as a number of milliseconds.
 * Output is milliseconds; sub-millisecond precision is rounded down.
 */
export class DurationSchema extends Schema<number> {
  constructor(private readonly options: DurationOptions = {}) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<number> {
    let ms: number;
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || input < 0) {
        return ctx.report(
          'invalid_format',
          'duration must be a non-negative number of milliseconds',
        );
      }
      ms = input;
    } else if (typeof input === 'string') {
      try {
        ms = Number(parseDuration(input) / 1_000_000n);
      } catch (error) {
        return ctx.report(
          'invalid_format',
          errorMessage(error),
          'use a value like "500ms", "30s", or "1h30m"',
        );
      }
    } else {
      return ctx.report('invalid_type', `expected a duration, got ${describeInput(input)}`);
    }
    const { minMs, maxMs } = this.options;
    if (minMs !== undefined && ms < minMs) {
      return ctx.report('too_small', `must be at least ${minMs}ms`);
    }
    if (maxMs !== undefined && ms > maxMs) {
      return ctx.report('too_big', `must be at most ${maxMs}ms`);
    }
    return ms;
  }

  protected docBase(): SchemaDoc {
    const doc: SchemaDoc = { type: 'duration' };
    if (this.options.minMs !== undefined || this.options.maxMs !== undefined) {
      doc.constraints = { ...this.options };
    }
    return doc;
  }
}

export interface ByteSizeOptions {
  min?: number;
  max?: number;
}

/** A size in bytes, written as a number or a string such as `"64MiB"`. */
export class ByteSizeSchema extends Schema<number> {
  constructor(private readonly options: ByteSizeOptions = {}) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<number> {
    let bytes: number;
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input) || input < 0) {
        return ctx.report('invalid_format', 'byte size must be a non-negative integer');
      }
      bytes = input;
    } else if (typeof input === 'string') {
      try {
        bytes = parseByteSize(input);
      } catch (error) {
        return ctx.report(
          'invalid_format',
          errorMessage(error),
          'use a value like "512KiB", "64MiB", or "1GB"',
        );
      }
    } else {
      return ctx.report('invalid_type', `expected a byte size, got ${describeInput(input)}`);
    }
    if (this.options.min !== undefined && bytes < this.options.min) {
      return ctx.report('too_small', `must be at least ${this.options.min} bytes`);
    }
    if (this.options.max !== undefined && bytes > this.options.max) {
      return ctx.report('too_big', `must be at most ${this.options.max} bytes`);
    }
    return bytes;
  }

  protected docBase(): SchemaDoc {
    return { type: 'byte_size' };
  }
}

export interface SocketAddress {
  host: string;
  port: number;
}

/**
 * A `host:port` listen or connect address. IPv6 hosts use brackets (`[::1]:8080`). Port 0 is
 * allowed only when `allowEphemeralPort` is set (useful in tests).
 */
export class SocketAddressSchema extends Schema<SocketAddress> {
  constructor(private readonly allowEphemeralPort = false) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<SocketAddress> {
    if (typeof input !== 'string') {
      return ctx.report(
        'invalid_type',
        `expected an address like "0.0.0.0:8080", got ${describeInput(input)}`,
      );
    }
    const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(input);
    if (m === null) {
      return ctx.report(
        'invalid_format',
        `invalid address ${JSON.stringify(input)}; expected host:port`,
      );
    }
    const host = m[1] ?? m[2]!;
    const port = Number(m[3]);
    if (port > 65535 || (port === 0 && !this.allowEphemeralPort)) {
      return ctx.report('invalid_format', `invalid port ${port}`);
    }
    return { host, port };
  }

  protected docBase(): SchemaDoc {
    return { type: 'socket_address' };
  }
}

export interface UrlOptions {
  /** Allowed protocols without the trailing colon, e.g. `['http', 'https']`. */
  protocols?: readonly string[];
}

/** An absolute URL. Output is the normalised URL string. Credentials embedded in URLs are rejected. */
export class UrlSchema extends Schema<string> {
  constructor(private readonly options: UrlOptions = {}) {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<string> {
    if (typeof input !== 'string') {
      return ctx.report('invalid_type', `expected a URL, got ${describeInput(input)}`);
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return ctx.report('invalid_format', `invalid URL ${JSON.stringify(input)}`);
    }
    const protocol = url.protocol.slice(0, -1);
    const { protocols } = this.options;
    if (protocols !== undefined && !protocols.includes(protocol)) {
      return ctx.report(
        'invalid_format',
        `URL scheme must be one of ${protocols.join(', ')}; got ${protocol}`,
      );
    }
    if (url.username !== '' || url.password !== '') {
      return ctx.report(
        'invalid_format',
        'URLs must not embed credentials',
        'use the auth options so the secret can be redacted',
      );
    }
    return url.toString();
  }

  protected docBase(): SchemaDoc {
    const doc: SchemaDoc = { type: 'url' };
    if (this.options.protocols !== undefined) {
      doc.constraints = { protocols: [...this.options.protocols] };
    }
    return doc;
  }
}

/** A Ferrule field path such as `.http.status` or `tags[0]`. */
export class FieldPathSchema extends Schema<Path> {
  check(input: unknown, ctx: ParseContext): Result<Path> {
    if (typeof input !== 'string') {
      return ctx.report('invalid_type', `expected a field path, got ${describeInput(input)}`);
    }
    try {
      return parsePath(input);
    } catch (error) {
      return ctx.report('invalid_format', errorMessage(error));
    }
  }

  protected docBase(): SchemaDoc {
    return { type: 'field_path' };
  }
}

/** A regular expression source string, compiled once at validation time. */
export class RegexSchema extends Schema<RegExp> {
  constructor(private readonly flags = '') {
    super();
  }

  check(input: unknown, ctx: ParseContext): Result<RegExp> {
    if (typeof input !== 'string') {
      return ctx.report(
        'invalid_type',
        `expected a regular expression, got ${describeInput(input)}`,
      );
    }
    try {
      return new RegExp(input, this.flags);
    } catch (error) {
      return ctx.report('invalid_format', `invalid regular expression: ${errorMessage(error)}`);
    }
  }

  protected docBase(): SchemaDoc {
    return { type: 'regex' };
  }
}

/** A component ID: lowercase letters, digits, `_` and `-`, starting with a letter. */
export const COMPONENT_ID = /^[a-z][a-z0-9_-]{0,127}$/;

function errorMessage(error: unknown): string {
  if (error instanceof FerruleError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
