/**
 * Deterministic, realistic-looking JSON log lines, shared by the zstd interop fixtures
 * (`test/compression/fixtures/generate.sh`) and the compression benchmark (`bench/`). A seeded
 * PRNG keeps the output byte-identical across runs and platforms, so the fixture manifest's
 * hashes stay valid. Plain erasable TypeScript with no imports: it runs directly under
 * `node --experimental-strip-types`.
 *
 * CLI: node --experimental-strip-types log-lines.ts <lineCount> [seed]
 */

const LEVELS = ['debug', 'info', 'info', 'info', 'warn', 'error'] as const;
const SERVICES = ['checkout', 'billing', 'inventory', 'auth', 'search', 'gateway'] as const;
const HOSTS = ['web-01', 'web-02', 'web-03', 'api-01', 'api-02', 'db-01'] as const;
const MESSAGES = [
  'request completed',
  'cache miss',
  'user authenticated',
  'rate limit exceeded',
  'upstream timeout, retrying',
  'connection pool exhausted',
] as const;
const PATHS = ['/api/v1/items', '/api/v1/cart', '/api/v2/search', '/healthz', '/api/v1/orders'];
const STATUSES = [200, 200, 200, 201, 204, 304, 400, 404, 429, 500, 503] as const;
const AGENTS = ['curl/8.5.0', 'Mozilla/5.0 (X11; Linux x86_64)', 'okhttp/4.12.0'] as const;

function hex32(n: number): string {
  return Math.floor(n * 0xffff_ffff)
    .toString(16)
    .padStart(8, '0');
}

export function* logLines(count: number, seed = 1): Generator<string> {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return state / 0x1_0000_0000;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let ts = Date.UTC(2026, 10, 19, 12, 0, 0);
  for (let i = 0; i < count; i++) {
    ts += Math.floor(rand() * 40);
    yield JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      host: pick(HOSTS),
      message: pick(MESSAGES),
      method: rand() < 0.7 ? 'GET' : 'POST',
      path: pick(PATHS),
      status: pick(STATUSES),
      duration_ms: Math.round(rand() * 50_000) / 100,
      request_id: `req-${hex32(rand())}`,
      trace_id: hex32(rand()) + hex32(rand()) + hex32(rand()) + hex32(rand()),
      user_agent: pick(AGENTS),
    });
  }
}

/** The same lines as {@link logLines}, newline-terminated, as one buffer. */
export function logText(count: number, seed = 1): Buffer {
  let out = '';
  for (const line of logLines(count, seed)) out += line + '\n';
  return Buffer.from(out, 'utf8');
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  process.stdout.write(logText(Number(process.argv[2]), Number(process.argv[3] ?? 1)));
}
