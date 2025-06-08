import { describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { createMemoryEventBuffer } from '@ferrule/runtime';

function log(message: string): LogEvent {
  return LogEvent.fromMessage(message);
}

describe('MemoryEventBuffer', () => {
  it('round-trips events written through the writer and read through the reader', async () => {
    const buffer = createMemoryEventBuffer('b');
    await buffer.writer.write([log('a'), log('b')]);
    const batch = await buffer.reader.read(10);
    expect(batch?.map((e) => (e as LogEvent).get('message'))).toEqual(['a', 'b']);
  });

  it('applies backpressure once its capacity is reached', async () => {
    const buffer = createMemoryEventBuffer('b', { events: 1 });
    await buffer.writer.write([log('a')]);
    let done = false;
    const p = buffer.writer.write([log('b')]).then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    await buffer.reader.read(1);
    await p;
    expect(done).toBe(true);
  });

  it('reports live stats', async () => {
    const buffer = createMemoryEventBuffer('b');
    await buffer.writer.write([log('a'), log('b')]);
    expect(buffer.stats().events).toBe(2);
    await buffer.reader.read(1);
    expect(buffer.stats().events).toBe(1);
  });

  it('closing the writer lets the reader drain and then resolve undefined', async () => {
    const buffer = createMemoryEventBuffer('b');
    await buffer.writer.write([log('a')]);
    await buffer.writer.close();
    const batch = await buffer.reader.read(10);
    expect(batch).toHaveLength(1);
    await expect(buffer.reader.read(10)).resolves.toBeUndefined();
  });

  it('close() closes both sides', async () => {
    const buffer = createMemoryEventBuffer('b');
    await buffer.close();
    await expect(buffer.writer.write([log('a')])).rejects.toThrow();
  });
});
