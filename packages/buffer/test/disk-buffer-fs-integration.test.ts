import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { DiskBuffer, NodeFileSystem } from '@ferrule/buffer';

function messagesOf(list: readonly unknown[]): string[] {
  return list.map((e) => (e as LogEvent).get('message') as string);
}

describe('DiskBuffer against the real filesystem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferrule-buffer-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes, reads, acknowledges, and survives a clean close/reopen', async () => {
    const fs = new NodeFileSystem();
    const buffer = await DiskBuffer.open(dir, { fs });

    await buffer.writer.write([LogEvent.fromMessage('hello'), LogEvent.fromMessage('world')]);
    const batch = await buffer.reader.read(2);
    expect(messagesOf(batch.events)).toEqual(['hello', 'world']);
    batch.ackAll();
    await buffer.drain();
    await buffer.close();

    const reopened = await DiskBuffer.open(dir, { fs });
    const rest = await reopened.writer.close().then(async () => reopened.reader.read(10));
    expect(rest.events).toEqual([]); // everything was acknowledged before close
    await reopened.close();
  });

  it('rolls segments over and deletes acknowledged ones on real disk', async () => {
    const fs = new NodeFileSystem();
    const buffer = await DiskBuffer.open(dir, { fs, maxSegmentBytes: 512 });

    for (let i = 0; i < 50; i++) {
      await buffer.writer.write([LogEvent.fromMessage(`padded message number ${i} for bulk`)]);
      const batch = await buffer.reader.read(1);
      batch.ackAll();
    }
    await buffer.drain();
    await buffer.close();

    const reopened = await DiskBuffer.open(dir, { fs, maxSegmentBytes: 512 });
    await reopened.writer.close();
    const rest = await reopened.reader.read(10);
    expect(rest.events).toEqual([]);
    await reopened.close();
  });

  it('recovers a torn tail write on a real file', async () => {
    const fs = new NodeFileSystem();
    const buffer = await DiskBuffer.open(dir, { fs, sync: { kind: 'always' } });
    await buffer.writer.write([LogEvent.fromMessage('safe')]);
    await buffer.close();

    // Append a few garbage bytes directly to the tail segment file, simulating a torn write that
    // never completed a full record frame.
    const segmentPath = join(dir, '00000000000000000000.seg');
    const handle = await fs.open(segmentPath, 'read-write');
    const stat = await handle.stat();
    await handle.write(new Uint8Array([1, 2, 3]), stat.size);
    await handle.fsync();
    await handle.close();

    const reopened = await DiskBuffer.open(dir, { fs });
    const batch = await reopened.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['safe']);
    batch.ackAll();

    // The buffer remains writable after recovering from the torn tail.
    await reopened.writer.write([LogEvent.fromMessage('after recovery')]);
    const more = await reopened.reader.read(10);
    expect(messagesOf(more.events)).toEqual(['after recovery']);
    await reopened.close();
  });

  it('redelivers events that were read but not acknowledged before an unclean shutdown', async () => {
    const fs = new NodeFileSystem();
    const buffer = await DiskBuffer.open(dir, { fs, sync: { kind: 'always' } });
    await buffer.writer.write([LogEvent.fromMessage('unacked')]);
    await buffer.reader.read(1); // read, but never acknowledged, simulating a crash right here
    // No close(): abandon the handle to mimic the process dying without a clean shutdown.

    const reopened = await DiskBuffer.open(dir, { fs });
    const batch = await reopened.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['unacked']);
    batch.ackAll();
    await reopened.close();
  });
});
