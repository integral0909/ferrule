import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { createTestSinkContext } from '@ferrule/runtime';
import { createFileSink, FileSinkWriter, type FileSinkOptions } from '../../src/stream/file.js';

function withFinalizer(event: LogEvent): Promise<DeliveryStatus> {
  const batch = new BatchNotifier();
  event.metadata.finalizers.add(batch.createFinalizer());
  batch.seal();
  return batch.completion;
}

function baseOptions(baseDir: string, overrides: Partial<FileSinkOptions> = {}): FileSinkOptions {
  return {
    baseDir,
    path: 'out.log',
    encoding: 'json',
    framing: 'newline',
    lengthPrefixWidth: 'u32',
    lengthPrefixEndianness: 'BE',
    gzip: false,
    maxOpenFiles: 64,
    idleClose: 30_000,
    fsync: 'none',
    fsyncInterval: 1_000,
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'ferrule-file-sink-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function runToCompletion(
  sink: ReturnType<typeof createFileSink>,
  ctx: ReturnType<typeof createTestSinkContext>,
  events: LogEvent[],
): Promise<Promise<DeliveryStatus>[]> {
  const completions = events.map(withFinalizer);
  const running = sink.run(ctx.ctx);
  await ctx.feed(events);
  ctx.close();
  await running;
  return completions;
}

describe('file sink', () => {
  it('writes newline-framed JSON to the templated path', async () => {
    const sink = createFileSink(baseOptions(dir, { path: 'out.log' }));
    const ctx = createTestSinkContext();
    const events = [LogEvent.fromMessage('a'), LogEvent.fromMessage('b')];
    const completions = await runToCompletion(sink, ctx, events);
    for (const c of completions) await expect(c).resolves.toBe('delivered');

    const content = await fsp.readFile(nodePath.join(dir, 'out.log'), 'utf8');
    expect(content).toBe('{"message":"a"}\n{"message":"b"}\n');
  });

  it('fans out to one file per rendered path template', async () => {
    const sink = createFileSink(baseOptions(dir, { path: '{{ host }}.log' }));
    const ctx = createTestSinkContext();
    const events = [
      LogEvent.from({ host: 'a', message: '1' }),
      LogEvent.from({ host: 'b', message: '2' }),
      LogEvent.from({ host: 'a', message: '3' }),
    ];
    const completions = await runToCompletion(sink, ctx, events);
    for (const c of completions) await expect(c).resolves.toBe('delivered');

    const a = await fsp.readFile(nodePath.join(dir, 'a.log'), 'utf8');
    const b = await fsp.readFile(nodePath.join(dir, 'b.log'), 'utf8');
    expect(a.split('\n').filter(Boolean)).toHaveLength(2);
    expect(b.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('creates the base directory (and nested template directories) as needed', async () => {
    const nested = nodePath.join(dir, 'does', 'not', 'exist', 'yet');
    const sink = createFileSink(baseOptions(nested, { path: 'sub/dir/out.log' }));
    const ctx = createTestSinkContext();
    const completions = await runToCompletion(sink, ctx, [LogEvent.fromMessage('x')]);
    await expect(completions[0]).resolves.toBe('delivered');
    expect(fs.existsSync(nodePath.join(nested, 'sub', 'dir', 'out.log'))).toBe(true);
  });

  it('rejects an event whose rendered path tries to escape baseDir, and writes nothing outside it', async () => {
    const sink = createFileSink(baseOptions(dir, { path: '{{ path }}' }));
    const ctx = createTestSinkContext();
    const escaping = LogEvent.from({ path: '../../../../etc/passwd', message: 'pwn' });
    const completions = await runToCompletion(sink, ctx, [escaping]);
    await expect(completions[0]).resolves.toBe('rejected');
    expect(fs.existsSync('/etc/ferrule-should-not-exist')).toBe(false);
    // Nothing at all should have been created inside dir's parent chain outside dir itself.
    const entries = await fsp.readdir(dir);
    expect(entries).toEqual([]);
  });

  it('rejects an event whose rendered path is empty', async () => {
    const sink = createFileSink(baseOptions(dir, { path: '{{ missing }}' }));
    const ctx = createTestSinkContext();
    const completions = await runToCompletion(sink, ctx, [LogEvent.fromMessage('x')]);
    await expect(completions[0]).resolves.toBe('rejected');
  });

  it('gzip-compresses file contents, readable back via zlib', async () => {
    const sink = createFileSink(
      baseOptions(dir, { path: 'out.log.gz', gzip: true, encoding: 'text' }),
    );
    const ctx = createTestSinkContext();
    const events = [LogEvent.fromMessage('line one'), LogEvent.fromMessage('line two')];
    const completions = await runToCompletion(sink, ctx, events);
    for (const c of completions) await expect(c).resolves.toBe('delivered');

    const compressed = await fsp.readFile(nodePath.join(dir, 'out.log.gz'));
    const plain = zlib.gunzipSync(compressed).toString('utf8');
    expect(plain).toBe('line one\nline two\n');
  });

  it('rotates by size into suffixed generations', async () => {
    // Each framed "message":"N" line is a little over 20 bytes; force a rotation every ~2 lines.
    const sink = createFileSink(
      baseOptions(dir, { path: 'rot.log', rotateBytes: 45, encoding: 'json' }),
    );
    const ctx = createTestSinkContext();
    const events = Array.from({ length: 6 }, (_, i) => LogEvent.fromMessage(`m${i}`));
    const completions = await runToCompletion(sink, ctx, events);
    for (const c of completions) await expect(c).resolves.toBe('delivered');

    const entries = (await fsp.readdir(dir)).sort();
    expect(entries.length).toBeGreaterThan(1);
    expect(entries).toContain('rot.log');
    expect(entries.some((e) => /^rot\.\d+\.log$/.test(e))).toBe(true);

    // Every emitted line should be present across all generations combined, none lost.
    let combined = '';
    for (const entry of entries) combined += await fsp.readFile(nodePath.join(dir, entry), 'utf8');
    for (let i = 0; i < 6; i++) expect(combined).toContain(`"m${i}"`);
  });

  it('resumes rotation state from disk across a fresh writer for the same files', async () => {
    const options = baseOptions(dir, { path: 'resume.log', rotateBytes: 30 });
    // First writer fills generation 0 close to the limit.
    await fsp.writeFile(nodePath.join(dir, 'resume.log'), '{"message":"already-full-xxxxxxx"}\n');
    const sink = createFileSink(options);
    const ctx = createTestSinkContext();
    const completions = await runToCompletion(sink, ctx, [LogEvent.fromMessage('new')]);
    await expect(completions[0]).resolves.toBe('delivered');
    // Since generation 0 is already at/over the limit, the new event must land in generation 1.
    const gen1 = await fsp
      .readFile(nodePath.join(dir, 'resume.1.log'), 'utf8')
      .catch(() => undefined);
    expect(gen1).toContain('new');
  });
});

describe('FileSinkWriter (direct unit tests for LRU and idle close)', () => {
  it('enforces maxOpenFiles by closing the least-recently-used handle', async () => {
    const options = baseOptions(dir, { path: '{{ id }}.log', maxOpenFiles: 2 });
    const harness = createTestSinkContext();
    const writer = new FileSinkWriter(options, harness.ctx);
    await writer.start();

    const e1 = LogEvent.from({ id: '1', message: 'a' });
    const e2 = LogEvent.from({ id: '2', message: 'b' });
    const e3 = LogEvent.from({ id: '3', message: 'c' });
    await writer.writeEvent(e1);
    await writer.writeEvent(e2);
    expect(writer.openFileCount).toBe(2);
    await writer.writeEvent(e3);
    // Writing a third distinct file should have evicted the least-recently-used (id=1), keeping
    // the cap at 2.
    expect(writer.openFileCount).toBe(2);
    await writer.closeAll();

    for (const id of ['1', '2', '3']) {
      const content = await fsp.readFile(nodePath.join(dir, `${id}.log`), 'utf8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('closes idle handles once idleClose has elapsed, driven by the manual clock', async () => {
    const options = baseOptions(dir, { path: 'idle.log', idleClose: 1_000 });
    const harness = createTestSinkContext();
    const writer = new FileSinkWriter(options, harness.ctx);
    await writer.start();
    await writer.writeEvent(LogEvent.fromMessage('a'));
    expect(writer.openFileCount).toBe(1);

    await harness.clock.advance(2_000);
    await writer.closeIdle();
    expect(writer.openFileCount).toBe(0);

    await writer.closeAll();
    const content = await fsp.readFile(nodePath.join(dir, 'idle.log'), 'utf8');
    expect(content).toContain('a');
  });
});
