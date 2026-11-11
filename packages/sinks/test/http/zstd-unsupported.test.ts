import type * as Zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// Forces the "this runtime has no zstd support" path unconditionally, regardless of which Node
// version actually runs this suite — see
// packages/codecs/test/compression/zstd-unsupported.test.ts and
// packages/sinks/test/stream/kafka-sink-zstd-unsupported.test.ts for the same pattern applied to
// the lower-level helper and the Kafka sink respectively. A separate test file because `vi.mock`
// is hoisted to the top of the module and applies for this whole file's imports.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib>();
  return { ...actual, zstdCompressSync: undefined, zstdDecompressSync: undefined };
});

describe('HTTP sink option schemas: zstd on a runtime without zstd support', () => {
  it('httpSinkOptions rejects compression: zstd with a message naming the required Node version', async () => {
    const { httpSinkOptions } = await import('../../src/http/sinks/http.js');
    const result = httpSinkOptions.safeParse({
      url: 'https://example.com/ingest',
      encoding: { codec: 'ndjson' },
      compression: 'zstd',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.message).join(' ')).toContain('22.15.0');
    }
  });

  it('objectStorageSinkOptions (transportSchemaNoAuth) also rejects compression: zstd', async () => {
    const { objectStorageSinkOptions } = await import('../../src/http/sinks/object-storage.js');
    const result = objectStorageSinkOptions.safeParse({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      bucket: 'ferrule-events',
      access_key_id: 'AKIA',
      secret_access_key: 'secret',
      encoding: { codec: 'ndjson' },
      compression: 'zstd',
    });
    expect(result.ok).toBe(false);
  });

  it('constructing an HttpClient with compression: zstd fails defensively too', async () => {
    const { HttpClient } = await import('../../src/http/client.js');
    const { createCapturingLogger } = await import('@ferrule/runtime');
    expect(
      () =>
        new HttpClient({
          logger: createCapturingLogger().logger,
          compression: 'zstd',
        }),
    ).toThrow(/22\.15\.0/);
  });
});
