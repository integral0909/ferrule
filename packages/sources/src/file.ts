/**
 * `file`: tails files matching glob patterns, with crash-safe, acknowledgement-driven
 * checkpoints. Poll-based (an `fs.watch` hint can wake a poll early, but never replaces it —
 * `fs.watch` is unreliable across platforms and filesystems, especially for detecting rotation),
 * so it behaves the same way on every OS.
 *
 * Design notes (why it's built this way):
 *
 * - **Checkpoints identify a file by (device, inode), validated by a content fingerprint.**
 *   Renaming a file (the common `mv current.log old.log && touch current.log` rotation) doesn't
 *   change its inode, so a file already being tailed by open file handle keeps being read
 *   correctly across a rename without any special-casing — this source never even needs to
 *   notice the rename happened, because it reads through the handle, not the path. The
 *   fingerprint (a hash of the file's first bytes) is stored alongside the identity and checked
 *   whenever we *resume* a checkpoint after not having the file open (e.g. after a restart): if
 *   the content at the checkpointed offset's file no longer starts with what we last saw there,
 *   the (device, inode) pair was reused for unrelated content (rare, but happens with aggressive
 *   inode reuse) and we start over rather than seeking into the wrong file's data.
 * - **Copy-truncate rotation** (some tools truncate the file in place rather than renaming it) is
 *   detected directly: if a tracked file's size drops below our read offset, it must have been
 *   truncated, since normal appends only grow a file. We reset to offset 0 and keep going.
 * - **The checkpoint offset only ever advances past fully-formed, decoded events** — never past
 *   a partially-read line or an in-progress multiline aggregation — and, when acknowledgements
 *   are on, only past events whose delivery has actually been acknowledged. This is what makes
 *   "restart resumes without duplicating acknowledged data" true: on restart we always re-read
 *   from the last point we know was safely delivered, at the cost of possibly re-reading (and
 *   re-sending) a little data that was in flight but unacknowledged when the process stopped —
 *   which is exactly the "at-least-once" contract the rest of the pipeline expects from sources.
 * - **Per-file outstanding chunks are tracked as an ordered queue of ranges, not one scalar.**
 *   Each poll's newly-read, newly-decoded chunk is sent immediately and queued as a `'pending'`
 *   range rather than awaited inline, so one file's slow or stuck acknowledgement can't hold up
 *   another file's tail, and several of one file's own chunks can be in flight at once. The
 *   *persisted* checkpoint only ever advances over the **contiguous prefix** of that queue that
 *   has resolved to something other than `'errored'` (`tryAdvanceCheckpoint`): a chunk that
 *   resolves `'errored'` is left in place at the head of the queue rather than skipped, so a
 *   later chunk resolving `'delivered'` — however much later — can never let the watermark jump
 *   past it. This is what closes the gap the single-watermark design used to have: previously an
 *   errored chunk followed, within the same run, by a delivered later chunk let the checkpoint
 *   advance past the errored region, silently losing it on the next restart. Concretely: an
 *   `'errored'` range permanently blocks that file's checkpoint from advancing any further for
 *   the rest of this run (matching the existing "an errored chunk is not retried mid-run, only on
 *   restart" contract) — the range queue for that file then only grows, up to `max_outstanding_chunks`
 *   ranges, at which point the reader stops reading further bytes from that file (backpressure)
 *   rather than growing the queue (and memory) without bound.
 */
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { BatchNotifier, FerruleError, LogEvent, type DeliveryStatus } from '@ferrule/core';
import { decodeFrames, defaultCodecs, type CodecRegistry, type Decoder } from '@ferrule/codecs';
import {
  defineSource,
  DEFAULT_PORT,
  Metrics,
  type BuildContext,
  type Source,
  type SourceContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { decodingSchema, splitCodecOptions } from './fragments.js';
import { AtomicJsonStore, hashFingerprintBytes } from './util/checkpoint.js';
import { compileGlob, globStaticPrefix, type CompiledGlob } from './util/glob.js';

const FINGERPRINT_BYTES = 256;
const MAX_WALK_DEPTH = 32;

const multilineSchema = s
  .object({
    start_pattern: s.regex().describe('A line matching this pattern begins a new logical event.'),
    continuation_pattern: s
      .regex()
      .optional()
      .describe(
        'A line matching this pattern is appended to the current event instead of starting a ' +
          'new one. If omitted, any line that does not match start_pattern is treated as a ' +
          'continuation (the common case: everything until the next start line belongs together).',
      ),
    timeout: s
      .duration()
      .default(1000)
      .describe('Flush the current aggregated event if no new line arrives within this long.'),
    max_lines: s
      .integer({ min: 1 })
      .default(500)
      .describe('Safety bound: force-flush an aggregated event after this many lines.'),
  })
  .optional()
  .describe('Joins consecutive lines (e.g. a stack trace) into one event.');

const options = s.object({
  include: s
    .array(s.string().nonEmpty(), { minItems: 1 })
    .describe('Glob patterns of files to tail.')
    .example(['/var/log/**/*.log']),
  exclude: s
    .array(s.string())
    .default([])
    .describe('Glob patterns to exclude, even if matched by include.'),
  read_from: s
    .enum(['beginning', 'end'])
    .default('end')
    .describe('Where a newly discovered file (with no existing checkpoint) starts reading from.'),
  poll_interval: s
    .duration()
    .default(1000)
    .describe('How often the file set and file sizes are re-scanned.'),
  max_open_files: s.integer({ min: 1 }).default(64).describe('Maximum files tailed at once.'),
  max_line_length: s
    .byteSize()
    .default(1024 * 1024)
    .describe('Maximum line length. Longer lines are truncated (and counted) at this length.'),
  max_read_size_per_tick: s
    .byteSize()
    .default(1024 * 1024)
    .describe('Maximum bytes read from one file per poll, so many active files stay responsive.'),
  max_outstanding_chunks: s
    .integer({ min: 1 })
    .default(64)
    .describe(
      'Maximum not-yet-acknowledged chunks kept in memory per file before pausing that file’s ' +
        'reads (backpressure) until one resolves. Bounds memory if delivery stalls, and — since ' +
        'an errored chunk permanently blocks that file’s checkpoint from advancing again this ' +
        'run — bounds how much gets queued up (and re-read on restart) behind one.',
    ),
  ignore_older_than: s
    .duration()
    .optional()
    .describe('Ignore files whose last-modified time is older than this when discovering.'),
  fingerprint_size: s
    .byteSize()
    .default(FINGERPRINT_BYTES)
    .describe('Bytes hashed at the start of a file to validate a resumed checkpoint.'),
  decoding: decodingSchema('text'),
  multiline: multilineSchema,
  path_field: s
    .string()
    .default('file.path')
    .describe('Field each event is annotated with: the source file path.'),
  host_field: s
    .string()
    .default('host')
    .describe('Field each event is annotated with: this machine’s hostname.'),
});

export type FileSourceOptions = Infer<typeof options>;

// ---------------------------------------------------------------------------------------------
// Checkpoint state shape
// ---------------------------------------------------------------------------------------------

interface CheckpointRecord {
  device: number;
  inode: number;
  contentHash: string;
  sampledBytes: number;
  offset: number;
  path: string;
  updatedAtMs: number;
}

type CheckpointState = Record<string, CheckpointRecord>;

function identityKey(device: number, inode: number): string {
  return `${device}:${inode}`;
}

// ---------------------------------------------------------------------------------------------
// Per-file tracking state
// ---------------------------------------------------------------------------------------------

interface MultilinePending {
  lines: string[];
  startOffset: number;
  lastLineAtMonoMs: number;
}

/**
 * One decoded chunk's checkpoint-eligible endpoint and its delivery outcome, queued in file
 * order. The persisted checkpoint only advances over the *contiguous prefix* of a file's queue
 * that has resolved to something other than `'errored'` — see `tryAdvanceCheckpoint`. A range
 * that resolves `'errored'` is never removed: once one exists, it permanently blocks its file's
 * checkpoint from advancing past it for the rest of this run (a restart re-reads from before it).
 */
interface OutstandingRange {
  /** File offset immediately after this chunk (`FrameOut.throughOffset` of its last unit). */
  readonly endOffset: number;
  status: DeliveryStatus | 'pending';
}

interface TrackedFile {
  path: string;
  device: number;
  inode: number;
  handle: Awaited<ReturnType<typeof open>>;
  /** Bytes already read off disk (may include an incomplete trailing line kept in `lineRemainder`). */
  diskReadOffset: number;
  /** Chunks sent downstream since the last persisted checkpoint, oldest first; see {@link OutstandingRange}. */
  outstandingRanges: OutstandingRange[];
  /** The offset actually persisted to the checkpoint file (delivered/rejected, never past `errored`). */
  checkpointedOffset: number;
  lineRemainder: Uint8Array;
  multilinePending: MultilinePending | undefined;
  closed: boolean;
}

interface FrameOut {
  bytes: Uint8Array;
  /** File offset immediately after this frame's contribution (including its line's own bytes and
   * delimiter), i.e. the safe-to-checkpoint offset once this frame is decoded and delivered. */
  throughOffset: number;
}

/** Splits newly-read bytes (plus any carried-over remainder) into complete lines, applying
 * `maxLineLength` truncation and tracking exact file offsets for checkpointing. Never uses a
 * `Framer` from `@ferrule/codecs` here: this needs to know precisely how many *raw disk bytes*
 * each emitted line corresponds to, which framer implementations do not expose. */
function splitLines(
  remainder: Uint8Array,
  remainderStartOffset: number,
  chunk: Uint8Array,
  maxLineLength: number,
): { lines: FrameOut[]; newRemainder: Uint8Array; newRemainderStartOffset: number } {
  const combined = remainder.length === 0 ? chunk : concat(remainder, chunk);
  const lines: FrameOut[] = [];
  let start = 0;
  let scanFrom = 0;
  for (;;) {
    const idx = combined.indexOf(0x0a, scanFrom);
    if (idx === -1) break;
    let end = idx;
    if (end > start && combined[end - 1] === 0x0d) end--; // trim a trailing \r
    let line = combined.subarray(start, end);
    if (line.length > maxLineLength) line = line.subarray(0, maxLineLength);
    lines.push({ bytes: line, throughOffset: remainderStartOffset + idx + 1 });
    start = idx + 1;
    scanFrom = start;
  }
  const newRemainder = combined.subarray(start);
  return { lines, newRemainder, newRemainderStartOffset: remainderStartOffset + start };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------------------------
// Directory walking / discovery
// ---------------------------------------------------------------------------------------------

async function walkDir(dir: string, depthRemaining: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // vanished, permission denied, or not a directory (a static prefix may be a file itself)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depthRemaining > 0) await walkDir(full, depthRemaining - 1, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(full);
    }
  }
}

async function discoverFiles(
  includePatterns: readonly string[],
  includes: readonly CompiledGlob[],
  excludes: readonly CompiledGlob[],
): Promise<string[]> {
  const prefixes = new Set(includePatterns.map((p) => resolvePathLike(globStaticPrefix(p))));
  const found = new Set<string>();
  for (const prefix of prefixes) {
    const list: string[] = [];
    // A prefix might itself name a single file (a pattern with no wildcard at all).
    try {
      const st = await stat(prefix);
      if (st.isFile()) {
        list.push(prefix);
      } else {
        await walkDir(prefix, MAX_WALK_DEPTH, list);
      }
    } catch {
      continue;
    }
    for (const f of list) found.add(f);
  }
  const matched: string[] = [];
  for (const f of found) {
    if (!includes.some((g) => g.test(f))) continue;
    if (excludes.some((g) => g.test(f))) continue;
    matched.push(f);
  }
  return matched;
}

function resolvePathLike(p: string): string {
  return isAbsolute(p) ? p : resolvePath(p);
}

// ---------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------

export interface FileSourceHandle extends Source {
  /** Files currently being tailed (open handles), for tests. */
  trackedPaths(): readonly string[];
}

export const fileSource = defineSource<FileSourceOptions>({
  kind: 'source',
  type: 'file',
  description:
    'Tails files matching glob patterns, with crash-safe, acknowledgement-driven checkpoints.',
  options,
  produces: () => ['log'],
  examples: [
    {
      title: 'Tail application logs',
      config: {
        include: ['/var/log/myapp/*.log'],
        decoding: { codec: 'json' },
        read_from: 'end',
      },
    },
  ],
  build(opts: FileSourceOptions, buildCtx: BuildContext): FileSourceHandle {
    if (buildCtx.dataDir === undefined) {
      throw new FerruleError(
        'E_FILE_SOURCE_NO_DATA_DIR',
        'the "file" source requires a pipeline data directory (data_dir) to persist checkpoints',
      );
    }
    const dataDir = buildCtx.dataDir;
    const codecs: CodecRegistry = defaultCodecs;
    const [decodingCodec, decodingOptions] = splitCodecOptions(opts.decoding);
    const decoder: Decoder = codecs.createDecoder(decodingCodec, decodingOptions);
    const includeGlobs = opts.include.map((p) => compileGlob(p));
    const excludeGlobs = opts.exclude.map((p) => compileGlob(p));
    const host = hostname();
    const multiline = opts.multiline;

    const tracked = new Map<string, TrackedFile>(); // keyed by identityKey

    async function run(ctx: SourceContext): Promise<void> {
      const checkpointStore = new AtomicJsonStore<CheckpointState>(
        join(dataDir, 'file_checkpoints.json'),
      );
      const checkpoints: CheckpointState = await checkpointStore.load({});
      let checkpointsDirty = false;

      const filesTracked = ctx.metrics.gauge('file_source_files_tracked');
      const bytesRead = ctx.metrics.counter('file_source_bytes_read_total');
      const rotations = ctx.metrics.counter('file_source_rotations_total');
      const truncations = ctx.metrics.counter('file_source_truncations_total');
      const discardedEvents = ctx.metrics.counter(Metrics.discardedEvents);
      const errors = ctx.metrics.counter(Metrics.errors);

      let wake: (() => void) | undefined;
      const watchers: FSWatcher[] = [];
      for (const pattern of opts.include) {
        const dir = resolvePathLike(globStaticPrefix(pattern));
        try {
          const watcher = fsWatch(dir, { persistent: false }, () => wake?.());
          watchers.push(watcher);
        } catch {
          // Best-effort hint only; the poll loop is authoritative regardless.
        }
      }

      async function closeTracked(entry: TrackedFile): Promise<void> {
        if (entry.closed) return;
        entry.closed = true;
        try {
          await entry.handle.close();
        } catch {
          // already gone
        }
      }

      async function persistCheckpointsIfDirty(): Promise<void> {
        if (!checkpointsDirty) return;
        checkpointsDirty = false;
        await checkpointStore.save(checkpoints);
      }

      async function discoverAndTrack(): Promise<void> {
        if (tracked.size >= opts.max_open_files) return;
        let candidates: string[];
        try {
          candidates = await discoverFiles(opts.include, includeGlobs, excludeGlobs);
        } catch (error) {
          ctx.logger.warn('file: discovery failed', { error: describeErr(error) });
          return;
        }
        for (const path of candidates) {
          if (tracked.size >= opts.max_open_files) {
            ctx.logger.warn('file: max_open_files reached; deferring newly discovered files', {
              max_open_files: opts.max_open_files,
            });
            break;
          }
          let st;
          try {
            st = await stat(path);
          } catch {
            continue; // vanished between discovery and stat
          }
          if (!st.isFile()) continue;
          if (
            opts.ignore_older_than !== undefined &&
            Date.now() - st.mtimeMs > opts.ignore_older_than
          ) {
            continue;
          }
          const key = identityKey(st.dev, st.ino);
          if (tracked.has(key)) continue;

          let handle;
          try {
            handle = await open(path, 'r');
          } catch (error) {
            ctx.logger.warn('file: failed to open', { path, error: describeErr(error) });
            continue;
          }

          // A checkpoint's fingerprint hashes a *fixed* number of leading bytes, decided when it
          // was written (`existing.sampledBytes`). Re-deriving that count from the file's
          // *current* size (which only grows as more is appended) would make the fingerprint of
          // a still-growing file never match its own earlier checkpoint — so when resuming, we
          // re-hash exactly the originally-sampled byte count, not `min(fingerprintBytes, size)`.
          const existing = checkpoints[key];
          let startOffset: number;
          if (existing !== undefined) {
            const resumeFingerprint = await computeFingerprint(
              handle,
              st.size,
              existing.sampledBytes,
            );
            const valid =
              existing.sampledBytes === 0 || resumeFingerprint.contentHash === existing.contentHash;
            if (valid) {
              startOffset = Math.min(existing.offset, st.size);
            } else {
              ctx.logger.warn('file: checkpoint fingerprint mismatch; starting over', { path });
              startOffset = opts.read_from === 'beginning' ? 0 : st.size;
              const fresh = await computeFingerprint(handle, st.size, opts.fingerprint_size);
              checkpoints[key] = {
                device: st.dev,
                inode: st.ino,
                contentHash: fresh.contentHash,
                sampledBytes: fresh.sampledBytes,
                offset: startOffset,
                path,
                updatedAtMs: Date.now(),
              };
              checkpointsDirty = true;
            }
          } else {
            startOffset = opts.read_from === 'beginning' ? 0 : st.size;
            const fresh = await computeFingerprint(handle, st.size, opts.fingerprint_size);
            checkpoints[key] = {
              device: st.dev,
              inode: st.ino,
              contentHash: fresh.contentHash,
              sampledBytes: fresh.sampledBytes,
              offset: startOffset,
              path,
              updatedAtMs: Date.now(),
            };
            checkpointsDirty = true;
          }

          tracked.set(key, {
            path,
            device: st.dev,
            inode: st.ino,
            handle,
            diskReadOffset: startOffset,
            outstandingRanges: [],
            checkpointedOffset: startOffset,
            lineRemainder: new Uint8Array(0),
            multilinePending: undefined,
            closed: false,
          });
        }
      }

      function flushMultiline(
        entry: TrackedFile,
      ): { text: string; startOffset: number } | undefined {
        const pending = entry.multilinePending;
        if (pending === undefined) return undefined;
        entry.multilinePending = undefined;
        return { text: pending.lines.join('\n'), startOffset: pending.startOffset };
      }

      function classify(line: string): 'start' | 'continuation' | 'other' {
        if (multiline === undefined) return 'other';
        if (multiline.start_pattern.test(line)) return 'start';
        if (
          multiline.continuation_pattern === undefined ||
          multiline.continuation_pattern.test(line)
        ) {
          return 'continuation';
        }
        return 'other';
      }

      /** Applies one file's newly-split lines through (optional) multiline aggregation, yielding
       * complete raw-text units ready to decode, each paired with the offset safe to checkpoint
       * once it (and everything before it) is acknowledged. */
      function aggregate(
        entry: TrackedFile,
        lines: readonly FrameOut[],
        nowMonoMs: number,
      ): { text: string; throughOffset: number }[] {
        const out: { text: string; throughOffset: number }[] = [];
        if (multiline === undefined) {
          for (const line of lines) {
            out.push({ text: utf8Decoder.decode(line.bytes), throughOffset: line.throughOffset });
          }
          return out;
        }
        for (const line of lines) {
          const text = utf8Decoder.decode(line.bytes);
          const kind = classify(text);
          if (kind === 'start') {
            const flushed = flushMultiline(entry);
            if (flushed !== undefined) {
              out.push({ text: flushed.text, throughOffset: line.throughOffset });
            }
            entry.multilinePending = {
              lines: [text],
              startOffset: line.throughOffset,
              lastLineAtMonoMs: nowMonoMs,
            };
          } else if (kind === 'continuation' && entry.multilinePending !== undefined) {
            entry.multilinePending.lines.push(text);
            entry.multilinePending.lastLineAtMonoMs = nowMonoMs;
            if (entry.multilinePending.lines.length >= multiline.max_lines) {
              const flushed = flushMultiline(entry);
              if (flushed !== undefined) {
                out.push({ text: flushed.text, throughOffset: line.throughOffset });
              }
            }
          } else if (kind === 'continuation') {
            // A continuation line with nothing pending (stream started mid-record): treat it as
            // an implicit start rather than dropping it.
            entry.multilinePending = {
              lines: [text],
              startOffset: line.throughOffset,
              lastLineAtMonoMs: nowMonoMs,
            };
          } else {
            const flushed = flushMultiline(entry);
            if (flushed !== undefined) {
              out.push({ text: flushed.text, throughOffset: line.throughOffset });
            }
            out.push({ text, throughOffset: line.throughOffset });
          }
        }
        return out;
      }

      function maybeFlushTimeout(
        entry: TrackedFile,
        nowMonoMs: number,
      ): { text: string; throughOffset: number } | undefined {
        const pending = entry.multilinePending;
        if (multiline === undefined || pending === undefined) return undefined;
        if (nowMonoMs - pending.lastLineAtMonoMs < multiline.timeout) return undefined;
        // Nothing new arrived to anchor a throughOffset on; the pending lines already account for
        // all bytes read so far (entry.diskReadOffset), which is safe once nothing else is buffered.
        const flushed = flushMultiline(entry);
        return flushed === undefined
          ? undefined
          : { text: flushed.text, throughOffset: entry.diskReadOffset };
      }

      async function processOneTick(entry: TrackedFile, key: string): Promise<void> {
        let st;
        try {
          st = await entry.handle.stat();
        } catch (error) {
          ctx.logger.warn('file: stat failed; will retry', {
            path: entry.path,
            error: describeErr(error),
          });
          return;
        }

        if (st.size < entry.diskReadOffset) {
          truncations.increment();
          ctx.logger.info('file: truncation detected (copytruncate)', {
            path: entry.path,
            size: st.size,
          });
          entry.diskReadOffset = 0;
          entry.outstandingRanges = [];
          entry.checkpointedOffset = 0;
          entry.lineRemainder = new Uint8Array(0);
          entry.multilinePending = undefined;
          const fingerprint = await computeFingerprint(
            entry.handle,
            st.size,
            opts.fingerprint_size,
          );
          checkpoints[key] = {
            device: entry.device,
            inode: entry.inode,
            contentHash: fingerprint.contentHash,
            sampledBytes: fingerprint.sampledBytes,
            offset: 0,
            path: entry.path,
            updatedAtMs: Date.now(),
          };
          checkpointsDirty = true;
        }

        if (entry.outstandingRanges.length >= opts.max_outstanding_chunks) {
          return; // backpressure: too many not-yet-resolved chunks; wait for one to resolve
        }

        const toRead = Math.min(opts.max_read_size_per_tick, st.size - entry.diskReadOffset);
        let chunk = new Uint8Array(0);
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          const { bytesRead: n } = await entry.handle.read(buf, 0, toRead, entry.diskReadOffset);
          chunk = new Uint8Array(buf.buffer, buf.byteOffset, n);
          entry.diskReadOffset += n;
          bytesRead.increment(n);
        }

        const nowMonoMs = ctx.clock.monotonic();
        const split = splitLines(
          entry.lineRemainder,
          entry.diskReadOffset - entry.lineRemainder.length - chunk.length,
          chunk,
          opts.max_line_length,
        );
        entry.lineRemainder = split.newRemainder;

        const units = aggregate(entry, split.lines, nowMonoMs);
        const timeoutFlush = maybeFlushTimeout(entry, nowMonoMs);
        if (timeoutFlush !== undefined) units.push(timeoutFlush);
        if (units.length === 0) return;

        const frames = units.map((u) => new TextEncoder().encode(u.text));
        const { events, errors: decodeErrors } = decodeFrames(decoder, frames);
        if (decodeErrors.length > 0) {
          discardedEvents.increment(decodeErrors.length);
          errors.increment(decodeErrors.length);
          for (const e of decodeErrors) {
            ctx.logger.debug('file: decode error', { path: entry.path, error: e.error.message });
          }
        }
        for (const event of events) {
          if (event instanceof LogEvent) {
            event.set(opts.path_field, entry.path);
            event.set(opts.host_field, host);
          }
        }

        const lastUnitOffset = units[units.length - 1]!.throughOffset;
        if (events.length === 0) {
          queueRange(entry, key, lastUnitOffset, 'delivered');
          return;
        }

        const batch = new BatchNotifier();
        for (const event of events) event.metadata.finalizers.add(batch.createFinalizer());
        batch.seal();
        await ctx.output.send(events, DEFAULT_PORT);

        if (!ctx.acknowledgements) {
          queueRange(entry, key, lastUnitOffset, 'delivered');
          return;
        }

        // Queued as 'pending' and resolved later, not awaited inline: this lets more of this
        // file (or another file entirely) keep being read and sent while this chunk's
        // acknowledgement is still outstanding, instead of one slow delivery stalling every
        // other tracked file. tryAdvanceCheckpoint only ever drains a *contiguous* prefix of
        // resolved ranges, so a later chunk resolving first can't let the watermark skip past
        // this one until this one resolves too.
        const range: OutstandingRange = { endOffset: lastUnitOffset, status: 'pending' };
        entry.outstandingRanges.push(range);
        void batch.completion.then((status) => {
          range.status = status;
          if (status === 'errored') {
            ctx.logger.warn('file: delivery errored; checkpoint will not advance past this chunk', {
              path: entry.path,
            });
            // Left in the queue rather than removed: a restart re-reads from the checkpoint,
            // which this now permanently blocks from advancing past this range for the rest of
            // this run — the documented at-least-once behavior for a transient failure. A
            // later chunk resolving 'delivered' must not be allowed to skip past it.
          }
          tryAdvanceCheckpoint(entry, key);
        });
      }

      /** Queues an already-resolved range (no acknowledgement to wait for) and tries to advance. */
      function queueRange(
        entry: TrackedFile,
        key: string,
        endOffset: number,
        status: DeliveryStatus,
      ): void {
        entry.outstandingRanges.push({ endOffset, status });
        tryAdvanceCheckpoint(entry, key);
      }

      /**
       * Drains and persists the contiguous prefix of `entry.outstandingRanges` that has resolved
       * to something other than `'errored'`: `'pending'` or `'errored'` at the head stops the
       * drain, so the persisted checkpoint can never advance past a chunk that hasn't resolved
       * yet, or one that resolved badly, no matter what resolves after it.
       */
      function tryAdvanceCheckpoint(entry: TrackedFile, key: string): void {
        let advanced = false;
        while (entry.outstandingRanges.length > 0) {
          const head = entry.outstandingRanges[0]!;
          if (head.status === 'pending' || head.status === 'errored') break;
          entry.outstandingRanges.shift();
          entry.checkpointedOffset = head.endOffset;
          advanced = true;
        }
        if (!advanced) return;
        const existing = checkpoints[key];
        if (existing === undefined) return;
        checkpoints[key] = {
          ...existing,
          offset: entry.checkpointedOffset,
          updatedAtMs: Date.now(),
        };
        checkpointsDirty = true;
      }

      async function forgetGoneFiles(): Promise<void> {
        for (const [key, entry] of [...tracked]) {
          // A pending range's completion still resolves fine after the file is forgotten (its
          // callback closes over `entry`/`key` directly, not a `tracked` lookup), but hold off
          // anyway so a file with an acknowledgement genuinely in flight isn't torn down under it.
          if (entry.outstandingRanges.some((r) => r.status === 'pending')) continue;
          try {
            await stat(entry.path);
          } catch {
            // The path is gone. If we're fully caught up (no more bytes beyond what we've read,
            // which for a deleted-but-still-open file cannot grow further), stop tracking it.
            const st = await entry.handle.stat().catch(() => undefined);
            if (st === undefined || entry.diskReadOffset >= st.size) {
              await closeTracked(entry);
              tracked.delete(key);
              rotations.increment();
            }
          }
        }
      }

      // Main poll loop -----------------------------------------------------------------------
      try {
        while (!ctx.signal.aborted) {
          await discoverAndTrack();
          for (const [key, entry] of tracked) {
            try {
              await processOneTick(entry, key);
            } catch (error) {
              errors.increment();
              ctx.logger.error('file: error processing file', {
                path: entry.path,
                error: describeErr(error),
              });
            }
          }
          await forgetGoneFiles();
          await persistCheckpointsIfDirty();
          filesTracked.set(tracked.size);

          const woke = new Promise<void>((resolve) => {
            wake = resolve;
          });
          const timer = ctx.clock.sleep(opts.poll_interval, ctx.signal).catch(() => undefined);
          await Promise.race([woke, timer]);
          wake = undefined;
        }
      } finally {
        for (const watcher of watchers) watcher.close();
        await persistCheckpointsIfDirty();
        for (const entry of tracked.values()) await closeTracked(entry);
      }
    }

    return { run, trackedPaths: () => [...tracked.values()].map((t) => t.path) };
  },
});

async function computeFingerprint(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  fingerprintBytes: number,
): Promise<{ contentHash: string; sampledBytes: number }> {
  const len = Math.min(fingerprintBytes, size);
  if (len === 0) return { contentHash: hashFingerprintBytes(new Uint8Array(0)), sampledBytes: 0 };
  const buf = Buffer.alloc(len);
  await handle.read(buf, 0, len, 0);
  return {
    contentHash: hashFingerprintBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),
    sampledBytes: len,
  };
}

function describeErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default fileSource;
