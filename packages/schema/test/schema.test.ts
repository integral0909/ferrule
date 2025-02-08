import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  closestMatch,
  editDistance,
  formatIssuePath,
  invalid,
  REDACTED,
  s,
  SchemaValidationError,
  type Infer,
  type Issue,
} from '@ferrule/schema';

function issues(result: { ok: boolean; issues?: Issue[] }): string[] {
  if (result.ok) return [];
  return (result.issues ?? []).map(
    (i) => `${formatIssuePath(i.path)}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`,
  );
}

describe('scalars', () => {
  it('validates strings with constraints', () => {
    expect(s.string().parse('x')).toBe('x');
    expect(issues(s.string().safeParse(1))).toEqual(['(root): expected a string, got an integer']);
    expect(issues(s.string().nonEmpty().safeParse(''))).toEqual(['(root): must not be empty']);
    expect(issues(s.string({ minLength: 3 }).safeParse('ab'))).toEqual([
      '(root): must be at least 3 characters',
    ]);
    expect(issues(s.string({ maxLength: 1 }).safeParse('ab'))).toEqual([
      '(root): must be at most 1 characters',
    ]);
    expect(
      issues(s.string({ pattern: /^a/, patternName: 'a word starting with a' }).safeParse('b')),
    ).toEqual(['(root): must be a word starting with a']);
  });

  it('validates numbers and integers', () => {
    expect(s.number().parse(1.5)).toBe(1.5);
    expect(s.integer().parse(3n)).toBe(3);
    expect(issues(s.integer().safeParse(1.5))).toEqual(['(root): expected an integer, got 1.5']);
    expect(issues(s.number().safeParse(Infinity))).toEqual(['(root): expected a finite number']);
    expect(issues(s.number({ min: 1 }).safeParse(0))).toEqual([
      '(root): must be at least 1, got 0',
    ]);
    expect(issues(s.number({ max: 1 }).safeParse(2))).toEqual(['(root): must be at most 1, got 2']);
    expect(issues(s.number({ greaterThan: 0 }).safeParse(0))).toEqual([
      '(root): must be greater than 0, got 0',
    ]);
    expect(issues(s.number().safeParse('1'))).toEqual(['(root): expected a number, got a string']);
    expect(issues(s.number().safeParse(2n ** 60n))).toEqual([
      '(root): expected a number, got an integer',
    ]);
  });

  it('validates booleans, literals, and enums with suggestions', () => {
    expect(s.boolean().parse(false)).toBe(false);
    expect(issues(s.boolean().safeParse('true'))).toEqual([
      '(root): expected true or false, got a string',
    ]);
    expect(s.literal('x').parse('x')).toBe('x');
    expect(issues(s.literal(1).safeParse(2))).toEqual(['(root): expected 1, got an integer']);
    const level = s.enum(['debug', 'info', 'warn', 'error']);
    expect(level.parse('warn')).toBe('warn');
    expect(issues(level.safeParse('wran'))).toEqual([
      '(root): expected one of "debug", "info", "warn", "error", got "wran" (did you mean "warn"?)',
    ]);
    expect(issues(level.safeParse(3))).toEqual([
      '(root): expected one of "debug", "info", "warn", "error", got an integer',
    ]);
  });
});

describe('objects', () => {
  const schema = s.object({
    name: s.string(),
    port: s.integer({ min: 1, max: 65535 }).default(8080),
    tags: s.array(s.string()).optional(),
    tls: s.object({ enabled: s.boolean(), ca_file: s.string().optional() }).optional(),
  });

  it('infers precise types', () => {
    type Out = Infer<typeof schema>;
    expectTypeOf<Out>().toEqualTypeOf<{
      name: string;
      port: number;
      tags?: string[];
      tls?: { enabled: boolean; ca_file?: string };
    }>();
  });

  it('applies defaults and omits missing optional fields', () => {
    const out = schema.parse({ name: 'a' });
    expect(out).toEqual({ name: 'a', port: 8080 });
    expect(Object.keys(out)).toEqual(['name', 'port']);
  });

  it('reports every issue with its path', () => {
    const result = schema.safeParse({ port: 0, tags: ['a', 2], tls: { enabled: 'yes' }, prot: 1 });
    expect(issues(result)).toEqual([
      'name: is required',
      'port: must be at least 1, got 0',
      'tags[1]: expected a string, got an integer',
      'tls.enabled: expected true or false, got a string',
      'prot: is not a recognised option (did you mean "port"?)',
    ]);
  });

  it('throws a SchemaValidationError listing all issues', () => {
    try {
      schema.parse({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).issues).toHaveLength(1);
      expect((error as SchemaValidationError).message).toContain('name: is required');
    }
  });

  it('supports strip and passthrough for unknown keys', () => {
    const base = s.object({ a: s.integer() });
    expect(base.strip().parse({ a: 1, b: 2 })).toEqual({ a: 1 });
    expect(base.passthrough().parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(base.extend({ b: s.string() }).parse({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
  });

  it('rejects non-objects, arrays, and maps', () => {
    for (const input of [null, [], 'x', new Map()]) {
      expect(schema.safeParse(input).ok).toBe(false);
    }
  });

  it('cannot be tricked by __proto__ keys', () => {
    const input = JSON.parse('{"__proto__": {"admin": true}, "a": 1}') as unknown;
    const out = s.object({ a: s.integer() }).passthrough().parse(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as { admin?: boolean }).admin).toBeUndefined();
  });
});

describe('arrays and records', () => {
  it('validates length, uniqueness, and single-item shorthand', () => {
    const inputs = s.array(s.componentId(), { minItems: 1, acceptSingle: true, unique: true });
    expect(inputs.parse('app')).toEqual(['app']);
    expect(inputs.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(issues(inputs.safeParse([]))).toEqual(['(root): must not be empty']);
    expect(issues(inputs.safeParse(['a', 'a']))).toEqual(['[1]: duplicate item "a"']);
    expect(issues(inputs.safeParse(['Bad!']))[0]).toMatch(/^\[0\]: must be a component ID/);
    expect(issues(s.array(s.string(), { maxItems: 1 }).safeParse(['a', 'b']))).toEqual([
      '(root): must have at most 1 items',
    ]);
    expect(issues(s.array(s.string()).safeParse('x'))).toEqual([
      '(root): expected an array, got a string',
    ]);
  });

  it('returns records as ordered maps and checks keys', () => {
    const r = s.record(s.integer(), { keyPattern: /^[a-z]+$/, keyPatternName: 'lowercase' });
    expect(r.parse({ b: 1, a: 2 })).toEqual(
      new Map([
        ['b', 1],
        ['a', 2],
      ]),
    );
    expect(issues(r.safeParse({ B: 1, c: 'x' }))).toEqual([
      'B: key must be lowercase',
      'c: expected a number, got a string',
    ]);
    expect(issues(r.safeParse([]))).toEqual(['(root): expected an object, got an array']);
  });
});

describe('unions', () => {
  it('returns the first matching variant', () => {
    const u = s.union(s.integer(), s.string());
    expectTypeOf<Infer<typeof u>>().toEqualTypeOf<number | string>();
    expect(u.parse(1)).toBe(1);
    expect(u.parse('x')).toBe('x');
    expect(issues(u.safeParse(true))).toEqual([
      '(root): expected integer or string, got a boolean',
    ]);
  });

  it('reports the closest variant when an object nearly matches', () => {
    const u = s.union(s.string(), s.object({ file: s.string(), mode: s.enum(['r', 'w']) }));
    expect(issues(s.object({ src: u }).safeParse({ src: { file: 'x', mode: 'rw' } }))).toEqual([
      'src.mode: expected one of "r", "w", got "rw"',
    ]);
  });

  it('dispatches tagged unions and suggests unknown tags', () => {
    const component = s.tagged('type', {
      http: s.object({ address: s.socketAddress() }),
      file: s.object({ path: s.string() }),
    });
    const out = component.parse({ type: 'http', address: '0.0.0.0:80' });
    expect(out).toEqual({ type: 'http', address: { host: '0.0.0.0', port: 80 } });
    if (out.type === 'http') expectTypeOf(out.address.port).toEqualTypeOf<number>();
    expect(issues(component.safeParse({ type: 'htp' }))).toEqual([
      'type: unknown type "htp"; expected one of http, file (did you mean "http"?)',
    ]);
    expect(issues(component.safeParse({}))).toEqual(['type: is required (one of http, file)']);
    expect(issues(component.safeParse({ type: 'file', path: 1 }))).toEqual([
      'path: expected a string, got an integer',
    ]);
    expect(issues(component.safeParse('x'))).toEqual(['(root): expected an object, got a string']);
  });

  it('supports recursive schemas', () => {
    type Node = { name: string; children?: Node[] };
    const node: ReturnType<typeof s.lazy<Node>> = s.lazy(() =>
      s.object({ name: s.string(), children: s.array(node).optional() }),
    );
    expect(node.parse({ name: 'a', children: [{ name: 'b' }] })).toEqual({
      name: 'a',
      children: [{ name: 'b' }],
    });
    expect(issues(node.safeParse({ name: 'a', children: [{}] }))).toEqual([
      'children[0].name: is required',
    ]);
  });
});

describe('refine and transform', () => {
  it('adds checks and conversions', () => {
    const even = s.integer().refine(
      (n) => n % 2 === 0,
      (n) => `${n} is odd`,
    );
    expect(even.parse(2)).toBe(2);
    expect(issues(even.safeParse(3))).toEqual(['(root): 3 is odd']);
    const upper = s.string().transform((v) => v.toUpperCase());
    expect(upper.parse('a')).toBe('A');
    const positive = s.string().transform((v, ctx) => {
      const n = Number(v);
      return n > 0 ? n : (ctx.report('custom', 'must be positive'), invalid);
    });
    expect(positive.parse('5')).toBe(5);
    expect(issues(positive.safeParse('-1'))).toEqual(['(root): must be positive']);
    expect(issues(upper.safeParse(1))).toEqual(['(root): expected a string, got an integer']);
  });
});

describe('formats', () => {
  it('parses durations from strings or milliseconds', () => {
    expect(s.duration().parse('1m30s')).toBe(90_000);
    expect(s.duration().parse(250)).toBe(250);
    expect(issues(s.duration().safeParse('soon'))[0]).toMatch(
      /invalid duration.*\(use a value like/,
    );
    expect(issues(s.duration().safeParse(-1))).toEqual([
      '(root): duration must be a non-negative number of milliseconds',
    ]);
    expect(issues(s.duration({ minMs: 1000 }).safeParse('10ms'))).toEqual([
      '(root): must be at least 1000ms',
    ]);
    expect(issues(s.duration({ maxMs: 10 }).safeParse('1s'))).toEqual([
      '(root): must be at most 10ms',
    ]);
    expect(issues(s.duration().safeParse(true))).toEqual([
      '(root): expected a duration, got a boolean',
    ]);
  });

  it('parses byte sizes', () => {
    expect(s.byteSize().parse('1KiB')).toBe(1024);
    expect(s.byteSize().parse(10)).toBe(10);
    expect(s.byteSize({ min: 2 }).safeParse(1).ok).toBe(false);
    expect(s.byteSize({ max: 2 }).safeParse('1KB').ok).toBe(false);
    expect(s.byteSize().safeParse(1.5).ok).toBe(false);
    expect(s.byteSize().safeParse('lots').ok).toBe(false);
    expect(s.byteSize().safeParse(null).ok).toBe(false);
  });

  it('parses socket addresses, including IPv6', () => {
    expect(s.socketAddress().parse('localhost:9000')).toEqual({ host: 'localhost', port: 9000 });
    expect(s.socketAddress().parse('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(s.socketAddress(true).parse('127.0.0.1:0')).toEqual({ host: '127.0.0.1', port: 0 });
    for (const bad of ['localhost', ':80', 'host:70000', 'host:0', '::1:80', 'a b:1']) {
      expect(s.socketAddress().safeParse(bad).ok).toBe(false);
    }
    expect(s.socketAddress().safeParse(80).ok).toBe(false);
  });

  it('validates URLs and refuses embedded credentials', () => {
    const url = s.url({ protocols: ['http', 'https'] });
    expect(url.parse('https://example.com/ingest')).toBe('https://example.com/ingest');
    expect(issues(url.safeParse('ftp://example.com'))).toEqual([
      '(root): URL scheme must be one of http, https; got ftp',
    ]);
    expect(issues(url.safeParse('https://user:pw@example.com'))[0]).toContain(
      'must not embed credentials',
    );
    expect(url.safeParse('not a url').ok).toBe(false);
    expect(url.safeParse(1).ok).toBe(false);
  });

  it('parses field paths and regexes', () => {
    expect(s.fieldPath().parse('.a.b[0]')).toEqual(['a', 'b', 0]);
    expect(s.fieldPath().safeParse('.a..b').ok).toBe(false);
    expect(s.fieldPath().safeParse(1).ok).toBe(false);
    expect(s.regex('i').parse('^a').test('A')).toBe(true);
    expect(s.regex().safeParse('(').ok).toBe(false);
    expect(s.regex().safeParse(1).ok).toBe(false);
  });
});

describe('secrets and docs', () => {
  const schema = s.object({
    endpoint: s.url(),
    auth: s
      .tagged('strategy', {
        basic: s.object({ user: s.string(), password: s.string().secret() }),
        bearer: s.object({ token: s.string().secret() }),
      })
      .optional(),
    headers: s.record(s.string().secret()).optional(),
    keys: s.array(s.string().secret()).optional(),
    either: s.union(s.integer(), s.object({ key: s.string().secret() })).optional(),
  });

  it('redacts secret values wherever they appear', () => {
    const raw = {
      endpoint: 'https://x',
      auth: { strategy: 'basic', user: 'u', password: 'hunter2' },
      headers: { 'x-api-key': 'k' },
      keys: ['a', 'b'],
      either: { key: 's' },
      unknown: 'kept',
    };
    expect(schema.redact(raw)).toEqual({
      endpoint: 'https://x',
      auth: { strategy: 'basic', user: 'u', password: REDACTED },
      headers: { 'x-api-key': REDACTED },
      keys: [REDACTED, REDACTED],
      either: { key: REDACTED },
      unknown: 'kept',
    });
    expect(raw.auth.password).toBe('hunter2');
    expect(schema.redact('not an object')).toBe('not an object');
  });

  it('produces documentation trees', () => {
    const doc = s
      .object({
        level: s.enum(['info', 'debug']).default('info').describe('Log level'),
        token: s.string().secret().optional(),
        size: s.integer({ min: 1 }).example(10, 20),
      })
      .describe('Example component')
      .toDoc();
    expect(doc).toEqual({
      type: 'object',
      description: 'Example component',
      fields: {
        level: {
          type: 'enum',
          values: ['info', 'debug'],
          optional: true,
          default: 'info',
          description: 'Log level',
        },
        token: { type: 'string', secret: true, optional: true },
        size: { type: 'integer', constraints: { min: 1 }, examples: [10, 20] },
      },
    });
    expect(s.string().deprecated('use x').toDoc()).toEqual({ type: 'string', deprecated: 'use x' });
  });

  it('keeps metadata immutable between derived schemas', () => {
    const base = s.string();
    const described = base.describe('a');
    expect(base.description).toBeUndefined();
    expect(described.description).toBe('a');
    expect(base.secret().isSecret).toBe(true);
    expect(base.isSecret).toBe(false);
  });
});

describe('suggestion helpers', () => {
  it('computes edit distance and closest matches', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('prot', 'port')).toBe(1);
    expect(closestMatch('rw', ['r', 'w'])).toBeUndefined();
    expect(closestMatch('adress', ['address', 'port'])).toBe('address');
    expect(closestMatch('zzz', ['address', 'port'])).toBeUndefined();
  });

  it('formats issue paths', () => {
    expect(formatIssuePath([])).toBe('(root)');
    expect(formatIssuePath(['sinks', 'my-sink', 'batch', 0])).toBe('sinks.my-sink.batch[0]');
    expect(formatIssuePath(['headers', 'x.y'])).toBe('headers["x.y"]');
  });
});
