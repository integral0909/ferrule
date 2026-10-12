import type * as Zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// Forces the "this runtime has no zstd support" path unconditionally, regardless of which Node
// version actually runs this suite, by mocking `node:zlib` to hide `zstdCompressSync`/
// `zstdDecompressSync` — see `packages/codecs/test/compression/zstd-unsupported.test.ts` for the
// same pattern applied to the lower-level helper this sink's option schema calls into. A separate
// test file because `vi.mock` is hoisted to the top of the module and applies for this whole
// file's imports (including `@ferrule/codecs`'s transitive `node:zlib` import).
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib>();
  return { ...actual, zstdCompressSync: undefined, zstdDecompressSync: undefined };
});

describe('kafka sink options validation: zstd on a runtime without zstd support', () => {
  it('rejects compression: zstd at config validation with a message naming the required Node version', async () => {
    const { kafkaSinkOptionsSchema } = await import('../../src/kafka/sink.js');
    const result = kafkaSinkOptionsSchema.safeParse({
      brokers: ['127.0.0.1:9092'],
      topic: 'events',
      encoding: { codec: 'json' },
      compression: 'zstd',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.issues.map((i) => i.message).join(' ');
      expect(message).toContain('22.15.0');
    }
  });

  it('KafkaProducer also rejects compression: zstd defensively at construction', async () => {
    const { KafkaProducer } = await import('../../src/kafka/producer.js');
    expect(
      () =>
        new KafkaProducer({
          bootstrapBrokers: [{ host: '127.0.0.1', port: 9092 }],
          compression: 'zstd',
        }),
    ).toThrow(/22\.15\.0/);
  });
});
