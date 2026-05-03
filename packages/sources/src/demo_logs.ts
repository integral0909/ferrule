/**
 * `demo_logs`: generates synthetic log events so Ferrule can be tried, demoed, or load-tested
 * without any external infrastructure. Four shapes are supported: Apache/nginx-style access log
 * lines (`apache_common`/`apache_combined`), structured application logs (`json`), and BSD
 * syslog lines (`syslog`); `format: 'all'` round-robins through all four, deterministically, by
 * event index.
 *
 * Random field values are always driven by a small seeded PRNG (mulberry32), so the same `seed`
 * always produces the same sequence of field choices. Event *timestamps*, however, default to
 * real wall-clock time (`ctx.clock.now()`) at the moment generation starts, then advance forward
 * at the configured `events_per_second` rate — this is what a "demo" source should do by default.
 * For byte-for-byte reproducible output (e.g. as a test fixture), set both `seed` and
 * `start_time`: with a fixed start instant and a fixed seed, two separate runs produce identical
 * events.
 */
import { BatchNotifier, LogEvent, Timestamp, type Event } from '@ferrule/core';
import { decodeSyslogAuto } from '@ferrule/codecs';
import { defineSource, type SourceContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';

const FORMATS = ['apache_common', 'apache_combined', 'json', 'syslog'] as const;
type DemoLogFormat = (typeof FORMATS)[number];

const options = s.object({
  format: s
    .enum([...FORMATS, 'all'])
    .default('json')
    .describe(
      'Synthetic log shape to generate. "all" round-robins through apache_common, ' +
        'apache_combined, json, and syslog in that order, deterministically by event index.',
    )
    .example('json', 'apache_combined', 'all'),
  events_per_second: s
    .integer({ min: 1 })
    .default(10)
    .describe(
      'Approximate emission rate. This many events are generated together once per second (a ' +
        'small paced batch), rather than all at once.',
    ),
  seed: s
    .integer({ min: 0 })
    .default(1)
    .describe(
      'Seed for the internal PRNG (mulberry32) that drives field choices. Combined with a fixed ' +
        'start_time, the same seed and count always produce byte-for-byte identical output, ' +
        'regardless of events_per_second or real elapsed time.',
    ),
  count: s
    .integer({ min: 1 })
    .optional()
    .describe('Stop after emitting this many events. Omit to run until shutdown.'),
  start_time: s
    .string()
    .transform((value, ctx) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return ctx.report(
          'invalid_format',
          `invalid start_time ${JSON.stringify(value)}`,
          'use an RFC 3339 timestamp like "2024-01-01T00:00:00Z"',
        );
      }
      return Timestamp.fromDate(date);
    })
    // .optional() must come after .transform(): the object schema only recognises a field as
    // optional (skippable when absent from input) via the outermost schema's own type, and
    // .transform() always returns a plain (non-optional) wrapper. Placed here, .optional()
    // short-circuits an absent value to `undefined` before the transform ever runs, so the
    // transform itself only ever sees a real string.
    .optional()
    .describe(
      'Fixed start instant for deterministic output, used together with seed in tests. ' +
        'Omit to start at the current clock time (ctx.clock.now()).',
    )
    .example('2024-01-01T00:00:00Z'),
});

export type DemoLogsOptions = Infer<typeof options>;

// -------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32) and small helpers built on it
// -------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[randomInt(rng, values.length)]!;
}

// -------------------------------------------------------------------------------------------
// Fixed data pools. Small and hand-picked, not meant to be exhaustive or realistic beyond
// "plausible enough to demo a pipeline with".
// -------------------------------------------------------------------------------------------

const PATHS = [
  '/',
  '/index.html',
  '/api/users',
  '/api/users/42',
  '/api/orders',
  '/login',
  '/logout',
  '/static/app.js',
  '/favicon.ico',
  '/health',
  '/images/logo.png',
  '/api/orders/1337/items',
];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const STATUSES = [200, 200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 404, 500, 503];
const REFERRERS = [
  '-',
  'https://example.com/',
  'https://www.google.com/',
  'https://example.com/products',
  'https://example.com/cart',
];
const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'curl/8.4.0',
];
const IDENTS = ['-'];
const LOG_LEVELS = ['debug', 'info', 'info', 'info', 'warn', 'error'];
const SERVICES = ['checkout', 'auth', 'inventory', 'gateway', 'billing'];
const MESSAGES = [
  'request completed',
  'cache miss',
  'connection established',
  'retrying upstream request',
  'slow query detected',
  'user authenticated',
  'rate limit exceeded',
];
const HOSTS = ['web-01', 'web-02', 'api-03', 'worker-01'];
const SYSLOG_APP_NAMES = ['demo-app', 'demo-worker'];
const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function randomIp(rng: () => number): string {
  return `${1 + randomInt(rng, 254)}.${randomInt(rng, 256)}.${randomInt(rng, 256)}.${1 + randomInt(rng, 254)}`;
}

/** Apache/nginx-style `HTTPDATE`, e.g. `01/Jan/2024:00:00:07 +0000` (always UTC). */
function formatApacheDate(ts: Timestamp): string {
  const c = ts.toCivil();
  return `${pad2(c.day)}/${MONTH_ABBR[c.month - 1]}/${c.year}:${pad2(c.hour)}:${pad2(c.minute)}:${pad2(c.second)} +0000`;
}

function generateApacheLine(rng: () => number, ts: Timestamp, combined: boolean): string {
  const method = pick(rng, METHODS);
  const path = pick(rng, PATHS);
  const status = pick(rng, STATUSES);
  const bytes = 100 + randomInt(rng, 20_000);
  const line =
    `${randomIp(rng)} ${pick(rng, IDENTS)} ${pick(rng, IDENTS)} [${formatApacheDate(ts)}] ` +
    `"${method} ${path} HTTP/1.1" ${status} ${bytes}`;
  if (!combined) return line;
  return `${line} "${pick(rng, REFERRERS)}" "${pick(rng, AGENTS)}"`;
}

const SYSLOG_SEVERITY_BY_LEVEL: Record<string, number> = { debug: 7, info: 6, warn: 4, error: 3 };

function generateSyslogLine(rng: () => number, ts: Timestamp): string {
  const facility = pick(rng, [1, 3, 4, 16]);
  const level = pick(rng, LOG_LEVELS);
  const severity = SYSLOG_SEVERITY_BY_LEVEL[level] ?? 6;
  const pri = facility * 8 + severity;
  const c = ts.toCivil();
  const day = c.day < 10 ? ` ${c.day}` : String(c.day);
  const host = pick(rng, HOSTS);
  const app = pick(rng, SYSLOG_APP_NAMES);
  const pid = 1000 + randomInt(rng, 9000);
  const message = pick(rng, MESSAGES);
  return (
    `<${pri}>${MONTH_ABBR[c.month - 1]} ${day} ${pad2(c.hour)}:${pad2(c.minute)}:${pad2(c.second)} ` +
    `${host} ${app}[${pid}]: ${message}`
  );
}

function generateEvent(
  rng: () => number,
  format: DemoLogFormat,
  index: number,
  ts: Timestamp,
): Event {
  switch (format) {
    case 'apache_common':
      return LogEvent.fromMessage(generateApacheLine(rng, ts, false));
    case 'apache_combined':
      return LogEvent.fromMessage(generateApacheLine(rng, ts, true));
    case 'json':
      return LogEvent.from({
        timestamp: ts,
        level: pick(rng, LOG_LEVELS),
        service: pick(rng, SERVICES),
        message: pick(rng, MESSAGES),
        host: pick(rng, HOSTS),
        request_id: `req-${index.toString(36)}-${randomInt(rng, 1_000_000).toString(36)}`,
        duration_ms: Math.round(rng() * 500 * 100) / 100,
      });
    case 'syslog':
      // Generated as text, then decoded through the codec package's own syslog decoder — this
      // source is a producer, not a consumer, but reusing the decoder is a convenient way to
      // build a correctly-shaped LogEvent instead of hand-assembling its fields.
      return decodeSyslogAuto(generateSyslogLine(rng, ts), { now: ts });
  }
}

function formatForIndex(configured: DemoLogFormat | 'all', index: number): DemoLogFormat {
  if (configured !== 'all') return configured;
  return FORMATS[index % FORMATS.length]!;
}

/** Events generated together, once per tick, before pacing sleeps until the next one. Fixed
 * rather than derived from `events_per_second` so pacing stays simple: exactly one batch, sized
 * `events_per_second`, is produced per wall-clock (well, `ctx.clock`) second. */
const TICK_MS = 1000;

export const demoLogsSource = defineSource<DemoLogsOptions>({
  kind: 'source',
  type: 'demo_logs',
  description:
    'Generates synthetic log events (Apache/nginx access logs, JSON app logs, or syslog) for ' +
    'trying or testing Ferrule without external infrastructure.',
  options,
  produces: () => ['log'],
  examples: [
    {
      title: 'A steady trickle of synthetic JSON app logs',
      config: { format: 'json', events_per_second: 5 },
    },
    {
      title: 'A fixed, reproducible fixture of 1000 mixed-format events',
      config: {
        format: 'all',
        seed: 42,
        count: 1000,
        events_per_second: 1000,
        start_time: '2024-01-01T00:00:00Z',
      },
    },
  ],
  build(opts) {
    return {
      async run(ctx: SourceContext): Promise<void> {
        if (ctx.signal.aborted) return;
        const rng = mulberry32(opts.seed);
        const generated = ctx.metrics.counter('demo_logs_events_generated_total');
        let emitted = 0;
        const base = opts.start_time ?? ctx.clock.now();
        let tick = 0;

        while (!ctx.signal.aborted) {
          if (opts.count !== undefined && emitted >= opts.count) return;
          const batchSize =
            opts.count === undefined
              ? opts.events_per_second
              : Math.min(opts.events_per_second, opts.count - emitted);

          const events: Event[] = [];
          for (let i = 0; i < batchSize; i++) {
            const tickStartNs = BigInt(tick) * 1_000_000_000n;
            const withinTickNs =
              batchSize > 0 ? (BigInt(i) * 1_000_000_000n) / BigInt(batchSize) : 0n;
            const ts = base.add(tickStartNs + withinTickNs);
            events.push(generateEvent(rng, formatForIndex(opts.format, emitted), emitted, ts));
            emitted++;
          }
          generated.increment(events.length);
          tick++;

          const batch = new BatchNotifier();
          for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
          batch.seal();
          await ctx.output.send(events);
          if (ctx.acknowledgements) {
            const status = await batch.completion;
            if (status !== 'delivered') {
              ctx.logger.warn('demo_logs: batch not delivered', { status });
            }
          }

          if (opts.count !== undefined && emitted >= opts.count) return;
          try {
            await ctx.clock.sleep(TICK_MS, ctx.signal);
          } catch {
            return;
          }
        }
      },
    };
  },
});

export default demoLogsSource;
