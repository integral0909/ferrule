import { AdminClient, AdminClientError, type MetricEventJson } from '@ferrule/admin';
import type { PipelineHealth } from '@ferrule/runtime';
import { flagNumber, flagString, withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import { EXIT_OK, EXIT_RUNTIME_FAILURE } from '../exit-codes.js';
import { Painter } from '../color.js';
import { write, writeLine } from '../output.js';

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly type: string;
  readonly state: string;
  readonly error: string | undefined;
  readonly inPerSec: number | undefined;
  readonly outPerSec: number | undefined;
  readonly errors: number | undefined;
  readonly bufferEvents: number | undefined;
}

interface CounterSnapshot {
  readonly receivedEvents: number;
  readonly sentEvents: number;
  readonly atMs: number;
}

function counterValue(
  metrics: readonly MetricEventJson[],
  name: string,
  componentId: string,
): number | undefined {
  const m = metrics.find(
    (entry) => entry.name === name && entry.tags['component_id'] === componentId,
  );
  return m !== undefined && m.value.type === 'counter' ? m.value.value : undefined;
}

function buildRows(
  health: PipelineHealth,
  metrics: readonly MetricEventJson[],
  previous: ReadonlyMap<string, CounterSnapshot>,
  nowMs: number,
): { rows: Row[]; snapshots: Map<string, CounterSnapshot> } {
  const snapshots = new Map<string, CounterSnapshot>();
  const rows: Row[] = [];
  for (const component of health.components) {
    const received = counterValue(metrics, 'component_received_events_total', component.id) ?? 0;
    const sent = counterValue(metrics, 'component_sent_events_total', component.id) ?? 0;
    const errors = counterValue(metrics, 'component_errors_total', component.id);
    const bufferEvents = counterValue(metrics, 'buffer_events', component.id);
    const prev = previous.get(component.id);
    const elapsedSec = prev !== undefined ? Math.max(0.001, (nowMs - prev.atMs) / 1000) : undefined;
    snapshots.set(component.id, { receivedEvents: received, sentEvents: sent, atMs: nowMs });
    rows.push({
      id: component.id,
      kind: component.kind,
      type: component.type,
      state: component.state,
      error: component.error,
      inPerSec:
        prev !== undefined && elapsedSec !== undefined
          ? (received - prev.receivedEvents) / elapsedSec
          : undefined,
      outPerSec:
        prev !== undefined && elapsedSec !== undefined
          ? (sent - prev.sentEvents) / elapsedSec
          : undefined,
      errors,
      bufferEvents,
    });
  }
  return { rows, snapshots };
}

function formatRate(n: number | undefined): string {
  return n === undefined ? '-' : n.toFixed(1);
}

function renderTable(paint: Painter, overall: string, rows: readonly Row[]): string {
  const headers = ['ID', 'KIND', 'TYPE', 'STATE', 'IN/s', 'OUT/s', 'ERRORS', 'BUFFER'];
  const cells = rows.map((r) => [
    r.id,
    r.kind,
    r.type,
    r.state,
    formatRate(r.inPerSec),
    formatRate(r.outPerSec),
    r.errors === undefined ? '-' : String(r.errors),
    r.bufferEvents === undefined ? '-' : String(r.bufferEvents),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (parts: readonly string[]): string =>
    parts.map((p, i) => p.padEnd(widths[i]!)).join('  ');
  const lines = [
    `overall: ${overall}`,
    '',
    paint.bold(line(headers)),
    ...cells.map((c) => line(c)),
  ];
  return lines.join('\n');
}

export const topCommand: Command = {
  spec: withGlobalFlags({
    name: 'top',
    summary: "Show a live table of a running pipeline's components.",
    usage: 'ferrule top [options]',
    flags: [
      {
        name: 'api-address',
        type: 'string',
        default: '127.0.0.1:9090',
        description: "The admin API's address.",
      },
      {
        name: 'token',
        type: 'string',
        description: 'Admin API bearer token. Defaults to $FERRULE_API_TOKEN.',
      },
      { name: 'once', type: 'boolean', description: 'Print a single snapshot and exit.' },
      { name: 'interval', type: 'duration', default: 1000, description: 'Refresh interval.' },
    ],
    examples: ['ferrule top', 'ferrule top --once', 'ferrule top --api-address 127.0.0.1:9091'],
  }),

  async run(ctx, args) {
    const baseUrl = `http://${flagString(args, 'api-address') ?? '127.0.0.1:9090'}`;
    const token = flagString(args, 'token') ?? ctx.env.env['FERRULE_API_TOKEN'];
    const client = new AdminClient({ baseUrl, ...(token !== undefined ? { token } : {}) });
    const once = args.flags.get('once') === true;
    const intervalMs = flagNumber(args, 'interval') ?? 1000;
    const interactive = ctx.env.stdout.isTTY === true;
    const paint = new Painter(ctx.color);

    let previous = new Map<string, CounterSnapshot>();
    let stopping = false;
    const unsubs = [
      ctx.env.signals.on('SIGINT', () => {
        stopping = true;
      }),
      ctx.env.signals.on('SIGTERM', () => {
        stopping = true;
      }),
    ];

    try {
      for (;;) {
        let health: PipelineHealth;
        let metrics: readonly MetricEventJson[];
        try {
          [health, metrics] = await Promise.all([client.health(), client.metrics()]);
        } catch (error) {
          if (error instanceof AdminClientError) {
            writeLine(ctx.env.stderr, `${error.code}: ${error.message}`);
            return EXIT_RUNTIME_FAILURE;
          }
          throw error;
        }
        const nowMs = ctx.env.clock.now().toMillis();
        const { rows, snapshots } = buildRows(health, metrics, previous, nowMs);
        previous = snapshots;

        if (interactive) write(ctx.env.stdout, '\x1b[2J\x1b[H');
        writeLine(ctx.env.stdout, renderTable(paint, health.overall, rows));
        if (!interactive) writeLine(ctx.env.stdout, '');

        if (once || stopping) break;
        try {
          await ctx.env.clock.sleep(intervalMs);
        } catch {
          break;
        }
        if (stopping) break;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
    return EXIT_OK;
  },
};
