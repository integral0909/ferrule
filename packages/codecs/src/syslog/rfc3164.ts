import { createMetadata, LogEvent, Timestamp, utf8Decode, type ValueMap } from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';

const CODEC = 'syslog3164';

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_SYSLOG3164_SYNTAX', message, offset);
}

/** A decoded RFC 3164 ("BSD syslog") message. */
export interface Syslog3164Message {
  facility: number | undefined;
  severity: number | undefined;
  timestamp: Timestamp;
  hostname: string | undefined;
  tag: string | undefined;
  procId: string | undefined;
  message: string;
}

export interface Rfc3164DecodeOptions {
  /** Reference clock used to infer the year (RFC 3164 timestamps have none). Default `Timestamp.now()`. */
  now?: Timestamp;
  /**
   * The timezone the (zoneless) timestamp is assumed to be in: a fixed UTC offset in minutes, or
   * an IANA zone name (resolved with `Intl.DateTimeFormat`, so DST is handled correctly for the
   * inferred date). Default `0` (UTC).
   */
  timezone?: number | string;
}

const MONTHS: ReadonlyMap<string, number> = new Map(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map(
    (m, i) => [m, i + 1],
  ),
);

const HEADER = /^(?:<(\d{1,3})>)?([A-Za-z]{3})\s+(\d{1,2})\s(\d{2}):(\d{2}):(\d{2})\s/;
const TAG = /^([^ \t:[\]]{1,32})(?:\[(\d+)])?:\s?/;

/** Parses one RFC 3164 syslog message (a single line, without its framing terminator). */
export function parseSyslog3164(
  input: string | Uint8Array,
  options: Rfc3164DecodeOptions = {},
): Syslog3164Message {
  const text = typeof input === 'string' ? input : utf8Decode(input, 'lossy');
  const m = HEADER.exec(text);
  if (m === null) fail('malformed RFC 3164 header');
  const [, pri, monthName, day, hour, minute, second] = m as unknown as [
    string,
    string | undefined,
    string,
    string,
    string,
    string,
    string,
  ];
  const month = MONTHS.get(monthName.toLowerCase());
  if (month === undefined) fail(`unrecognised month ${JSON.stringify(monthName)}`);

  const now = options.now ?? Timestamp.now();
  const offsetMinutes = resolveOffsetMinutes(options.timezone ?? 0, now);
  const timestamp = inferTimestamp(
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    now,
    offsetMinutes,
  );

  const pos = m[0].length;
  const rest = text.slice(pos);

  // HOSTNAME is present when a second, distinct token precedes the TAG; some senders omit it.
  // Heuristic: look for "<token> <possible tag>" where token has no ':' or '['; otherwise treat
  // the rest of the line as TAG/MSG with no hostname.
  const spaceIdx = rest.indexOf(' ');
  let hostname: string | undefined;
  let remainder = rest;
  if (spaceIdx > 0) {
    const candidate = rest.slice(0, spaceIdx);
    if (!candidate.includes(':') && TAG.test(rest.slice(spaceIdx + 1))) {
      hostname = candidate;
      remainder = rest.slice(spaceIdx + 1);
    }
  }

  const tagMatch = TAG.exec(remainder);
  let tag: string | undefined;
  let procId: string | undefined;
  let message: string;
  if (tagMatch !== null) {
    tag = tagMatch[1];
    procId = tagMatch[2];
    message = remainder.slice(tagMatch[0].length);
  } else {
    message = remainder;
  }

  return {
    facility: pri === undefined ? undefined : Number(pri) >> 3,
    severity: pri === undefined ? undefined : Number(pri) & 0x7,
    timestamp,
    hostname,
    tag,
    procId,
    message,
  };
}

function resolveOffsetMinutes(timezone: number | string, at: Timestamp): number {
  if (typeof timezone === 'number') return timezone;
  return ianaOffsetMinutes(timezone, at);
}

/** Resolves an IANA zone's UTC offset (in minutes) at approximately `at`, using `Intl` (no
 * bundled timezone database is needed since Node ships one via ICU). */
function ianaOffsetMinutes(zone: string, at: Timestamp): number {
  const date = at.toDate();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(date);
  } catch (cause) {
    throw new CodecSyntaxError(
      CODEC,
      'E_SYSLOG3164_TIMEZONE',
      `unknown IANA timezone ${JSON.stringify(zone)}`,
      undefined,
      {
        cause,
      },
    );
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Builds a {@link Timestamp} from zoneless month/day/time fields, inferring the year from `now`.
 * The candidate year is `now`'s year; if that would place the message more than one day in the
 * future (accounting for clock skew across a year boundary, e.g. a Dec 31 message arriving just
 * after midnight on Jan 1), the previous year is used instead.
 */
function inferTimestamp(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  now: Timestamp,
  offsetMinutes: number,
): Timestamp {
  const nowCivil = now.toCivil();
  const candidateLocal = Timestamp.fromCivil({
    year: nowCivil.year,
    month,
    day,
    hour,
    minute,
    second,
  });
  const candidate = candidateLocal.add(-BigInt(offsetMinutes) * 60_000_000_000n);
  const oneDayNanos = 86_400_000_000_000n;
  if (candidate.since(now) > oneDayNanos) {
    const previousYearLocal = Timestamp.fromCivil({
      year: nowCivil.year - 1,
      month,
      day,
      hour,
      minute,
      second,
    });
    return previousYearLocal.add(-BigInt(offsetMinutes) * 60_000_000_000n);
  }
  return candidate;
}

/** Decodes one RFC 3164 line directly into a {@link LogEvent}. */
export function decodeSyslog3164ToLogEvent(
  input: string | Uint8Array,
  options: Rfc3164DecodeOptions = {},
): LogEvent {
  const msg = parseSyslog3164(input, options);
  const fields: ValueMap = new Map();
  fields.set('timestamp', msg.timestamp);
  if (msg.severity !== undefined) fields.set('severity', BigInt(msg.severity));
  if (msg.facility !== undefined) fields.set('facility', BigInt(msg.facility));
  if (msg.hostname !== undefined) fields.set('hostname', msg.hostname);
  if (msg.tag !== undefined) fields.set('app_name', msg.tag);
  if (msg.procId !== undefined) fields.set('proc_id', msg.procId);
  fields.set('message', msg.message);
  return new LogEvent(fields, createMetadata());
}
