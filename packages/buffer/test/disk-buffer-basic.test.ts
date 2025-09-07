import { describe, expect, it } from 'vitest';
import { BatchNotifier, LogEvent } from '@ferrule/core';
import {
  BufferClosedError,
  BufferFullError,
  DiskBuffer,
  encodeEvent,
  InMemoryFileSystem,
  RECORD_HEADER_SIZE,
  RecordTooLargeError,
  SEGMENT_HEADER_SIZE,
  type BufferMetricsObserver,
} from '@ferrule/buffer';

function events(...messages: string[]): LogEvent[] {
  return messages.map((m) => LogEvent.fromMessage(m));
}

function messagesOf(list: readonly unknown[]): string[] {
  return list.map((e) => (e as LogEvent).get('message') as string);
}

async function openBuffer(
  fs: InMemoryFileSystem,
  dir = '/buf',
  options: Parameters<typeof DiskBuffer.open>[1] = {},
) {
  return DiskBuffer.open(dir, { fs, sync: { kind: 'always' }, ...options });
}

describe('DiskBuffer.open on a fresh directory', () => {
  it('creates the directory and an initial segment', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    const names = await fs.readdir('/buf');
    expect(names).toContain('00000000000000000000.seg');
    await buffer.close();
  });

  it('read blocks with nothing written, then resolves once something is', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    const pending = buffer.reader.read(1);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await buffer.writer.write(events('a'));
    const batch = await pending;
    expect(messagesOf(batch.events)).toEqual(['a']);
    await buffer.close();
  });
});

describe('write / read / acknowledge', () => {
  it('writes then reads events back in order', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a', 'b', 'c'));
    const batch = await buffer.reader.read(10);
    expect(messagesOf(batch.events)).toEqual(['a', 'b', 'c']);
    await buffer.close();
  });

  it('a fresh finalizer on each read event drives acknowledgement', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a'));
    const batch = await buffer.reader.read(1);

    let drained = false;
    void buffer.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    batch.events[0]!.metadata.finalizers.finish('delivered');
    await buffer.drain();
    expect(drained).toBe(true);
    await buffer.close();
  });

  it('explicit ackAll acknowledges a whole batch', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a', 'b'));
    const batch = await buffer.reader.read(2);
    batch.ackAll();
    await buffer.drain();
    await buffer.close();
  });

  it('write finishes the original event finalizers once durable', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    const [event] = events('a');
    const notifier = new BatchNotifier();
    event!.metadata.finalizers.add(notifier.createFinalizer());
    notifier.seal();
    let status: string | undefined;
    void notifier.completion.then((s) => {
      status = s;
    });

    await buffer.writer.write([event!]);
    await notifier.completion;
    expect(status).toBe('delivered');
    expect(event!.metadata.finalizers.isEmpty).toBe(true);
    await buffer.close();
  });

  it('decoded events do not carry the original finalizer', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a'));
    const batch = await buffer.reader.read(1);
    // The read event's finalizers set contains only the fresh buffer-internal finalizer.
    expect(batch.events[0]!.metadata.finalizers.size).toBe(1);
    batch.ackAll();
    await buffer.close();
  });

  it('read returns an empty batch once the writer closes and everything is read', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a'));
    await buffer.reader.read(1).then((b) => b.ackAll());
    await buffer.writer.close();
    const batch = await buffer.reader.read(1);
    expect(batch.events).toEqual([]);
    await buffer.close();
  });
});

describe('out-of-order acknowledgement', () => {
  it('acking the last record first does not advance the checkpoint until the earlier ones ack too', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a', 'b', 'c'));
    const batch = await buffer.reader.read(3);
    const [a, b, c] = batch.events;

    c!.metadata.finalizers.finish('delivered');
    b!.metadata.finalizers.finish('delivered');
    // Not drained yet: "a" is still outstanding, so the durable prefix cannot include b/c either.
    let drained = false;
    void buffer.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    a!.metadata.finalizers.finish('delivered');
    await buffer.drain();
    expect(drained).toBe(true);
    await buffer.close();
  });

  it('acking in fully reverse order still eventually drains', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.write(events('a', 'b', 'c', 'd', 'e'));
    const batch = await buffer.reader.read(5);
    for (const event of [...batch.events].reverse()) {
      event.metadata.finalizers.finish('delivered');
    }
    await buffer.drain();
    await buffer.close();
  });
});

describe('segment rollover and deletion', () => {
  it('rolls over into a new segment once maxSegmentBytes is exceeded', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { maxSegmentBytes: 200 });
    for (let i = 0; i < 20; i++) {
      await buffer.writer.write(events(`message number ${i} padded out a bit`));
    }
    const names = (await fs.readdir('/buf')).filter((n) => n.endsWith('.seg'));
    expect(names.length).toBeGreaterThan(1);
    await buffer.close();
  });

  it('deletes a segment once every record in it has been acknowledged', async () => {
    const fs = new InMemoryFileSystem();
    const deleted: bigint[] = [];
    const metrics: BufferMetricsObserver = { onSegmentDeleted: (id) => deleted.push(id) };
    const buffer = await openBuffer(fs, '/buf', { maxSegmentBytes: 150, metrics });

    for (let i = 0; i < 30; i++) {
      await buffer.writer.write(events(`padded message ${i}`));
      const batch = await buffer.reader.read(1);
      batch.ackAll();
    }
    await buffer.drain();
    await buffer.close(); // waits for any in-flight ledger write (and the deletions it triggers)

    expect(deleted.length).toBeGreaterThan(0);
    const remaining = (await fs.readdir('/buf')).filter((n) => n.endsWith('.seg'));
    // The tail segment is never deleted.
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it('the total on-disk segment size never includes deleted segments', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { maxSegmentBytes: 150 });
    for (let i = 0; i < 30; i++) {
      await buffer.writer.write(events(`padded message ${i}`));
      const batch = await buffer.reader.read(1);
      batch.ackAll();
    }
    await buffer.drain();
    await buffer.close();

    // Reopening should see a small buffer, not the full history.
    const reopened = await openBuffer(fs, '/buf', { maxSegmentBytes: 150 });
    const names = (await fs.readdir('/buf')).filter((n) => n.endsWith('.seg'));
    expect(names.length).toBeLessThan(10);
    await reopened.close();
  });
});

function frameSize(event: LogEvent): number {
  return RECORD_HEADER_SIZE + encodeEvent(event).byteLength;
}

describe('size cap and backpressure', () => {
  it('"block" write waits for a segment to be deleted after acknowledgement', async () => {
    const fs = new InMemoryFileSystem();
    const msg1 = events('first message')[0]!;
    const msg2 = events('second message')[0]!;
    const msg3 = events('third message')[0]!; // same length as msg1, by design

    // Small enough that any second record in a segment forces a rollover.
    const maxSegmentBytes = SEGMENT_HEADER_SIZE + frameSize(msg1) + 1;
    const segment1Size = SEGMENT_HEADER_SIZE + frameSize(msg1);
    const segment2Size = SEGMENT_HEADER_SIZE + frameSize(msg2);
    const maxBufferBytes = segment1Size + segment2Size; // room for exactly two segments

    const buffer = await openBuffer(fs, '/buf', { maxSegmentBytes, maxBufferBytes });
    await buffer.writer.write([msg1]); // segment 0
    await buffer.writer.write([msg2]); // rolls over into segment 1

    let thirdDone = false;
    const third = buffer.writer.write([msg3]).then(() => {
      thirdDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdDone).toBe(false);

    // Acknowledging msg1 lets segment 0 be deleted (segment 1 already exists as the tail), which
    // frees exactly enough room for msg3's own new segment.
    const batch = await buffer.reader.read(1);
    batch.ackAll();
    await third;
    expect(thirdDone).toBe(true);
    await buffer.close();
  });

  it('"drop_newest" rejects immediately with BufferFullError', async () => {
    const fs = new InMemoryFileSystem();
    const [msg1] = events('first message');
    const maxBufferBytes = SEGMENT_HEADER_SIZE + frameSize(msg1!);
    const buffer = await openBuffer(fs, '/buf', {
      maxBufferBytes,
      maxSegmentBytes: 100_000,
      whenFull: 'drop_newest',
    });
    await buffer.writer.write([msg1!]);
    await expect(buffer.writer.write(events('one more'))).rejects.toBeInstanceOf(BufferFullError);
    await buffer.close();
  });

  it('rejects a single event larger than maxRecordBytes', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { maxRecordBytes: 16 });
    await expect(
      buffer.writer.write(events('this message is far too long for the configured limit')),
    ).rejects.toBeInstanceOf(RecordTooLargeError);
    await buffer.close();
  });
});

describe('sync policies', () => {
  it('"always" fsyncs before write() resolves, so data survives an immediate crash', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { sync: { kind: 'always' } });
    await buffer.writer.write(events('a'));
    fs.crash(); // nothing further happens between write() resolving and this crash
    const reopened = await openBuffer(fs, '/buf');
    const batch = await reopened.reader.read(1);
    expect(messagesOf(batch.events)).toEqual(['a']);
    await reopened.close();
  });

  it('"none" resolves write() immediately, without waiting for a durability point', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { sync: { kind: 'none' } });
    const started = Date.now();
    await buffer.writer.write(events('a'));
    expect(Date.now() - started).toBeLessThan(1000);
    await buffer.close();
  });

  it('"none" can lose a write that was never explicitly synced before a crash', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { sync: { kind: 'none' } });
    await buffer.writer.write(events('a'));
    fs.crash(); // drops anything not explicitly fsynced, which under 'none' is everything so far
    const reopened = await openBuffer(fs, '/buf');
    await reopened.writer.close(); // nothing more will ever arrive; let a pending read resolve
    const batch = await reopened.reader.read(1);
    expect(batch.events).toEqual([]);
    await reopened.close();
  });

  it('"interval" batches several writes into one flush (group commit)', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs, '/buf', { sync: { kind: 'interval', ms: 20 } });
    const w1 = buffer.writer.write(events('a'));
    const w2 = buffer.writer.write(events('b'));
    await Promise.all([w1, w2]);
    const batch = await buffer.reader.read(2);
    expect(messagesOf(batch.events)).toEqual(['a', 'b']);
    batch.ackAll();
    await buffer.close();
  });
});

describe('close / drain lifecycle', () => {
  it('write after writer.close() throws BufferClosedError', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.writer.close();
    await expect(buffer.writer.write(events('a'))).rejects.toBeInstanceOf(BufferClosedError);
    await buffer.close();
  });

  it('drain resolves immediately when nothing is buffered', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.drain();
    await buffer.close();
  });

  it('close() closes both writer and reader', async () => {
    const fs = new InMemoryFileSystem();
    const buffer = await openBuffer(fs);
    await buffer.close();
    expect(buffer.writer.closed).toBe(true);
    expect(buffer.reader.closed).toBe(true);
  });

  it('an AbortSignal passed to open() closes the buffer', async () => {
    const fs = new InMemoryFileSystem();
    const controller = new AbortController();
    const buffer = await openBuffer(fs, '/buf', { signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await expect(buffer.writer.write(events('a'))).rejects.toThrow();
  });
});

describe('delivery status on acknowledgement', () => {
  it('keeps errored records for redelivery after reopening, releasing delivered ones', async () => {
    const fs = new InMemoryFileSystem();
    const first = await openBuffer(fs);
    await first.writer.write(events('delivered', 'errored', 'rejected'));
    const batch = await first.reader.read(3);
    const [a, b, c] = batch.events;
    a!.metadata.finalizers.finish('delivered');
    b!.metadata.finalizers.finish('errored');
    c!.metadata.finalizers.finish('rejected');
    await first.close();

    const second = await openBuffer(fs);
    const again = await second.reader.read(10);
    // The checkpoint only advances over a contiguous acknowledged prefix, so everything from the
    // first errored record on is redelivered (at-least-once); the delivered record before it is not.
    expect(messagesOf(again.events)).toEqual(['errored', 'rejected']);
    again.ackAll();
    await second.close();
  });
});
