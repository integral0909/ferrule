/**
 * Compares `none`, `gzip` and `zstd` on realistic JSON log batches pushed through the real Kafka
 * RecordBatch encoder — the configuration the sink ships (gzip at zlib's default level 6, zstd at
 * level 3), not the codecs in isolation.
 *
 * Run (needs a build, since it loads `dist/`):
 *   pnpm run build && node --experimental-strip-types packages/sinks/bench/kafka-compression.ts
 *
 * Two tables per batch size:
 * - "end to end": the whole `encodeRecordBatch` call, i.e. what the sink pays per batch. Encoding
 *   is synchronous, so its p50/p99 are also how long one batch holds the event loop.
 * - "codec only": just the compression call the encoder makes, on the exact records section,
 *   because per-record framing dominates the end-to-end time and its noise can swamp the codec
 *   difference. zstd level 1 is listed for context only; the sink does not expose a level.
 *
 * Not part of CI: timings depend on the machine.
 */

/** RecordBatch v2 header bytes before the records section. */
const BATCH_HEADER_BYTES = 61;
import * as zlib from 'node:zlib';
import { zstdCompress, zstdDecompress } from '../dist/compression/zstd.js';
import { decodeRecordBatch, encodeRecordBatch } from '../dist/kafka/record-batch.js';
import type { CompressionType, RecordInput } from '../dist/kafka/record-batch.js';
import { logLines } from '../test/support/log-lines.ts';

const CODECS = ['none', 'gzip', 'zstd'] as const satisfies readonly CompressionType[];
/** The sink's default batch is 500 events; 100 and 2000 bracket it. */
const BATCH_SIZES = [100, 500, 2000] as const;
/** Distinct batches cycled through, so one batch's bytes are not just sitting in cache. */
const DISTINCT_BATCHES = 16;
const MIN_ITERATIONS = 60;
const MIN_TIME_MS = 1500;

function makeBatch(size: number, seed: number): RecordInput[] {
  const records: RecordInput[] = [];
  let i = 0;
  for (const line of logLines(size, seed)) {
    const parsed = JSON.parse(line) as { service: string };
    records.push({
      key: Buffer.from(parsed.service), // keyed by service, like a typical topic layout
      value: Buffer.from(line),
      headers: [],
      timestamp: 1_763_553_600_000n + BigInt(i++ * 7),
    });
  }
  return records;
}

interface Timing {
  readonly p50: number;
  readonly p99: number;
  readonly mean: number;
}

function time(fn: (iteration: number) => void): Timing {
  for (let i = 0; i < 10; i++) fn(i); // warm up the JIT and zlib's allocators
  const samples: number[] = [];
  const deadline = performance.now() + MIN_TIME_MS;
  for (let i = 0; samples.length < MIN_ITERATIONS || performance.now() < deadline; i++) {
    const start = process.hrtime.bigint();
    fn(i);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  return { p50: at(0.5), p99: at(0.99), mean: samples.reduce((a, b) => a + b, 0) / samples.length };
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function print(line: string): void {
  // eslint-disable-next-line no-console -- a benchmark script's whole job is printing results
  console.log(line);
}

print(
  `node ${process.version}, libzstd ${process.versions['zstd'] ?? '?'}, zlib ${process.versions.zlib}`,
);
print(`timings: per-batch p50 / p99 over >=${MIN_ITERATIONS} runs and >=${MIN_TIME_MS}ms\n`);

for (const size of BATCH_SIZES) {
  const batches = Array.from({ length: DISTINCT_BATCHES }, (_, i) => makeBatch(size, 100 + i));
  const rawBytes = encodeRecordBatch(batches[0]!).length;
  print(`batch of ${size} events, ${(rawBytes / 1024).toFixed(1)} KiB uncompressed — end to end`);
  print(
    `  ${'codec'.padEnd(6)}${pad('wire KiB', 10)}${pad('ratio', 8)}` +
      `${pad('enc p50', 10)}${pad('enc p99', 10)}${pad('enc MB/s', 10)}${pad('events/s', 12)}` +
      `${pad('dec p50', 10)}`,
  );
  let baseline: number | undefined;
  for (const codec of CODECS) {
    const encoded = batches.map((b) => encodeRecordBatch(b, { compression: codec }));
    const wireBytes = encoded.reduce((n, e) => n + e.length, 0) / encoded.length;
    const enc = time((i) => {
      encodeRecordBatch(batches[i % DISTINCT_BATCHES]!, { compression: codec });
    });
    const dec = time((i) => {
      decodeRecordBatch(encoded[i % DISTINCT_BATCHES]!);
    });
    baseline ??= enc.mean;
    const mbps = rawBytes / 1e6 / (enc.mean / 1e3);
    const delta = enc.mean - baseline;
    const extra =
      codec === 'none'
        ? ''
        : `   (${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)}ms vs none)`;
    print(
      `  ${codec.padEnd(6)}${pad((wireBytes / 1024).toFixed(1), 10)}` +
        `${pad(((wireBytes / rawBytes) * 100).toFixed(1) + '%', 8)}` +
        `${pad(enc.p50.toFixed(2) + 'ms', 10)}${pad(enc.p99.toFixed(2) + 'ms', 10)}` +
        `${pad(mbps.toFixed(0), 10)}${pad(Math.round(size / (enc.mean / 1e3)).toLocaleString('en-US'), 12)}` +
        `${pad(dec.p50.toFixed(2) + 'ms', 10)}${extra}`,
    );
  }

  const sections = batches.map((b) => encodeRecordBatch(b).subarray(BATCH_HEADER_BYTES));
  const sectionBytes = sections[0]!.length;
  const codecs: [string, (b: Buffer) => Buffer, (b: Buffer) => Buffer][] = [
    ['gzip-6', (b) => zlib.gzipSync(b), (b) => zlib.gunzipSync(b)],
    ['zstd-3', (b) => zstdCompress(b), (b) => zstdDecompress(b)],
    ['zstd-1*', (b) => zstdCompress(b, { level: 1 }), (b) => zstdDecompress(b)],
  ];
  print(`  codec only, on the ${(sectionBytes / 1024).toFixed(1)} KiB records section:`);
  print(
    `  ${'codec'.padEnd(8)}${pad('ratio', 8)}${pad('comp p50', 10)}${pad('comp MB/s', 11)}${pad('dec p50', 10)}${pad('dec MB/s', 10)}`,
  );
  for (const [name, compress, decompress] of codecs) {
    const compressed = sections.map((x) => compress(x));
    const ratio = compressed.reduce((n, c) => n + c.length, 0) / (sections.length * sectionBytes);
    const comp = time((i) => {
      compress(sections[i % DISTINCT_BATCHES]!);
    });
    const dec = time((i) => {
      decompress(compressed[i % DISTINCT_BATCHES]!);
    });
    const rate = (t: Timing): string => (sectionBytes / 1e6 / (t.p50 / 1e3)).toFixed(0);
    print(
      `  ${name.padEnd(8)}${pad((ratio * 100).toFixed(1) + '%', 8)}${pad(comp.p50.toFixed(2) + 'ms', 10)}` +
        `${pad(rate(comp), 11)}${pad(dec.p50.toFixed(2) + 'ms', 10)}${pad(rate(dec), 10)}`,
    );
  }
  print('');
}
print('* not selectable in the sink; shown for context.');
