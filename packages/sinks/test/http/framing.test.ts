import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '@ferrule/core';
import { contentTypeFor, frameChunks } from '../../src/http/framing.js';

const chunk = (s: string) => utf8Encode(s);
const text = (b: Uint8Array) => utf8Decode(b, 'strict');

describe('frameChunks', () => {
  it('ndjson: joins with newlines and adds a trailing newline', () => {
    const out = frameChunks([chunk('{"a":1}'), chunk('{"b":2}')], 'ndjson');
    expect(text(out)).toBe('{"a":1}\n{"b":2}\n');
  });

  it('newline: joins with newlines, no trailing newline', () => {
    const out = frameChunks([chunk('one'), chunk('two'), chunk('three')], 'newline');
    expect(text(out)).toBe('one\ntwo\nthree');
  });

  it('json_array: wraps chunks in brackets separated by commas', () => {
    const out = frameChunks([chunk('1'), chunk('2'), chunk('3')], 'json_array');
    expect(text(out)).toBe('[1,2,3]');
  });

  it('handles zero chunks', () => {
    expect(text(frameChunks([], 'ndjson'))).toBe('');
    expect(text(frameChunks([], 'newline'))).toBe('');
    expect(text(frameChunks([], 'json_array'))).toBe('[]');
  });

  it('handles a single chunk', () => {
    expect(text(frameChunks([chunk('only')], 'newline'))).toBe('only');
    expect(text(frameChunks([chunk('only')], 'json_array'))).toBe('[only]');
    expect(text(frameChunks([chunk('only')], 'ndjson'))).toBe('only\n');
  });
});

describe('contentTypeFor', () => {
  it('maps each framing to a reasonable content type', () => {
    expect(contentTypeFor('ndjson')).toBe('application/x-ndjson');
    expect(contentTypeFor('newline')).toContain('text/plain');
    expect(contentTypeFor('json_array')).toBe('application/json');
  });
});
