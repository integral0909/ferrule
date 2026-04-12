import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  createNullLogger,
  MetricsRegistry,
  Pipeline,
  TopologyValidationError,
  type TopologySpec,
} from '@ferrule/runtime';
import { flagNumber, flagString, withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import { EXIT_CONFIG_ERROR, EXIT_OK } from '../exit-codes.js';
import { buildDefaultRegistry } from '../registry.js';
import { writeLine } from '../output.js';
import { UsageError } from '../errors.js';

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(p * (sortedMs.length - 1)));
  return sortedMs[idx]!;
}

export const benchCommand: Command = {
  spec: withGlobalFlags({
    name: 'bench',
    summary: 'Run an in-process benchmark pipeline (demo_logs -> optional script -> blackhole).',
    usage: 'ferrule bench [options]',
    flags: [
      {
        name: 'duration',
        type: 'duration',
        default: 5000,
        description: 'How long to run the benchmark.',
      },
      {
        name: 'events-per-second',
        type: 'integer',
        default: 20_000,
        description:
          'demo_logs generation rate. demo_logs paces itself in one batch per second, so a very ' +
          'high rate mostly measures how long that one batch takes to drain, not steady-state latency.',
      },
      {
        name: 'script',
        type: 'path',
        description: 'A Ferrule Script (.fe) file to insert as a transform.',
      },
    ],
    examples: ['ferrule bench', 'ferrule bench --duration 10s --script redact.fe'],
  }),

  async run(ctx, args) {
    const durationMs = flagNumber(args, 'duration') ?? 5000;
    const eventsPerSecond = flagNumber(args, 'events-per-second') ?? 100_000;
    const scriptPath = flagString(args, 'script');

    const registry = buildDefaultRegistry();
    let scriptSource: string | undefined;
    if (scriptPath !== undefined) {
      if (!registry.has('transform', 'script')) {
        throw new UsageError(
          "the 'script' transform type is not registered in this build of @ferrule/operators; run without --script",
        );
      }
      const path = isAbsolute(scriptPath) ? scriptPath : resolve(ctx.env.cwd, scriptPath);
      scriptSource = await readFile(path, 'utf8');
    }

    const spec: TopologySpec = {
      sources: { demo: { type: 'demo_logs', options: { format: 'json', eventsPerSecond } } },
      transforms:
        scriptSource !== undefined
          ? { xform: { type: 'script', options: { source: scriptSource }, inputs: ['demo'] } }
          : {},
      sinks: {
        sink: {
          type: 'blackhole',
          options: {},
          inputs: [scriptSource !== undefined ? 'xform' : 'demo'],
        },
      },
      settings: {
        healthchecksEnabled: false,
        defaultChannelCapacityEvents: Math.max(50_000, eventsPerSecond * 2),
      },
    };

    const metrics = new MetricsRegistry({ clock: ctx.env.clock });
    let pipeline: Pipeline;
    try {
      pipeline = await Pipeline.create(spec, {
        registry,
        logger: createNullLogger(),
        clock: ctx.env.clock,
        metrics,
      });
    } catch (error) {
      if (error instanceof TopologyValidationError) {
        writeLine(ctx.env.stderr, error.message);
        return EXIT_CONFIG_ERROR;
      }
      throw error;
    }

    const tapTargetId = scriptSource !== undefined ? 'xform' : 'demo';
    // demo_logs generates and sends a whole second's worth of events as one batch, synchronously
    // offering all of them to the tap before this command's consumer loop gets a turn to drain
    // it; a large queue avoids the tap's (small, by-design) default capacity turning into an
    // artificial cap on measured throughput.
    const subscription = pipeline.tap(
      { componentId: tapTargetId },
      { queueCapacity: Math.max(200_000, eventsPerSecond * 4) },
    );
    const latenciesMs: number[] = [];
    const consume = (async (): Promise<void> => {
      for await (const event of subscription) {
        const nowNanos = ctx.env.clock.now().nanos;
        const latencyNs = nowNanos - event.metadata.receivedAt.nanos;
        latenciesMs.push(Number(latencyNs) / 1_000_000);
      }
    })();

    await pipeline.start();
    try {
      await ctx.env.clock.sleep(durationMs);
    } catch {
      // ignore; we're shutting down anyway
    }
    subscription.close();
    await consume;
    await pipeline.stop();

    latenciesMs.sort((a, b) => a - b);
    const seconds = durationMs / 1000;
    const throughput = latenciesMs.length / seconds;

    writeLine(ctx.env.stdout, `events:      ${latenciesMs.length}`);
    writeLine(ctx.env.stdout, `duration:    ${seconds.toFixed(2)}s`);
    writeLine(ctx.env.stdout, `throughput:  ${throughput.toFixed(1)} events/s`);
    writeLine(ctx.env.stdout, `latency p50: ${percentile(latenciesMs, 0.5).toFixed(3)}ms`);
    writeLine(ctx.env.stdout, `latency p90: ${percentile(latenciesMs, 0.9).toFixed(3)}ms`);
    writeLine(ctx.env.stdout, `latency p99: ${percentile(latenciesMs, 0.99).toFixed(3)}ms`);

    return EXIT_OK;
  },
};
