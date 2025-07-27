import { LogEvent, utf8Decode } from '@ferrule/core';
import { decodeSyslog3164ToLogEvent, type Rfc3164DecodeOptions } from './rfc3164.js';
import { decodeSyslog5424ToLogEvent } from './rfc5424.js';

/** Distinguishes RFC 5424 (`<PRI>1 TIMESTAMP ...`) from RFC 3164 (`<PRI>Mmm dd hh:mm:ss ...`) by
 * checking, after an optional `<PRI>`, whether the message starts with the literal version
 * number `1` followed by a space and a digit or `-` (a 5424 `TIMESTAMP`) — RFC 3164 always starts
 * with a three-letter month name instead. */
export function detectSyslogFormat(input: string | Uint8Array): '5424' | '3164' | 'unknown' {
  const text = typeof input === 'string' ? input : utf8Decode(input, 'lossy');
  const afterPri = /^<\d{1,3}>/.exec(text);
  const rest = afterPri === null ? text : text.slice(afterPri[0].length);
  if (/^1 [\d-]/.test(rest)) return '5424';
  if (/^[A-Za-z]{3}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}\s/.test(rest)) return '3164';
  return 'unknown';
}

export type SyslogAutoDecodeOptions = Rfc3164DecodeOptions;

/** Decodes one syslog line, auto-detecting RFC 5424 vs RFC 3164 framing per
 * {@link detectSyslogFormat}. Throws `E_SYSLOG_UNKNOWN_FORMAT` if neither matches. */
export function decodeSyslogAuto(
  input: string | Uint8Array,
  options: SyslogAutoDecodeOptions = {},
): LogEvent {
  const format = detectSyslogFormat(input);
  if (format === '5424') return decodeSyslog5424ToLogEvent(input);
  if (format === '3164') return decodeSyslog3164ToLogEvent(input, options);
  const text = typeof input === 'string' ? input : utf8Decode(input, 'lossy');
  return LogEvent.fromMessage(text, options.now !== undefined ? { receivedAt: options.now } : {});
}
