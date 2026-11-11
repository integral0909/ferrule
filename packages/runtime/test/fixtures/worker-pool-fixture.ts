/**
 * A minimal worker entry for `worker-pool.test.ts`, run via `--experimental-strip-types` (see
 * `worker-pool.ts`'s `resolveWorkerEntry` doc) directly — it deliberately imports nothing but
 * Node builtins, so these tests don't also need `--conditions=@ferrule/source` to resolve a
 * workspace package from an unbuilt `src/`.
 *
 * `workerData` selects a behaviour:
 * - `'echo'` — replies with the same bytes, uppercased if they decode as ASCII text, and `meta`
 *   echoed back with `seen: true` merged in.
 * - `'reject'` — replies with a `ferrule:error` message (an application-level failure; the
 *   worker stays alive).
 * - `'always-crash'` — exits immediately on every request (a worker that never recovers).
 * - `'crash-once'` — the first worker to receive a request with a given `meta.requestKey` exits
 *   immediately; a later attempt with the same key (necessarily a fresh worker, since this one
 *   is now dead) behaves like `'echo'`. Coordination across the worker respawn uses a marker
 *   file (`markerDir`), since separate worker threads don't share memory.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface Init {
  readonly behavior: 'echo' | 'reject' | 'always-crash' | 'crash-once';
  readonly markerDir?: string;
}

interface RequestMessage {
  readonly type: 'ferrule:request';
  readonly id: number;
  readonly meta: { readonly requestKey?: string; readonly delayMs?: number };
  readonly payload: ArrayBuffer;
}

const init = workerData as Init;

if (parentPort === null) {
  throw new Error('worker-pool-fixture.ts must run as a worker_threads worker');
}
const port = parentPort;

port.on('message', (msg: RequestMessage) => {
  if (msg.type !== 'ferrule:request') return;

  if (init.behavior === 'always-crash') {
    process.exit(1);
  }

  if (init.behavior === 'crash-once') {
    const dir = init.markerDir!;
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${msg.meta.requestKey ?? 'default'}.marker`);
    if (!existsSync(marker)) {
      writeFileSync(marker, '1');
      process.exit(1);
    }
    // Marker already present: a previous (now-dead) worker already crashed on this request;
    // this is the retry, on a fresh worker, so fall through to the 'echo' behaviour below.
  }

  if (init.behavior === 'reject') {
    port.postMessage({ type: 'ferrule:error', id: msg.id, message: 'fixture: deliberate reject' });
    return;
  }

  const respond = (): void => {
    const bytes = new Uint8Array(msg.payload);
    const upper = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      upper[i] = b >= 97 && b <= 122 ? b - 32 : b;
    }
    port.postMessage(
      {
        type: 'ferrule:response',
        id: msg.id,
        meta: { ...msg.meta, seen: true },
        payload: upper.buffer,
      },
      [upper.buffer],
    );
  };
  if (msg.meta.delayMs !== undefined) {
    setTimeout(respond, msg.meta.delayMs);
  } else {
    respond();
  }
});
