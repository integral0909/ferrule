import { describe, expect, it } from 'vitest';
import {
  containsUnsafeSegment,
  PathEscapeError,
  resolveWithinBase,
} from '../../src/stream/safe-path.js';

describe('containsUnsafeSegment', () => {
  it('accepts ordinary relative fragments', () => {
    expect(containsUnsafeSegment('host-1/app.log')).toBe(false);
    expect(containsUnsafeSegment('')).toBe(false);
    expect(containsUnsafeSegment('a.b.c')).toBe(false);
  });

  it('rejects a leading slash', () => {
    expect(containsUnsafeSegment('/etc/passwd')).toBe(true);
  });

  it('rejects a ".." segment anywhere', () => {
    expect(containsUnsafeSegment('../../etc/passwd')).toBe(true);
    expect(containsUnsafeSegment('a/../../b')).toBe(true);
    expect(containsUnsafeSegment('safe/..')).toBe(true);
  });

  it('does not false-positive on ".." as a substring, only as a full segment', () => {
    expect(containsUnsafeSegment('a..b/c')).toBe(false);
    expect(containsUnsafeSegment('...dotfile')).toBe(false);
  });

  it('rejects a leading tilde and a Windows drive letter', () => {
    expect(containsUnsafeSegment('~/secrets')).toBe(true);
    expect(containsUnsafeSegment('C:\\Windows\\System32')).toBe(true);
  });

  it('treats backslash-separated traversal the same as forward-slash', () => {
    expect(containsUnsafeSegment('..\\..\\etc\\passwd')).toBe(true);
  });
});

describe('resolveWithinBase', () => {
  it('resolves an ordinary relative path under the base directory', () => {
    expect(resolveWithinBase('/data/logs', 'host-1/app.log')).toBe('/data/logs/host-1/app.log');
  });

  it('throws PathEscapeError for a path that escapes the base directory', () => {
    expect(() => resolveWithinBase('/data/logs', '../../etc/passwd')).toThrow(PathEscapeError);
  });

  it('throws PathEscapeError for an absolute path', () => {
    expect(() => resolveWithinBase('/data/logs', '/etc/passwd')).toThrow(PathEscapeError);
  });

  it('allows a path that merely touches the base directory boundary via a safe subpath', () => {
    expect(resolveWithinBase('/data/logs', 'a/b/../c')).toBe('/data/logs/a/c');
  });
});
