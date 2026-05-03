import * as os from 'node:os';
import {
  concatBytes,
  isLogEvent,
  utf8Encode,
  type Event,
  type Path,
  type Timestamp,
} from '@ferrule/core';
import { encodeSyslog5424, type Syslog5424Message } from '@ferrule/codecs';
import {
  defineSink,
  runBatchedSink,
  type BuildContext,
  type Logger,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { batchSchema, buildRetryPolicy, retrySchema, tlsSchema } from '../fragments.js';
import { writeWithBackpressure } from './backpressure-write.js';
import { frameBytes, type FramingMode } from './frame-writer.js';
import {
  compileTemplate,
  getEventField,
  renderTemplate,
  type CompiledTemplate,
} from './template.js';
import { TcpTransport, UdpTransport, type Transport } from './wire-transport.js';

/** Standard RFC 5424 level-name aliases, mapped to their severity code (0 = most severe). */
const DEFAULT_LEVEL_MAP: Readonly<Record<string, number>> = {
  emergency: 0,
  emerg: 0,
  alert: 1,
  critical: 2,
  crit: 2,
  fatal: 2,
  error: 3,
  err: 3,
  warning: 4,
  warn: 4,
  notice: 5,
  info: 6,
  informational: 6,
  debug: 7,
  trace: 7,
};

export const syslogSinkOptionsSchema = s.object({
  protocol: s.enum(['tcp', 'udp']).default('tcp'),
  host: s.string().nonEmpty(),
  port: s.integer({ min: 1, max: 65535 }).default(514),
  tls: tlsSchema,
  /** TCP framing per RFC 6587. `octet_counting` is the transparent framing the RFC recommends;
   * `newline` is the common non-transparent alternative many receivers also accept. Ignored for
   * UDP, where each event is always its own datagram. */
  framing: s.enum(['octet_counting', 'newline']).default('octet_counting'),
  /** Facility (0-23) used when `facility_field` is unset or the event's value is out of range. */
  default_facility: s.integer({ min: 0, max: 23 }).default(1),
  /** Event field holding a numeric facility override. */
  facility_field: s.fieldPath().optional(),
  /** Severity (0-7) used when neither `severity_field` nor `level_field` resolves one. */
  default_severity: s.integer({ min: 0, max: 7 }).default(6),
  /** Event field holding a numeric severity (0-7) override; takes priority over `level_field`. */
  severity_field: s.fieldPath().optional(),
  /** Event field holding a textual level (`"error"`, `"warn"`, ...), mapped via `level_map`. */
  level_field: s.fieldPath().optional(),
  /** Extra (or overriding) level-name-to-severity entries, merged over the RFC 5424 defaults. */
  level_map: s.record(s.integer({ min: 0, max: 7 })).optional(),
  /** APP-NAME template. Supports `{{ field.path }}`. Default `"ferrule"`. */
  app_name: s.string().default('ferrule'),
  /** HOSTNAME template. Default: the local hostname. */
  hostname: s.string().optional(),
  /** Event field used as MSGID. */
  msg_id_field: s.fieldPath().optional(),
  /** Event field used as PROCID. */
  proc_id_field: s.fieldPath().optional(),
  /** Event field used as the MSG part (free text after the header). Default `"message"`. */
  message_field: s.fieldPath().optional(),
  /** Groups events into batches before writing them. Default: 500 events / 1MiB / 1s. */
  batch: batchSchema,
  /** UDP only: a datagram larger than this is rejected rather than sent. Default 65507 (the
   * maximum IPv4 UDP payload). */
  max_datagram_size: s.byteSize().default(65_507),
  connect_timeout: s.duration().default(10_000),
  /** Reconnect/retry backoff for TCP connection and write failures. Default 250ms/30s. */
  retry: retrySchema,
});

export type SyslogSinkOptions = Infer<typeof syslogSinkOptionsSchema>;

function framingModeOf(options: SyslogSinkOptions): FramingMode {
  return options.framing === 'newline' ? { kind: 'newline' } : { kind: 'octet_counting' };
}

function numberField(event: Event, path: Path | undefined): number | undefined {
  if (path === undefined) return undefined;
  const value = getEventField(event, path);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return undefined;
}

function stringField(event: Event, path: Path | undefined): string | undefined {
  if (path === undefined) return undefined;
  const value = getEventField(event, path);
  return typeof value === 'string' ? value : undefined;
}

function resolveSeverity(
  options: SyslogSinkOptions,
  levelMap: Record<string, number>,
  event: Event,
): number {
  const explicit = numberField(event, options.severity_field);
  if (explicit !== undefined && explicit >= 0 && explicit <= 7) return explicit;
  const level = stringField(event, options.level_field);
  if (level !== undefined) {
    const mapped = levelMap[level.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  return options.default_severity;
}

function resolveFacility(options: SyslogSinkOptions, event: Event): number {
  const explicit = numberField(event, options.facility_field);
  if (explicit !== undefined && explicit >= 0 && explicit <= 23) return explicit;
  return options.default_facility;
}

function structuredDataOf(event: Event): Map<string, Map<string, string>> {
  const data = new Map<string, Map<string, string>>();
  if (!isLogEvent(event)) return data;
  const field = event.get('structured_data');
  if (!(field instanceof Map)) return data;
  for (const [sdId, params] of field) {
    if (!(params instanceof Map)) continue;
    const p = new Map<string, string>();
    for (const [name, value] of params) {
      if (typeof value === 'string') p.set(name, value);
    }
    data.set(sdId, p);
  }
  return data;
}

const DEFAULT_MESSAGE_PATH: Path = ['message'];

function buildMessage(
  options: SyslogSinkOptions,
  levelMap: Record<string, number>,
  appNameTemplate: CompiledTemplate,
  hostnameTemplate: CompiledTemplate | undefined,
  event: Event,
  now: Timestamp,
): Syslog5424Message {
  const messagePath = options.message_field ?? DEFAULT_MESSAGE_PATH;
  const message = stringField(event, messagePath);
  const msg: Syslog5424Message = {
    facility: resolveFacility(options, event),
    severity: resolveSeverity(options, levelMap, event),
    version: 1,
    timestamp: now,
    hostname:
      hostnameTemplate === undefined ? os.hostname() : renderTemplate(hostnameTemplate, event, now),
    appName: renderTemplate(appNameTemplate, event, now),
    procId: stringField(event, options.proc_id_field),
    msgId: stringField(event, options.msg_id_field),
    structuredData: structuredDataOf(event),
    message,
  };
  return msg;
}

function makeTransport(options: SyslogSinkOptions, logger: Logger): Transport {
  return options.protocol === 'udp'
    ? new UdpTransport(options)
    : new TcpTransport(options, logger, writeWithBackpressure);
}

function makeEncodeBatch(
  options: SyslogSinkOptions,
  levelMap: Record<string, number>,
  appNameTemplate: CompiledTemplate,
  hostnameTemplate: CompiledTemplate | undefined,
  framing: FramingMode,
  ctx: SinkContext,
): (events: Event[]) => Uint8Array {
  return (events: Event[]): Uint8Array => {
    const now = ctx.clock.now();
    const parts: Uint8Array[] = [];
    for (const event of events) {
      const msg = buildMessage(options, levelMap, appNameTemplate, hostnameTemplate, event, now);
      const bytes = utf8Encode(encodeSyslog5424(msg));
      if (options.protocol === 'udp') {
        if (bytes.length > options.max_datagram_size) {
          ctx.logger.warn('syslog sink rejected an oversize UDP datagram', {
            size: bytes.length,
            max_datagram_size: options.max_datagram_size,
          });
          event.metadata.finalizers.finish('rejected');
          continue;
        }
        parts.push(bytes);
      } else {
        parts.push(frameBytes(framing, bytes));
      }
    }
    return concatBytes(parts);
  };
}

export function createSyslogSink(options: SyslogSinkOptions): Sink {
  const levelMap: Record<string, number> = { ...DEFAULT_LEVEL_MAP };
  if (options.level_map !== undefined) {
    for (const [name, severity] of options.level_map) levelMap[name] = severity;
  }
  const appNameTemplate = compileTemplate(options.app_name);
  const hostnameTemplate =
    options.hostname !== undefined ? compileTemplate(options.hostname) : undefined;
  const framing = framingModeOf(options);
  return {
    async run(ctx: SinkContext): Promise<void> {
      const transport = makeTransport(options, ctx.logger);
      const encodeBatch = makeEncodeBatch(
        options,
        levelMap,
        appNameTemplate,
        hostnameTemplate,
        framing,
        ctx,
      );
      const isUdp = options.protocol === 'udp';
      try {
        await runBatchedSink(ctx, {
          maxEvents: isUdp ? 1 : (options.batch?.max_events ?? 500),
          ...(isUdp
            ? {}
            : {
                maxBytes: options.batch?.max_size ?? 1024 * 1024,
                timeoutMs: options.batch?.timeout ?? 1_000,
              }),
          encode: encodeBatch,
          send: (payload) => transport.send(payload, ctx.signal),
          retry: buildRetryPolicy(options.retry ?? { initial_backoff: 250, max_backoff: 30_000 }),
        });
      } finally {
        await transport.close();
      }
    },
    async healthcheck(ctx): Promise<void> {
      const probe = makeTransport(options, ctx.logger);
      try {
        await probe.probe();
      } finally {
        await probe.close();
      }
    },
  };
}

export const syslogSink = defineSink({
  kind: 'sink',
  type: 'syslog',
  description: 'Writes events as RFC 5424 syslog messages over TCP, TLS, or UDP.',
  options: syslogSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    { title: 'RFC 5424 over TCP with octet-counting', config: { host: '127.0.0.1', port: 6514 } },
    {
      title: 'Severity taken from a level field',
      config: { host: '127.0.0.1', port: 514, protocol: 'udp', level_field: 'level' },
    },
  ],
  build: (options: SyslogSinkOptions, _ctx: BuildContext) => createSyslogSink(options),
});
