import { describe, expect, it } from 'vitest';
import { Timestamp } from '@ferrule/core';
import {
  decodeSyslog3164ToLogEvent,
  decodeSyslog5424ToLogEvent,
  decodeSyslogAuto,
  detectSyslogFormat,
  encodeLogEventAsSyslog5424,
  encodeSyslog5424,
  parseSyslog3164,
  parseSyslog5424,
} from '@ferrule/codecs';

describe('RFC 5424', () => {
  it('parses a full example with structured data', () => {
    const line =
      '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 ' +
      '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] An application event log entry';
    const msg = parseSyslog5424(line);
    expect(msg.facility).toBe(20);
    expect(msg.severity).toBe(5);
    expect(msg.version).toBe(1);
    expect(msg.timestamp?.toISOString()).toBe('2003-10-11T22:14:15.003Z');
    expect(msg.hostname).toBe('mymachine.example.com');
    expect(msg.appName).toBe('evntslog');
    expect(msg.procId).toBeUndefined();
    expect(msg.msgId).toBe('ID47');
    expect(msg.structuredData.get('exampleSDID@32473')?.get('iut')).toBe('3');
    expect(msg.structuredData.get('exampleSDID@32473')?.get('eventSource')).toBe('Application');
    expect(msg.message).toBe('An application event log entry');
  });

  it('parses NILVALUE fields and no message', () => {
    const line = '<34>1 - - - - - -';
    const msg = parseSyslog5424(line);
    expect(msg.timestamp).toBeUndefined();
    expect(msg.hostname).toBeUndefined();
    expect(msg.appName).toBeUndefined();
    expect(msg.procId).toBeUndefined();
    expect(msg.msgId).toBeUndefined();
    expect(msg.structuredData.size).toBe(0);
    expect(msg.message).toBeUndefined();
  });

  it('parses multiple structured data elements', () => {
    const line = '<34>1 2003-10-11T22:14:15Z host app 1 - [a@1 x="1"][b@2 y="2" z="3"] hi';
    const msg = parseSyslog5424(line);
    expect([...msg.structuredData.keys()]).toEqual(['a@1', 'b@2']);
    expect(msg.structuredData.get('b@2')?.get('z')).toBe('3');
    expect(msg.message).toBe('hi');
  });

  it('unescapes backslash, quote, and bracket in PARAM-VALUE', () => {
    const line = String.raw`<34>1 - - - - - [id@1 k="a\"b\\c\]d"] msg`;
    const msg = parseSyslog5424(line);
    expect(msg.structuredData.get('id@1')?.get('k')).toBe('a"b\\c]d');
  });

  it('strips a UTF-8 BOM from the message', () => {
    const line = '<34>1 - - - - - - ﻿hello';
    const msg = parseSyslog5424(line);
    expect(msg.message).toBe('hello');
  });

  it('throws CodecSyntaxError on a malformed header', () => {
    expect(() => parseSyslog5424('not a syslog line')).toThrow();
    expect(() => parseSyslog5424('<34>1 - - - - - [bad')).toThrow();
    expect(() => parseSyslog5424('<999>1 - - - - - -')).toThrow();
  });

  it('round-trips through encodeSyslog5424', () => {
    const msg = parseSyslog5424(
      '<165>1 2003-10-11T22:14:15.003Z mymachine evntslog 1234 ID47 [sd@1 a="b"] hello there',
    );
    const encoded = encodeSyslog5424(msg);
    const reparsed = parseSyslog5424(encoded);
    expect(reparsed).toEqual(msg);
  });

  it('decodes and re-encodes through LogEvent', () => {
    const line = '<165>1 2003-10-11T22:14:15.003Z mymachine evntslog 1234 ID47 [sd@1 a="b"] hello';
    const event = decodeSyslog5424ToLogEvent(line);
    expect(event.get('message')).toBe('hello');
    expect(event.get('severity')).toBe(5n);
    expect(event.get('facility')).toBe(20n);
    expect(event.get('hostname')).toBe('mymachine');
    const reencoded = encodeLogEventAsSyslog5424(event);
    const reparsed = parseSyslog5424(reencoded);
    expect(reparsed.message).toBe('hello');
    expect(reparsed.structuredData.get('sd@1')?.get('a')).toBe('b');
  });
});

describe('RFC 3164', () => {
  const now = Timestamp.parse('2024-06-15T12:00:00Z');

  it('parses a classic BSD syslog line with PRI, hostname, and PID', () => {
    const line = "<34>Oct 11 22:14:15 mymachine su[1234]: 'su root' failed for lonvick";
    const msg = parseSyslog3164(line, { now });
    expect(msg.facility).toBe(4);
    expect(msg.severity).toBe(2);
    expect(msg.hostname).toBe('mymachine');
    expect(msg.tag).toBe('su');
    expect(msg.procId).toBe('1234');
    expect(msg.message).toBe("'su root' failed for lonvick");
  });

  it('parses a line with no PRI and no PID', () => {
    const line = 'Oct 11 22:14:15 mymachine sshd: Accepted publickey';
    const msg = parseSyslog3164(line, { now });
    expect(msg.facility).toBeUndefined();
    expect(msg.severity).toBeUndefined();
    expect(msg.tag).toBe('sshd');
    expect(msg.message).toBe('Accepted publickey');
  });

  it('infers the year from the reference clock', () => {
    const msg = parseSyslog3164('<34>Jan 05 00:00:00 host app: hi', { now });
    expect(msg.timestamp.toCivil().year).toBe(2024);
  });

  it('rolls back to the previous year across a year boundary', () => {
    const dec31 = Timestamp.parse('2024-01-01T00:05:00Z');
    const msg = parseSyslog3164('<34>Dec 31 23:59:00 host app: hi', { now: dec31 });
    expect(msg.timestamp.toCivil().year).toBe(2023);
  });

  it('applies a fixed UTC offset timezone', () => {
    const msg = parseSyslog3164('<34>Jun 15 12:00:00 host app: hi', { now, timezone: -300 });
    // 12:00 local at UTC-5 is 17:00 UTC.
    expect(msg.timestamp.toISOString()).toBe('2024-06-15T17:00:00Z');
  });

  it('applies an IANA timezone via Intl', () => {
    const msg = parseSyslog3164('<34>Jun 15 12:00:00 host app: hi', {
      now,
      timezone: 'America/New_York',
    });
    expect(msg.timestamp.toISOString()).toBe('2024-06-15T16:00:00Z');
  });

  it('decodes to a LogEvent with mapped fields', () => {
    const event = decodeSyslog3164ToLogEvent('<34>Oct 11 22:14:15 mymachine su[1234]: failed', {
      now,
    });
    expect(event.get('message')).toBe('failed');
    expect(event.get('app_name')).toBe('su');
    expect(event.get('proc_id')).toBe('1234');
    expect(event.get('hostname')).toBe('mymachine');
    expect(event.get('severity')).toBe(2n);
  });

  it('throws CodecSyntaxError on a malformed header', () => {
    expect(() => parseSyslog3164('not a syslog line')).toThrow();
  });
});

describe('auto-detect', () => {
  it('detects 5424', () => {
    expect(detectSyslogFormat('<34>1 2003-10-11T22:14:15Z host app - - - hi')).toBe('5424');
  });

  it('detects 3164', () => {
    expect(detectSyslogFormat('<34>Oct 11 22:14:15 host app: hi')).toBe('3164');
  });

  it('falls back to a bare message for unrecognised input', () => {
    const now = Timestamp.now();
    expect(detectSyslogFormat('just some text')).toBe('unknown');
    const event = decodeSyslogAuto('just some text', { now });
    expect(event.get('message')).toBe('just some text');
  });

  it('decodeSyslogAuto dispatches to the right parser', () => {
    const a = decodeSyslogAuto('<34>1 2003-10-11T22:14:15Z host app - - - hi');
    expect(a.get('hostname')).toBe('host');
    const b = decodeSyslogAuto('<34>Oct 11 22:14:15 host app: hi', { now: Timestamp.now() });
    expect(b.get('app_name')).toBe('app');
  });
});
