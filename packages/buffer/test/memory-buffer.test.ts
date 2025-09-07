import { describe, expect, it, vi } from 'vitest';
import { LogEvent } from '@ferrule/core';
import {
  BufferAbortedError,
  BufferClosedError,
  BufferFullError,
  createMemoryBuffer,
} from '@ferrule/buffer';

function events(...messages: string[]): LogEvent[] {
  return messages.map((m) => LogEvent.fromMessage(m));
}

describe('createMemoryBuffer', () => {
  it('writes then reads events back in order', async () => {
    const { writer, reader } = createMemoryBuffer();
    await writer.write(events('a', 'b', 'c'));
    const batch = await reader.read(10);
    expect(batch.events.map((e) => (e as LogEvent).get('message'))).toEqual(['a', 'b', 'c']);
  });

  it('read resolves with only up to maxEvents', async () => {
    const { writer, reader } = createMemoryBuffer();
    await writer.write(events('a', 'b', 'c'));
    const batch = await reader.read(2);
    expect(batch.events.length).toBe(2);
    const rest = await reader.read(10);
    expect(rest.events.length).toBe(1);
  });

  it('read blocks until data is written', async () => {
    const { writer, reader } = createMemoryBuffer();
    const pending = reader.read(1);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await writer.write(events('x'));
    const batch = await pending;
    expect(resolved).toBe(true);
    expect(batch.events.length).toBe(1);
  });

  it('finishes each event’s fresh finalizer to acknowledge it, freeing capacity', async () => {
    const { writer, reader } = createMemoryBuffer({ maxEvents: 1, whenFull: 'block' });
    await writer.write(events('a'));

    const blockedWrite = writer.write(events('b'));
    let wroteSecond = false;
    void blockedWrite.then(() => {
      wroteSecond = true;
    });
    await Promise.resolve();
    expect(wroteSecond).toBe(false);

    const batch = await reader.read(1);
    expect(wroteSecond).toBe(false); // reading alone doesn't free capacity, only acking does
    batch.events[0]!.metadata.finalizers.finish('delivered');
    await blockedWrite;
    expect(wroteSecond).toBe(true);
  });

  it('ackAll finishes every event in the batch', async () => {
    const { writer, reader } = createMemoryBuffer({ maxEvents: 1 });
    await writer.write(events('a'));
    const blocked = writer.write(events('b'));
    const batch = await reader.read(1);
    batch.ackAll();
    await blocked;
  });

  it('write finishes the original finalizers once accepted', async () => {
    const { writer } = createMemoryBuffer();
    const [event] = events('a');
    const spy = vi.spyOn(event!.metadata.finalizers, 'finish');
    await writer.write([event!]);
    expect(spy).toHaveBeenCalledWith('delivered');
  });

  describe('backpressure', () => {
    it('"block" waits for space freed by an acknowledgement', async () => {
      const { writer, reader } = createMemoryBuffer({ maxEvents: 1 });
      await writer.write(events('a'));
      let secondDone = false;
      const second = writer.write(events('b')).then(() => {
        secondDone = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondDone).toBe(false);

      const batch = await reader.read(1);
      batch.ackAll();
      await second;
      expect(secondDone).toBe(true);
    });

    it('"drop_newest" rejects immediately without blocking', async () => {
      const { writer } = createMemoryBuffer({ maxEvents: 1, whenFull: 'drop_newest' });
      await writer.write(events('a'));
      await expect(writer.write(events('b'))).rejects.toBeInstanceOf(BufferFullError);
    });

    it('respects maxBytes as well as maxEvents', async () => {
      const { writer } = createMemoryBuffer({ maxBytes: 1, whenFull: 'drop_newest' });
      await expect(
        writer.write(events('this is definitely more than one byte')),
      ).rejects.toBeInstanceOf(BufferFullError);
    });

    it('a blocked write can be aborted via its signal', async () => {
      const { writer } = createMemoryBuffer({ maxEvents: 1 });
      await writer.write(events('a'));
      const controller = new AbortController();
      const blocked = writer.write(events('b'), { signal: controller.signal });
      controller.abort();
      await expect(blocked).rejects.toBeInstanceOf(BufferAbortedError);
    });
  });

  describe('close', () => {
    it('write after close throws BufferClosedError', async () => {
      const { writer } = createMemoryBuffer();
      await writer.close();
      await expect(writer.write(events('a'))).rejects.toBeInstanceOf(BufferClosedError);
    });

    it('a pending read resolves with an empty batch once closed', async () => {
      const { reader } = createMemoryBuffer();
      const pending = reader.read(1);
      await reader.close();
      const batch = await pending;
      expect(batch.events).toEqual([]);
    });

    it('read after close (with nothing queued) resolves empty immediately', async () => {
      const { reader } = createMemoryBuffer();
      await reader.close();
      const batch = await reader.read(1);
      expect(batch.events).toEqual([]);
    });

    it('a blocked writer is released (rejected) when the buffer closes', async () => {
      const { writer } = createMemoryBuffer({ maxEvents: 1 });
      await writer.write(events('a'));
      const blocked = writer.write(events('b'));
      await writer.close();
      await expect(blocked).rejects.toBeInstanceOf(BufferClosedError);
    });

    it('flush is a no-op that always resolves', async () => {
      const { writer } = createMemoryBuffer();
      await expect(writer.flush()).resolves.toBeUndefined();
    });
  });
});
