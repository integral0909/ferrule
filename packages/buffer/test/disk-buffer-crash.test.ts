import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { DiskBuffer, InMemoryFileSystem } from '@ferrule/buffer';

const DIR = '/buf';

function messagesOf(list: readonly unknown[]): string[] {
  return list.map((e) => (e as LogEvent).get('message') as string);
}

/** Reads every currently-durable event without ever blocking, by closing the writer first. */
async function readEverythingAvailable(
  buffer: Awaited<ReturnType<typeof DiskBuffer.open>>,
): Promise<string[]> {
  await buffer.writer.close();
  const seen: string[] = [];
  for (;;) {
    const batch = await buffer.reader.read(64);
    if (batch.events.length === 0) break;
    seen.push(...messagesOf(batch.events));
    batch.ackAll();
  }
  return seen;
}

type StepKind = 'write' | 'readAck';
interface WorkloadStep {
  kind: StepKind;
  count: number;
}

const arbWorkload: fc.Arbitrary<WorkloadStep[]> = fc.array(
  fc.record({
    kind: fc.constantFrom<StepKind>('write', 'readAck'),
    count: fc.integer({ min: 1, max: 3 }),
  }),
  { minLength: 1, maxLength: 12 },
);

/**
 * Runs a workload (a mix of writes and read+ack cycles) against a disk buffer. Every `readAck`
 * step is capped to the number of events actually written but not yet read, so it never blocks
 * waiting for data that was never produced.
 */
async function runWorkload(
  buffer: Awaited<ReturnType<typeof DiskBuffer.open>>,
  workload: readonly WorkloadStep[],
): Promise<{ written: string[]; acked: Set<string> }> {
  const written: string[] = [];
  const acked = new Set<string>();
  let counter = 0;
  let unread = 0;

  for (const step of workload) {
    if (step.kind === 'write') {
      const batch: LogEvent[] = [];
      for (let i = 0; i < step.count; i++) {
        const message = `m${counter++}`;
        written.push(message);
        batch.push(LogEvent.fromMessage(message));
      }
      await buffer.writer.write(batch);
      unread += step.count;
    } else if (unread > 0) {
      const n = Math.min(step.count, unread);
      const batch = await buffer.reader.read(n);
      batch.ackAll();
      for (const message of messagesOf(batch.events)) acked.add(message);
      unread -= batch.events.length;
    }
  }
  return { written, acked };
}

describe('crash safety (property-based, InMemoryFileSystem)', () => {
  it('after a crash at the end of a random workload: nothing acknowledged-and-durable is lost, and the buffer stays writable', async () => {
    await fc.assert(
      fc.asyncProperty(arbWorkload, async (workload) => {
        const fs = new InMemoryFileSystem();
        const buffer = await DiskBuffer.open(DIR, {
          fs,
          maxSegmentBytes: 300,
          sync: { kind: 'always' },
        });
        const { written, acked } = await runWorkload(buffer, workload);
        // Let any in-flight ledger writes triggered by the last ack settle before crashing, so
        // "acked" durably reflects what the ledger will actually say.
        await buffer.close();

        fs.crash();

        const reopened = await DiskBuffer.open(DIR, { fs });
        const redelivered = new Set(await readEverythingAvailable(reopened));

        // Every written message is either acknowledged-before-crash or was redelivered: nothing
        // written and synced is silently lost.
        for (const message of written) {
          expect(acked.has(message) || redelivered.has(message)).toBe(true);
        }
        // No message is ever fabricated: everything delivered was actually written.
        for (const message of redelivered) {
          expect(written).toContain(message);
        }
        await reopened.close();

        // The buffer must remain writable after recovery.
        const again = await DiskBuffer.open(DIR, { fs });
        await again.writer.write([LogEvent.fromMessage('post-crash-sentinel')]);
        const sentinelBatch = await again.reader.read(64);
        expect(messagesOf(sentinelBatch.events)).toContain('post-crash-sentinel');
        await again.close();
      }),
      { numRuns: 40 },
    );
  });

  it('crashing at every write boundary of a fixed workload never loses a synced-and-acked event nor returns corrupt data', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => `event-${i}`);
    for (let crashAfter = 1; crashAfter <= messages.length; crashAfter++) {
      const fs = new InMemoryFileSystem();
      const buffer = await DiskBuffer.open(DIR, {
        fs,
        maxSegmentBytes: 120,
        sync: { kind: 'always' },
      });
      const ackedBeforeCrash = new Set<string>();

      for (let i = 0; i < crashAfter; i++) {
        await buffer.writer.write([LogEvent.fromMessage(messages[i]!)]);
        if (i % 2 === 0) {
          const batch = await buffer.reader.read(1);
          batch.ackAll();
          ackedBeforeCrash.add((batch.events[0] as LogEvent).get('message') as string);
        }
      }
      await buffer.close();
      fs.crash();

      const reopened = await DiskBuffer.open(DIR, { fs });
      const delivered = await readEverythingAvailable(reopened);
      for (const message of delivered) expect(message).toMatch(/^event-\d+$/); // never garbage
      await reopened.close();

      for (let i = 0; i < crashAfter; i++) {
        const message = messages[i]!;
        expect(ackedBeforeCrash.has(message) || delivered.includes(message)).toBe(true);
      }

      const again = await DiskBuffer.open(DIR, { fs });
      await again.writer.write([LogEvent.fromMessage('sentinel')]);
      await again.close();
    }
  });

  it('a fault injected mid-rollover leaves the buffer recoverable and writable on the next open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'fsync' | 'write' | 'fsyncDir' | 'open'>(
          'fsync',
          'write',
          'fsyncDir',
          'open',
        ),
        async (op) => {
          const fs = new InMemoryFileSystem();
          const buffer = await DiskBuffer.open(DIR, {
            fs,
            maxSegmentBytes: 60,
            sync: { kind: 'always' },
          });
          await buffer.writer.write([LogEvent.fromMessage('first, fills segment 0')]);

          fs.injectFault({ op, error: new Error('simulated fault during rollover') });
          await buffer.writer
            .write([LogEvent.fromMessage('second, forces rollover')])
            .catch(() => {});
          fs.clearFaults();

          // Whatever state the fault left behind, a crash-and-reopen must recover cleanly.
          fs.crash();
          const reopened = await DiskBuffer.open(DIR, { fs });
          await reopened.writer.write([LogEvent.fromMessage('after fault')]);
          const delivered = await readEverythingAvailable(reopened);
          expect(delivered).toContain('first, fills segment 0');
          await reopened.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('tearing the unsynced tail at a random byte never returns corrupt data and stays writable', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 6 }),
        async (fraction, writeCount) => {
          // sync:'none' leaves every write unsynced (except the segment header), so there is
          // always something for 'tear' mode to cut through at an arbitrary byte offset.
          const fs = new InMemoryFileSystem();
          const buffer = await DiskBuffer.open(DIR, { fs, sync: { kind: 'none' } });
          for (let i = 0; i < writeCount; i++) {
            await buffer.writer.write([LogEvent.fromMessage(`m${i}`)]);
          }
          fs.crash({ mode: 'tear', random: () => fraction });

          const reopened = await DiskBuffer.open(DIR, { fs });
          const delivered = await readEverythingAvailable(reopened);
          // No durability is promised under 'none', but whatever comes back must be exactly one
          // of the messages that was actually written — never garbage or a partial decode.
          for (const message of delivered) expect(message).toMatch(/^m\d+$/);
          await reopened.close();

          const again = await DiskBuffer.open(DIR, { fs });
          await again.writer.write([LogEvent.fromMessage('still-writable')]);
          await again.close();
        },
      ),
      { numRuns: 25 },
    );
  });
});
