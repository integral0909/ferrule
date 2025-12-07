import {
  mkdir as mkdirp,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLogEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { fileSource, type FileSourceHandle, type FileSourceOptions } from '../src/file.js';
import { createControllableSourceContext } from './support/context.js';

type Harness = ReturnType<typeof createControllableSourceContext>;

function buildCtx(dataDir: string, id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir, inputs: [] };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferrule-file-source-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface RawOptions extends Record<string, unknown> {
  include: string[];
}

async function startFileSource(dataDir: string, rawOptions: RawOptions, acknowledgements = true) {
  const parsed: FileSourceOptions = fileSource.options.parse(rawOptions);
  const handle = (await fileSource.build(parsed, buildCtx(dataDir))) as FileSourceHandle;
  const harness = createControllableSourceContext({ acknowledgements, dataDir });
  const runPromise = handle.run(harness.ctx);
  return { handle, harness, runPromise, pollIntervalMs: parsed.pollIntervalMs };
}

function messages(harness: Harness): string[] {
  return harness.sent
    .flatMap((b) => b.events.filter(isLogEvent))
    .map((e) => e.get('message') as string);
}

function ackAll(
  harness: Harness,
  status: 'delivered' | 'errored' | 'rejected' = 'delivered',
): void {
  for (const batch of harness.sent) {
    for (const event of batch.events) event.metadata.finalizers.finish(status);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Repeatedly acknowledges every send seen so far (a no-op for ones already finished — see
 * `Finalizers.finish`, idempotent) and yields to the event loop, until `condition` holds. The
 * `file` source processes its tracked files one at a time within a poll, awaiting each one's
 * acknowledgement (when `ctx.acknowledgements` is on) before moving to the next — a single
 * `ackAll` + one-shot wait race ahead of files that haven't sent anything yet. Pumping keeps
 * acknowledging as *new* sends appear so the source's per-file sequence can actually complete.
 */
async function pump(harness: Harness, condition: () => boolean, maxRounds = 1000): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    ackAll(harness);
    if (condition()) return;
    await yieldToEventLoop();
  }
  throw new Error('pump: condition never became true');
}

/** Waits for a specific *new* batch (beyond `fromIndex`) to arrive, without acknowledging it —
 * for tests that need to control a particular batch's acknowledgement outcome themselves. */
async function waitForNextBatch(
  harness: Harness,
  fromIndex: number,
  maxRounds = 1000,
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    if (harness.sent.length > fromIndex) return;
    await yieldToEventLoop();
  }
  throw new Error('waitForNextBatch: no new batch arrived');
}

/** Waits until the source's poll loop is genuinely idle (blocked on its between-polls sleep),
 * acknowledging any sends along the way so a multi-file tick can actually finish. Then advances
 * the clock by exactly one poll interval to deterministically trigger the next tick. */
async function nextPoll(harness: Harness, pollIntervalMs: number): Promise<void> {
  await pump(harness, () => harness.clock.pendingCount > 0);
  await harness.clock.advance(pollIntervalMs);
}

/** Drains the source cleanly: acknowledges everything (including anything the in-flight tick
 * still produces after shutdown begins) until `run()` actually resolves. */
async function stop(harness: Harness, runPromise: Promise<void>): Promise<void> {
  harness.releaseSends();
  harness.abort();
  for (let i = 0; i < 1000; i++) {
    ackAll(harness);
    let settled = false;
    await Promise.race([
      runPromise.then(() => {
        settled = true;
      }),
      yieldToEventLoop(),
    ]);
    if (settled) return;
  }
  await runPromise;
}

async function appendLine(path: string, line: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${line}\n`);
}

async function readCheckpointFile(
  dataDir: string,
): Promise<Record<string, { offset: number; path: string }>> {
  const text = await readFile(join(dataDir, 'file_checkpoints.json'), 'utf8');
  return JSON.parse(text) as Record<string, { offset: number; path: string }>;
}

describe('file: happy path', () => {
  it('reads from the beginning and decodes lines', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\nline two\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 2);
    expect(messages(harness).sort()).toEqual(['line one', 'line two']);
    await stop(harness, runPromise);
  });

  it('read_from "end" (the default) ignores pre-existing content', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'old line\n');

    const { harness, runPromise, pollIntervalMs } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      pollIntervalMs: 50,
    });
    // Let discovery run at least once so the file is tracked from its current end before we
    // append anything new.
    await nextPoll(harness, pollIntervalMs);

    await appendLine(logFile, 'new line');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).length >= 1);
    expect(messages(harness)).toEqual(['new line']);
    await stop(harness, runPromise);
  });

  it('tails newly appended lines across multiple polls', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, '');

    const { harness, runPromise, pollIntervalMs } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await nextPoll(harness, pollIntervalMs);

    await appendLine(logFile, 'first');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).includes('first'));

    await appendLine(logFile, 'second');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).includes('second'));

    expect(messages(harness)).toEqual(['first', 'second']);
    await stop(harness, runPromise);
  });

  it('excludes files matching an exclude pattern', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    await writeFile(join(logDir, 'app.log'), 'keep me\n');
    await writeFile(join(logDir, 'app.debug.log'), 'skip me\n');

    const { harness, runPromise, pollIntervalMs } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      exclude: [join(logDir, '*.debug.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 1);
    await nextPoll(harness, pollIntervalMs); // give the excluded file a chance to (wrongly) appear
    await pump(harness, () => true);
    expect(messages(harness)).toEqual(['keep me']);
    await stop(harness, runPromise);
  });

  it('discovers files in nested directories via **', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    await mkdirp(join(logDir, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(logDir, 'nested', 'deeper', 'app.log'), 'deep line\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '**', '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 1);
    expect(messages(harness)).toEqual(['deep line']);
    await stop(harness, runPromise);
  });
});

describe('file: decode errors and bounds', () => {
  it('skips a malformed line without stopping the tail', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, '{"message":"good1"}\nnot json\n{"message":"good2"}\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      decoding: 'json',
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 2);
    expect(messages(harness).sort()).toEqual(['good1', 'good2']);
    await stop(harness, runPromise);
  });

  it('truncates an oversize line rather than stalling', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    const longLine = 'x'.repeat(1000);
    await writeFile(logFile, `${longLine}\nshort\n`);

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      maxLineLength: 10,
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 2);
    const msgs = messages(harness);
    expect(msgs).toContain('short');
    expect(msgs.some((m) => m.length === 10)).toBe(true);
    await stop(harness, runPromise);
  });

  it('respects maxOpenFiles', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    await writeFile(join(logDir, 'a.log'), 'a\n');
    await writeFile(join(logDir, 'b.log'), 'b\n');
    await writeFile(join(logDir, 'c.log'), 'c\n');

    const { handle, harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      maxOpenFiles: 2,
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 2);
    expect(handle.trackedPaths().length).toBeLessThanOrEqual(2);
    expect(messages(harness).length).toBe(2);
    await stop(harness, runPromise);
  });
});

describe('file: multiline aggregation', () => {
  it('joins continuation lines into one event until a timeout flush', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(
      logFile,
      ['2024-01-01 ERROR boom', '  at foo()', '  at bar()', '2024-01-01 INFO all good', ''].join(
        '\n',
      ),
    );

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
      multiline: { startPattern: '^\\d{4}-\\d{2}-\\d{2}', timeoutMs: 100, maxLines: 50 },
    });
    // The first event ("boom" + 2 continuation lines) flushes as soon as the second start line
    // is seen; the second event only flushes on a timeout, since nothing follows it.
    await pump(harness, () => messages(harness).length >= 1);
    await nextPoll(harness, 200);
    await pump(harness, () => messages(harness).length >= 2);

    const msgs = messages(harness);
    expect(msgs[0]).toBe('2024-01-01 ERROR boom\n  at foo()\n  at bar()');
    expect(msgs[1]).toBe('2024-01-01 INFO all good');
    await stop(harness, runPromise);
  });
});

describe('file: rotation and truncation', () => {
  it('drains a renamed file through its still-open handle, and reads the new file at the old path', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, '');

    const { harness, runPromise, pollIntervalMs } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await nextPoll(harness, pollIntervalMs);
    await appendLine(logFile, 'before rotation');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).includes('before rotation'));

    // rename+create rotation
    await rename(logFile, join(logDir, 'app.log.1'));
    await writeFile(logFile, '');
    await appendLine(logFile, 'after rotation');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).includes('after rotation'));

    expect(messages(harness)).toEqual(['before rotation', 'after rotation']);
    await stop(harness, runPromise);
  });

  it('resets to offset 0 on copy-truncate rotation', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, '');

    const { harness, runPromise, pollIntervalMs } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await nextPoll(harness, pollIntervalMs);
    await appendLine(logFile, 'line one');
    await appendLine(logFile, 'line two');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).length >= 2);

    await truncate(logFile, 0);
    await appendLine(logFile, 'after truncate');
    await nextPoll(harness, pollIntervalMs);
    await pump(harness, () => messages(harness).includes('after truncate'));

    expect(messages(harness)).toEqual(['line one', 'line two', 'after truncate']);
    await stop(harness, runPromise);
  });
});

describe('file: checkpoints and acknowledgements', () => {
  // These are two independent scenarios rather than one combined test: once a chunk's
  // acknowledgement resolves (of either outcome), this source's checkpoint is a single
  // monotonic watermark per file, so a *later* chunk's outcome always determines where the
  // watermark ends up — there's no way to observe an earlier 'errored' chunk's non-advancement
  // once a later chunk has been flushed past it in the same run. That's fine: what the
  // checkpoint needs to guarantee is "never advance past unacknowledged-or-errored data", which
  // both scenarios below verify independently, each against a freshly started source.
  it('does not advance the checkpoint for an errored delivery', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await waitForNextBatch(harness, 0);
    ackAll(harness, 'errored');
    // Give the source a chance to (wrongly) persist an advanced offset before we check.
    await stop(harness, runPromise);

    const checkpoint = await readCheckpointFile(dataDir);
    expect(Object.values(checkpoint)[0]?.offset).toBe(0);
  });

  it('advances the checkpoint for a rejected (permanent) delivery', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await waitForNextBatch(harness, 0);
    ackAll(harness, 'rejected');
    await stop(harness, runPromise);

    const checkpoint = await readCheckpointFile(dataDir);
    expect(Object.values(checkpoint)[0]?.offset).toBe('line one\n'.length);
  });

  it('restarting resumes from the last acknowledged checkpoint without duplicating delivered data', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\nline two\n');

    // "Run 1": read both lines, acknowledge them, then stop (simulating a clean shutdown).
    const run1 = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(run1.harness, () => messages(run1.harness).length >= 2);
    await stop(run1.harness, run1.runPromise);

    const checkpointAfterRun1 = await readCheckpointFile(dataDir);
    expect(Object.values(checkpointAfterRun1)[0]?.offset).toBe('line one\nline two\n'.length);

    // More data arrives while "the process is down".
    await appendLine(logFile, 'line three');

    // "Run 2": a fresh build (a real restart would also be a fresh process), same dataDir.
    const run2 = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(run2.harness, () => messages(run2.harness).includes('line three'));
    // Only the new line — not a re-delivery of the two already-acknowledged ones.
    expect(messages(run2.harness)).toEqual(['line three']);
    await stop(run2.harness, run2.runPromise);
  });

  it('does not need acknowledgement to proceed when acknowledgements are off', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'only line\n');

    const { harness, runPromise } = await startFileSource(
      dataDir,
      { include: [join(logDir, '*.log')], readFrom: 'beginning', pollIntervalMs: 50 },
      false,
    );
    await waitForNextBatch(harness, 0); // no ack needed — the source must not be waiting on one
    expect(messages(harness)).toEqual(['only line']);
    await stop(harness, runPromise);
  });
});

describe('file: backpressure and shutdown', () => {
  it('does not crash while output.send is blocked, and resumes once released', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    harness.blockSends();
    await waitForNextBatch(harness, 0);
    expect(messages(harness)).toEqual(['line one']); // sent, just not acknowledged yet
    harness.releaseSends();
    await stop(harness, runPromise);
  });

  it('persists the checkpoint and stops cleanly on shutdown', async () => {
    const dataDir = await tempDir();
    const logDir = await tempDir();
    const logFile = join(logDir, 'app.log');
    await writeFile(logFile, 'line one\n');

    const { harness, runPromise } = await startFileSource(dataDir, {
      include: [join(logDir, '*.log')],
      readFrom: 'beginning',
      pollIntervalMs: 50,
    });
    await pump(harness, () => messages(harness).length >= 1);
    await stop(harness, runPromise);

    const checkpoint = await readCheckpointFile(dataDir);
    expect(Object.values(checkpoint)[0]?.offset).toBe('line one\n'.length);
  });
});

describe('file: validation', () => {
  it('fails to build without a pipeline data directory', () => {
    const parsed = fileSource.options.parse({ include: ['/tmp/does-not-matter/*.log'] });
    const { logger } = createCapturingLogger();
    expect(() =>
      fileSource.build(parsed, { id: 'src', logger, dataDir: undefined, inputs: [] }),
    ).toThrow(/data directory/);
  });
});
