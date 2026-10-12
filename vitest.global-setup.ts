import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('./', import.meta.url));
const tsc = fileURLToPath(new URL('./node_modules/.bin/tsc', import.meta.url));

/**
 * A handful of tests construct a real `@ferrule/runtime` `WorkerPool` pointed at a worker entry
 * module belonging to another package (see that package's own `resolveWorkerEntry` call, e.g.
 * `packages/operators/src/script.ts`). Unlike this suite's own `vitest.config.ts` alias (which
 * resolves a *bare* `@ferrule/*` import straight to that package's `src/index.ts`), a worker
 * entry's *relative* imports — and, transitively, every `@ferrule/*` package's own internal
 * relative imports — resolve by file path alone once the worker is a plain `node` process, with
 * no alias or loader involved: only the *built* `dist/` has a same-named `.js` sibling for each
 * of those. So every workspace package needs to actually be built before such a test can spawn
 * its worker. `tsc -b` is incremental (a fresh run is well under a second once `dist/` is
 * already up to date — see `packages/runtime/README.md`'s "Worker pool" section), so running it
 * unconditionally here is cheap insurance against a stale or missing `dist/` regardless of how
 * the suite was invoked (`pnpm run check` already builds first via `typecheck`, but `vitest run`
 * on its own does not).
 */
export function setup(): void {
  execFileSync(tsc, ['-b'], { cwd: rootDir, stdio: 'inherit' });
}
