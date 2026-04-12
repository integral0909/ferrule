import { describe, expect, it } from 'vitest';
import { Painter, shouldUseColor } from '../src/color.js';

describe('shouldUseColor', () => {
  it('is false when NO_COLOR is set to any non-empty value, even on a TTY', () => {
    expect(shouldUseColor({ NO_COLOR: '1' }, { isTTY: true })).toBe(false);
    expect(shouldUseColor({ NO_COLOR: 'anything' }, { isTTY: true })).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(shouldUseColor({ NO_COLOR: '' }, { isTTY: true })).toBe(true);
  });

  it('FORCE_COLOR=0 disables colour even on a TTY', () => {
    expect(shouldUseColor({ FORCE_COLOR: '0' }, { isTTY: true })).toBe(false);
  });

  it('a non-zero FORCE_COLOR enables colour even without a TTY', () => {
    expect(shouldUseColor({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(true);
    expect(shouldUseColor({ FORCE_COLOR: 'true' }, { isTTY: false })).toBe(true);
  });

  it('falls back to TTY detection when neither variable is set', () => {
    expect(shouldUseColor({}, { isTTY: true })).toBe(true);
    expect(shouldUseColor({}, { isTTY: false })).toBe(false);
    expect(shouldUseColor({}, {})).toBe(false);
  });

  it('NO_COLOR takes precedence over FORCE_COLOR', () => {
    expect(shouldUseColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, { isTTY: true })).toBe(false);
  });
});

describe('Painter', () => {
  it('wraps text in ANSI codes when enabled', () => {
    const paint = new Painter(true);
    expect(paint.bold('hi')).toBe('\x1b[1mhi\x1b[0m');
    expect(paint.red('x')).toBe('\x1b[31mx\x1b[0m');
  });

  it('returns text unchanged when disabled', () => {
    const paint = new Painter(false);
    expect(paint.bold('hi')).toBe('hi');
    expect(paint.paint('cyan', 'y')).toBe('y');
  });
});
