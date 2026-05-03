import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isLogEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { createStdinSource, stdinSource } from '../src/stdin.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';

function buildCtx(): BuildContext {
  const { logger } = createCapturingLogger();
  return { id: 'stdin', logger, dataDir: undefined, inputs: [] };
}

describe('stdin: declared shape', () => {
  it('reports produces() based on the configured codec', () => {
    expect(stdinSource.produces(stdinSource.options.parse({}))).toEqual(['log']);
    expect(
      stdinSource.produces(stdinSource.options.parse({ decoding: { codec: 'statsd' } })),
    ).toEqual(['metric']);
    expect(
      stdinSource.produces(stdinSource.options.parse({ decoding: { codec: 'otlp_json' } })),
    ).toEqual(['log', 'metric', 'span']);
  });

  it('createStdinSource builds an independent, injectable instance', () => {
    const custom = createStdinSource(Readable.from([]));
    expect(custom.type).toBe('stdin');
    expect(custom).not.toBe(stdinSource);
  });
});

describe('stdin: happy path', () => {
  it('decodes lines in order and resolves run() cleanly on EOF, without an abort', async () => {
    const stdin = Readable.from(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
    const definition = createStdinSource(stdin);
    const opts = definition.options.parse({});
    const handle = await definition.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });

    const runPromise = handle.run(harness.ctx);
    await runPromise; // EOF alone must resolve this; ctx.signal is never aborted in this test.

    expect(harness.ctx.signal.aborted).toBe(false);
    const events = harness.sent.flatMap((b) => b.events).filter(isLogEvent);
    expect(events.map((e) => e.get('n'))).toEqual([1n, 2n, 3n]);
  });

  it('flushes a final line with no trailing newline', async () => {
    const stdin = Readable.from(['{"n":1}\n', '{"n":2}']);
    const definition = createStdinSource(stdin);
    const opts = definition.options.parse({});
    const handle = await definition.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });

    await handle.run(harness.ctx);

    const events = harness.sent.flatMap((b) => b.events).filter(isLogEvent);
    expect(events.map((e) => e.get('n'))).toEqual([1n, 2n]);
  });
});

describe('stdin: decode errors', () => {
  it('skips a malformed line, counts and logs it, and keeps decoding subsequent lines', async () => {
    const stdin = Readable.from(['{"n":1}\n', 'not json at all\n', '{"n":3}\n']);
    const definition = createStdinSource(stdin);
    const opts = definition.options.parse({});
    const handle = await definition.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });

    await handle.run(harness.ctx);

    const events = harness.sent.flatMap((b) => b.events).filter(isLogEvent);
    expect(events.map((e) => e.get('n'))).toEqual([1n, 3n]);
    expect(
      harness.logs.some(
        (r) => r.level === 'warn' && r.message === 'stdin: failed to decode line; skipping it',
      ),
    ).toBe(true);
  });
});

describe('stdin: acknowledgements', () => {
  it('observes delivered, errored, and rejected outcomes per line', async () => {
    const stdin = Readable.from(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
    const definition = createStdinSource(stdin);
    const opts = definition.options.parse({});
    const handle = await definition.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: true });
    const runPromise = handle.run(harness.ctx);

    await waitUntil(() => harness.sent.length === 1);
    for (const e of harness.sent[0]!.events) e.metadata.finalizers.finish('delivered');

    await waitUntil(() => harness.sent.length === 2);
    for (const e of harness.sent[1]!.events) e.metadata.finalizers.finish('errored');

    await waitUntil(() => harness.sent.length === 3);
    for (const e of harness.sent[2]!.events) e.metadata.finalizers.finish('rejected');

    await runPromise;

    expect(harness.logs.some((r) => r.level === 'warn' && r.fields['status'] === 'errored')).toBe(
      true,
    );
    expect(harness.logs.some((r) => r.level === 'warn' && r.fields['status'] === 'rejected')).toBe(
      true,
    );
    // The delivered batch must not have produced any "not delivered" warning.
    expect(harness.logs.filter((r) => r.level === 'warn')).toHaveLength(2);
  });
});

describe('stdin: graceful shutdown', () => {
  it('stops reading and resolves run() promptly when ctx.signal aborts before EOF', async () => {
    const stdin = new PassThrough();
    const definition = createStdinSource(stdin);
    const opts = definition.options.parse({});
    const handle = await definition.build(opts, buildCtx());
    const harness = createControllableSourceContext({ acknowledgements: false });
    const runPromise = handle.run(harness.ctx);

    stdin.write('{"n":1}\n');
    await waitUntil(() => harness.sent.length === 1);

    harness.abort();
    await runPromise; // must not hang waiting for more stdin data or for EOF

    expect(stdin.destroyed).toBe(true);
  });
});
