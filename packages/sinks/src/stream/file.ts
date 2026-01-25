import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as zlib from 'node:zlib';
import { FerruleError, type Event } from '@ferrule/core';
import { defaultCodecs, type CodecRegistry } from '@ferrule/codecs';
import { defineSink, type BuildContext, type Sink, type SinkContext } from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { writeWithBackpressure } from './backpressure-write.js';
import { frameBytes, type FramingMode } from './frame-writer.js';
import { containsUnsafeSegment, resolveWithinBase } from './safe-path.js';
import { compileTemplate, renderTemplate, type CompiledTemplate } from './template.js';

export const fileSinkOptionsSchema = s.object({
  /** Directory every rendered path must stay inside. Created if missing. */
  baseDir: s.string().nonEmpty(),
  /** Path template relative to `baseDir`. Supports `{{ field.path }}` and strftime specifiers
   * (`%Y`, `%m`, `%d`, `%H`, `%M`, `%S`, `%j`), e.g. `"{{ host }}/%Y-%m-%d.log"`. */
  path: s.string().nonEmpty(),
  /** Codec used to encode each event. Default `json`. */
  encoding: s.string().default('json'),
  encodingOptions: s.unknown().optional(),
  framing: s.enum(['newline', 'length_prefixed', 'octet_counting']).default('newline'),
  lengthPrefixWidth: s.enum(['u16', 'u32']).default('u32'),
  lengthPrefixEndianness: s.enum(['BE', 'LE']).default('BE'),
  /** Gzip-compress each file's contents as it is written. Default `false`. */
  gzip: s.boolean().default(false),
  /** Maximum simultaneously open files; least-recently-used ones are closed first. Default 64. */
  maxOpenFiles: s.integer({ min: 1 }).default(64),
  /** Close a file handle after it has not been written to for this long. Default 30s. */
  idleClose: s.duration().default(30_000),
  /** Roll over to a new file once the current one reaches this size (post-compression, if
   * `gzip` is set). Default: no size-based rotation. */
  rotateBytes: s.byteSize().optional(),
  /** Roll over to a new file once the current one has been open this long. Default: no
   * age-based rotation. */
  rotateAge: s.duration().optional(),
  /** `always` fsyncs after every write, `interval` fsyncs periodically, `none` never explicitly
   * syncs. Default `none`. */
  fsync: s.enum(['always', 'interval', 'none']).default('none'),
  /** Interval between fsyncs when `fsync` is `interval`. Default 1s. */
  fsyncInterval: s.duration().default(1_000),
});

export type FileSinkOptions = Infer<typeof fileSinkOptionsSchema>;

function framingModeOf(options: FileSinkOptions): FramingMode {
  if (options.framing === 'length_prefixed') {
    return {
      kind: 'length_prefixed',
      width: options.lengthPrefixWidth,
      endianness: options.lengthPrefixEndianness,
    };
  }
  if (options.framing === 'octet_counting') return { kind: 'octet_counting' };
  return { kind: 'newline' };
}

interface OpenFile {
  readonly logicalKey: string;
  physicalPath: string;
  rotationIndex: number;
  stream: fs.WriteStream;
  gzip: zlib.Gzip | undefined;
  /** Bytes written to this generation, tracked manually rather than read from
   * `stream.bytesWritten` (which only counts bytes the OS has actually flushed and so lags well
   * behind calls to `write()`, making it useless for an immediate rotation decision). Seeded from
   * the file's on-disk size when it is opened, so rotation state survives a restart. */
  bytesWritten: number;
  openedAtMono: number;
  lastUsedAtMono: number;
  lastFsyncAtMono: number;
  fd: number | undefined;
  closing: Promise<void> | undefined;
}

function rotatedPhysicalPath(basePath: string, index: number): string {
  if (index === 0) return basePath;
  const dir = nodePath.dirname(basePath);
  const ext = nodePath.extname(basePath);
  const stem = nodePath.basename(basePath, ext);
  return nodePath.join(dir, `${stem}.${index}${ext}`);
}

/**
 * The reusable core of the `file` sink. Each event's path template is rendered independently, so
 * one sink instance can fan out to many files (e.g. one per `host` field); open file handles are
 * capped by an LRU with idle eviction, and rotation opens a new physical file under an
 * incrementing suffix rather than renaming in place.
 */
export class FileSinkWriter {
  private readonly pathTemplate: CompiledTemplate;
  private readonly framing: FramingMode;
  private readonly encoder;
  private readonly baseDir: string;
  private readonly open = new Map<string, OpenFile>();
  private readonly closingHandles = new Set<Promise<void>>();

  constructor(
    private readonly options: FileSinkOptions,
    private readonly ctx: SinkContext,
    codecs: CodecRegistry = defaultCodecs,
  ) {
    this.pathTemplate = compileTemplate(options.path);
    this.framing = framingModeOf(options);
    this.encoder = codecs.createEncoder(options.encoding, options.encodingOptions);
    this.baseDir = nodePath.resolve(options.baseDir);
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
  }

  /** Writes one event, finishing its finalizers with the outcome. Never throws. */
  async writeEvent(event: Event): Promise<void> {
    const now = this.ctx.clock.now();
    const relative = renderTemplate(this.pathTemplate, event, now);
    if (containsUnsafeSegment(relative) || relative.trim() === '') {
      this.ctx.logger.warn('file sink rejected an event with an unsafe or empty rendered path', {
        template: this.options.path,
        rendered: relative,
      });
      event.metadata.finalizers.finish('rejected');
      return;
    }
    let resolvedBase: string;
    try {
      resolvedBase = resolveWithinBase(this.baseDir, relative);
    } catch (error) {
      this.ctx.logger.warn('file sink rejected an event whose path escapes baseDir', {
        rendered: relative,
        error: error instanceof Error ? error.message : String(error),
      });
      event.metadata.finalizers.finish('rejected');
      return;
    }

    let encoded: Uint8Array;
    try {
      encoded = frameBytes(this.framing, this.encoder.encode(event));
    } catch (error) {
      this.ctx.logger.warn('file sink failed to encode an event', {
        error: error instanceof FerruleError ? `${error.code}: ${error.message}` : String(error),
      });
      event.metadata.finalizers.finish('rejected');
      return;
    }

    try {
      const file = await this.acquireFile(relative, resolvedBase, encoded.length);
      await writeWithBackpressure(file.gzip ?? file.stream, encoded, this.ctx.signal);
      file.bytesWritten += encoded.length;
      file.lastUsedAtMono = this.ctx.clock.monotonic();
      await this.maybeSync(file);
      event.metadata.finalizers.finish('delivered');
    } catch (error) {
      this.ctx.logger.error('file sink failed to write an event', {
        path: resolvedBase,
        error: error instanceof Error ? error.message : String(error),
      });
      event.metadata.finalizers.finish('errored');
    }
  }

  /** Gets (opening or rotating as needed) the handle for `logicalKey`, enforcing the open-file cap. */
  private async acquireFile(
    logicalKey: string,
    basePath: string,
    incomingBytes: number,
  ): Promise<OpenFile> {
    const existing = this.open.get(logicalKey);
    let file: OpenFile | undefined;
    if (existing !== undefined) {
      this.open.delete(logicalKey);
      if (this.shouldRotate(existing, incomingBytes)) {
        await this.closeFile(existing, /* awaitClose */ true);
        // An explicit rotation always advances to a strictly newer generation, regardless of
        // what that new file's size on disk happens to be.
        file = await this.openGeneration(logicalKey, basePath, existing.rotationIndex + 1);
      } else {
        file = existing;
      }
    } else {
      // No in-memory handle: resume from whatever generation is under the size limit on disk
      // (or generation 0, if rotation-by-size is not configured), so a restart does not silently
      // reuse a file that was already full.
      file = await this.openGeneration(logicalKey, basePath, await this.resumeIndex(basePath));
    }
    this.open.set(logicalKey, file); // reinsert: marks as most-recently-used
    await this.enforceOpenFileCap();
    return file;
  }

  private shouldRotate(file: OpenFile, incomingBytes: number): boolean {
    const { rotateBytes, rotateAge } = this.options;
    if (
      rotateBytes !== undefined &&
      file.bytesWritten > 0 &&
      file.bytesWritten + incomingBytes > rotateBytes
    ) {
      return true;
    }
    if (rotateAge !== undefined && this.ctx.clock.monotonic() - file.openedAtMono >= rotateAge) {
      return true;
    }
    return false;
  }

  /** Finds the first generation index (starting at 0) that is not already at or past the
   * configured size limit, so restarting the process resumes rotation correctly. */
  private async resumeIndex(basePath: string): Promise<number> {
    if (this.options.rotateBytes === undefined) return 0;
    let index = 0;
    for (;;) {
      const stat = await fsp.stat(rotatedPhysicalPath(basePath, index)).catch(() => undefined);
      if (stat === undefined || stat.size < this.options.rotateBytes) return index;
      index++;
    }
  }

  private async openGeneration(
    logicalKey: string,
    basePath: string,
    index: number,
  ): Promise<OpenFile> {
    const physicalPath = rotatedPhysicalPath(basePath, index);
    await fsp.mkdir(nodePath.dirname(physicalPath), { recursive: true });
    const existingSize = (await fsp.stat(physicalPath).catch(() => undefined))?.size ?? 0;
    const stream = fs.createWriteStream(physicalPath, { flags: 'a' });
    const fd = await onceOpen(stream);
    const gzip = this.options.gzip ? zlib.createGzip() : undefined;
    gzip?.pipe(stream);
    const nowMono = this.ctx.clock.monotonic();
    return {
      logicalKey,
      physicalPath,
      rotationIndex: index,
      stream,
      gzip,
      bytesWritten: existingSize,
      openedAtMono: nowMono,
      lastUsedAtMono: nowMono,
      lastFsyncAtMono: nowMono,
      fd,
      closing: undefined,
    };
  }

  private async maybeSync(file: OpenFile): Promise<void> {
    if (this.options.fsync === 'none') return;
    const nowMono = this.ctx.clock.monotonic();
    if (
      this.options.fsync === 'interval' &&
      nowMono - file.lastFsyncAtMono < this.options.fsyncInterval
    ) {
      return;
    }
    file.lastFsyncAtMono = nowMono;
    await fsyncFile(file);
  }

  private async enforceOpenFileCap(): Promise<void> {
    while (this.open.size > this.options.maxOpenFiles) {
      const oldestKey = this.open.keys().next().value;
      if (oldestKey === undefined) return;
      const victim = this.open.get(oldestKey);
      this.open.delete(oldestKey);
      if (victim !== undefined) await this.closeFile(victim, true);
    }
  }

  /** Closes idle handles; called periodically by the sink's background loop. */
  async closeIdle(): Promise<void> {
    const nowMono = this.ctx.clock.monotonic();
    const idleKeys: string[] = [];
    for (const [key, file] of this.open) {
      if (nowMono - file.lastUsedAtMono >= this.options.idleClose) idleKeys.push(key);
    }
    for (const key of idleKeys) {
      const file = this.open.get(key);
      if (file === undefined) continue;
      this.open.delete(key);
      await this.closeFile(file, true);
    }
  }

  private async closeFile(file: OpenFile, awaitClose: boolean): Promise<void> {
    const closePromise = (async (): Promise<void> => {
      if (this.options.fsync !== 'none') await fsyncFile(file).catch(() => undefined);
      if (file.gzip !== undefined) await endStream(file.gzip);
      await endStream(file.stream);
    })();
    this.closingHandles.add(closePromise);
    const tracked = closePromise.finally(() => this.closingHandles.delete(closePromise));
    if (awaitClose) await tracked;
  }

  /** Closes every open file and waits for all pending closes. Called when the sink stops. */
  async closeAll(): Promise<void> {
    const files = [...this.open.values()];
    this.open.clear();
    await Promise.all(files.map((file) => this.closeFile(file, true)));
    await Promise.all([...this.closingHandles]);
  }

  get openFileCount(): number {
    return this.open.size;
  }
}

function onceOpen(stream: fs.WriteStream): Promise<number> {
  return new Promise((resolve, reject) => {
    stream.once('open', (fd: number) => resolve(fd));
    stream.once('error', (err) => reject(err));
  });
}

function fsyncFile(file: OpenFile): Promise<void> {
  if (file.fd === undefined) return Promise.resolve();
  const fd = file.fd;
  return new Promise((resolve, reject) => {
    fs.fsync(fd, (err) => (err ? reject(err) : resolve()));
  });
}

function endStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

/** Background loop that periodically closes idle file handles until `signal` aborts. */
async function runIdleCloseLoop(
  writer: FileSinkWriter,
  ctx: SinkContext,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      await ctx.clock.sleep(intervalMs, signal);
    } catch {
      return;
    }
    await writer.closeIdle().catch((error: unknown) => {
      ctx.logger.warn('file sink idle-close pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function createFileSink(
  options: FileSinkOptions,
  codecs: CodecRegistry = defaultCodecs,
): Sink {
  return {
    async run(ctx: SinkContext): Promise<void> {
      const writer = new FileSinkWriter(options, ctx, codecs);
      await writer.start();
      const idleLoopInterval = Math.max(1, Math.min(options.idleClose, 5_000));
      // The idle-close loop must stop as soon as the main loop below does, even if that happens
      // before `ctx.signal` fires (input can end slightly ahead of the abort in some shutdown
      // orderings), so it is driven by its own controller rather than `ctx.signal` directly.
      const stopIdleLoop = new AbortController();
      const forwardAbort = (): void => stopIdleLoop.abort(ctx.signal.reason);
      if (ctx.signal.aborted) stopIdleLoop.abort(ctx.signal.reason);
      else ctx.signal.addEventListener('abort', forwardAbort, { once: true });
      const idleLoop = runIdleCloseLoop(writer, ctx, idleLoopInterval, stopIdleLoop.signal);
      try {
        for await (const batch of ctx.input) {
          for (const event of batch) await writer.writeEvent(event);
        }
      } finally {
        ctx.signal.removeEventListener('abort', forwardAbort);
        stopIdleLoop.abort();
        await idleLoop;
        await writer.closeAll();
      }
    },
    async healthcheck(): Promise<void> {
      await fsp
        .mkdir(nodePath.resolve(options.baseDir), { recursive: true })
        .catch((error: unknown) => {
          throw new FerruleError(
            'E_FILE_SINK_BASEDIR',
            `cannot create base directory ${options.baseDir}: ${String(error)}`,
          );
        });
    },
  };
}

export const fileSink = defineSink({
  kind: 'sink',
  type: 'file',
  description:
    'Writes events to files chosen per event by a path template, with rotation and gzip.',
  options: fileSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'One gzip-compressed file per host per day',
      config: { baseDir: '/var/log/ferrule', path: '{{ host }}/%Y-%m-%d.log.gz', gzip: true },
    },
  ],
  build: (options: FileSinkOptions, _ctx: BuildContext) => createFileSink(options),
});
