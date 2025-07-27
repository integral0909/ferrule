import {
  createMetadata,
  LogEvent,
  Timestamp,
  utf8Decode,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'syslog5424';
const NILVALUE = '-';
const BOM = '﻿';

function fail(message: string, offset?: number): never {
  throw new CodecSyntaxError(CODEC, 'E_SYSLOG5424_SYNTAX', message, offset);
}

/** A decoded RFC 5424 structured syslog message. */
export interface Syslog5424Message {
  facility: number;
  severity: number;
  version: number;
  timestamp: Timestamp | undefined;
  hostname: string | undefined;
  appName: string | undefined;
  procId: string | undefined;
  msgId: string | undefined;
  /** `SD-ID -> (PARAM-NAME -> PARAM-VALUE)`, insertion-ordered, empty when `STRUCTURED-DATA` is `-`. */
  structuredData: Map<string, Map<string, string>>;
  message: string | undefined;
}

const HEADER = /^<(\d{1,3})>(\d{1,3}) (\S+) (\S+) (\S+) (\S+) (\S+) /;

/** Parses one RFC 5424 syslog message (a single line, without its framing terminator). */
export function parseSyslog5424(input: string | Uint8Array): Syslog5424Message {
  const text = typeof input === 'string' ? input : utf8Decode(input, 'lossy');
  const m = HEADER.exec(text);
  if (m === null) fail('malformed RFC 5424 header');
  const [, pri, versionStr, timestampStr, hostname, appName, procId, msgId] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const priValue = Number(pri);
  if (priValue > 191) fail('PRI value out of range (0-191)');
  const version = Number(versionStr);

  const timestamp = timestampStr === NILVALUE ? undefined : parseTimestampStrict(timestampStr);
  let pos = m[0].length;
  const { data, next } = parseStructuredData(text, pos);
  pos = next;

  let message: string | undefined;
  if (pos < text.length) {
    if (text[pos] !== ' ') fail('expected a space before MSG', pos);
    pos++;
    let msg = text.slice(pos);
    if (msg.startsWith(BOM)) msg = msg.slice(1);
    message = msg;
  }

  return {
    facility: priValue >> 3,
    severity: priValue & 0x7,
    version,
    timestamp,
    hostname: hostname === NILVALUE ? undefined : hostname,
    appName: appName === NILVALUE ? undefined : appName,
    procId: procId === NILVALUE ? undefined : procId,
    msgId: msgId === NILVALUE ? undefined : msgId,
    structuredData: data,
    message,
  };
}

function parseTimestampStrict(text: string): Timestamp {
  const t = Timestamp.tryParse(text);
  if (t === undefined) fail(`invalid TIMESTAMP ${JSON.stringify(text)}`);
  return t;
}

function parseStructuredData(
  text: string,
  start: number,
): { data: Map<string, Map<string, string>>; next: number } {
  const data = new Map<string, Map<string, string>>();
  let pos = start;
  if (text[pos] === NILVALUE) return { data, next: pos + 1 };
  while (text[pos] === '[') {
    pos++;
    const idStart = pos;
    while (pos < text.length && !SD_NAME_STOP.has(text[pos]!)) pos++;
    if (pos === idStart) fail('expected an SD-ID', pos);
    const sdId = text.slice(idStart, pos);
    const params = new Map<string, string>();
    while (text[pos] === ' ') {
      pos++;
      const nameStart = pos;
      while (pos < text.length && !SD_NAME_STOP.has(text[pos]!) && text[pos] !== '=') pos++;
      if (pos === nameStart) fail('expected a PARAM-NAME', pos);
      const name = text.slice(nameStart, pos);
      if (text[pos] !== '=') fail('expected "=" after PARAM-NAME', pos);
      pos++;
      if (text[pos] !== '"') fail('expected a quoted PARAM-VALUE', pos);
      pos++;
      let value = '';
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === '\\') {
          const next = text[pos + 1];
          if (next === '"' || next === '\\' || next === ']') {
            value += next;
            pos += 2;
            continue;
          }
        }
        value += text[pos];
        pos++;
      }
      if (text[pos] !== '"') fail('unterminated PARAM-VALUE', pos);
      pos++;
      params.set(name, value);
    }
    if (text[pos] !== ']') fail('expected "]" to close SD-ELEMENT', pos);
    pos++;
    data.set(sdId, params);
  }
  return { data, next: pos };
}

const SD_NAME_STOP = new Set([' ', '=', ']', '"']);

/** Escapes a `PARAM-VALUE` per RFC 5424 §6.3.3: `"`, `\`, and `]` are backslash-escaped. */
export function escapeSdParamValue(value: string): string {
  return value.replace(/[\\"\]]/g, (c) => `\\${c}`);
}

export interface EncodeSyslog5424Options {
  /** Facility (0-23). Default 1 (user-level). */
  facility?: number;
}

/** Encodes a message as one RFC 5424 line (no trailing newline). */
export function encodeSyslog5424(message: Syslog5424Message): string {
  const pri = (message.facility << 3) | message.severity;
  const timestamp = message.timestamp === undefined ? NILVALUE : message.timestamp.toISOString();
  const parts = [
    `<${pri}>${message.version}`,
    timestamp,
    message.hostname ?? NILVALUE,
    message.appName ?? NILVALUE,
    message.procId ?? NILVALUE,
    message.msgId ?? NILVALUE,
    encodeStructuredData(message.structuredData),
  ];
  let line = parts.join(' ');
  if (message.message !== undefined) line += ` ${message.message}`;
  return line;
}

function encodeStructuredData(data: Map<string, Map<string, string>>): string {
  if (data.size === 0) return NILVALUE;
  let out = '';
  for (const [sdId, params] of data) {
    out += `[${sdId}`;
    for (const [name, value] of params) out += ` ${name}="${escapeSdParamValue(value)}"`;
    out += ']';
  }
  return out;
}

/** Decodes one RFC 5424 line directly into a {@link LogEvent}. See the module README for the
 * field mapping (mirrors {@link parseSyslog5424}'s fields under matching snake_case names). */
export function decodeSyslog5424ToLogEvent(input: string | Uint8Array): LogEvent {
  const msg = parseSyslog5424(input);
  const fields: ValueMap = new Map();
  fields.set('timestamp', msg.timestamp ?? Timestamp.now());
  fields.set('severity', BigInt(msg.severity));
  fields.set('facility', BigInt(msg.facility));
  if (msg.hostname !== undefined) fields.set('hostname', msg.hostname);
  if (msg.appName !== undefined) fields.set('app_name', msg.appName);
  if (msg.procId !== undefined) fields.set('proc_id', msg.procId);
  if (msg.msgId !== undefined) fields.set('msg_id', msg.msgId);
  if (msg.structuredData.size > 0) {
    const sd: ValueMap = new Map();
    for (const [sdId, params] of msg.structuredData) {
      const p: ValueMap = new Map();
      for (const [name, value] of params) p.set(name, value);
      sd.set(sdId, p);
    }
    fields.set('structured_data', sd);
  }
  if (msg.message !== undefined) fields.set('message', msg.message);
  return new LogEvent(fields, createMetadata());
}

/** Encodes a {@link LogEvent} (built by {@link decodeSyslog5424ToLogEvent}, or shaped like it) as
 * one RFC 5424 line. Fields outside the mapping are ignored. */
export function encodeLogEventAsSyslog5424(
  event: LogEvent,
  options: EncodeSyslog5424Options = {},
): string {
  const severity = event.get('severity');
  const facility = event.get('facility');
  const structuredData = new Map<string, Map<string, string>>();
  const sdField = event.get('structured_data');
  if (sdField instanceof Map) {
    for (const [sdId, params] of sdField) {
      if (!(params instanceof Map)) continue;
      const p = new Map<string, string>();
      for (const [name, value] of params) p.set(name, stringifyValue(value));
      structuredData.set(sdId, p);
    }
  }
  const message = event.get('message');
  const timestamp = event.get('timestamp');
  return encodeSyslog5424({
    facility: typeof facility === 'bigint' ? Number(facility) : (options.facility ?? 1),
    severity: typeof severity === 'bigint' ? Number(severity) : 6,
    version: 1,
    timestamp: timestamp instanceof Timestamp ? timestamp : Timestamp.now(),
    hostname: asString(event.get('hostname')),
    appName: asString(event.get('app_name')),
    procId: asString(event.get('proc_id')),
    msgId: asString(event.get('msg_id')),
    structuredData,
    message: typeof message === 'string' ? message : undefined,
  });
}

function asString(value: Value | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
