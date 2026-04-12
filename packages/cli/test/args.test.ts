import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  flagBoolean,
  flagNumber,
  flagString,
  flagStringArray,
  formatCommandHelp,
  formatTopLevelHelp,
  parseArgs,
  withGlobalFlags,
  type CommandSpec,
} from '../src/args.js';

const basicSpec: CommandSpec = {
  name: 'demo',
  summary: 'A demo command.',
  flags: [
    { name: 'verbose', short: 'v', type: 'boolean', description: 'Be loud.' },
    { name: 'quiet', type: 'boolean', negatable: true, default: false, description: 'Be quiet.' },
    { name: 'name', short: 'n', type: 'string', description: 'A name.' },
    { name: 'count', type: 'integer', description: 'A count.' },
    { name: 'rate', type: 'number', description: 'A rate.' },
    { name: 'wait', type: 'duration', description: 'A duration.' },
    { name: 'mode', type: 'enum', enumValues: ['fast', 'slow'], description: 'A mode.' },
    { name: 'tag', type: 'string', repeatable: true, description: 'Repeatable tag.' },
    { name: 'path', type: 'path', description: 'A path.' },
  ],
  positionals: [
    { name: 'first', description: 'first arg', required: true },
    { name: 'rest', description: 'rest', variadic: true },
  ],
};

describe('parseArgs', () => {
  it('parses long flags with a following value', () => {
    const result = parseArgs(basicSpec, ['--name', 'alice', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagString(result.args, 'name')).toBe('alice');
    expect(result.args.positionals).toEqual(['pos1']);
  });

  it('parses --flag=value form', () => {
    const result = parseArgs(basicSpec, ['--name=bob', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagString(result.args, 'name')).toBe('bob');
  });

  it('parses short flags', () => {
    const result = parseArgs(basicSpec, ['-n', 'carol', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagString(result.args, 'name')).toBe('carol');
  });

  it('parses boolean flags without a value', () => {
    const result = parseArgs(basicSpec, ['--verbose', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagBoolean(result.args, 'verbose')).toBe(true);
  });

  it('supports --no- negation for negatable booleans', () => {
    const result = parseArgs(basicSpec, ['--no-quiet', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagBoolean(result.args, 'quiet')).toBe(false);
  });

  it('defaults negatable booleans and applies configured defaults', () => {
    const result = parseArgs(basicSpec, ['pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagBoolean(result.args, 'quiet')).toBe(false);
  });

  it('collects repeated flags into an array', () => {
    const result = parseArgs(basicSpec, ['--tag', 'a', '--tag', 'b', '--tag', 'c', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagStringArray(result.args, 'tag')).toEqual(['a', 'b', 'c']);
  });

  it('parses integer, number, and duration flags', () => {
    const result = parseArgs(basicSpec, ['--count', '42', '--rate', '0.5', '--wait', '1s', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagNumber(result.args, 'count')).toBe(42);
    expect(flagNumber(result.args, 'rate')).toBe(0.5);
    expect(flagNumber(result.args, 'wait')).toBe(1000);
  });

  it('rejects a non-integer for an integer flag', () => {
    const result = parseArgs(basicSpec, ['--count', 'abc', 'pos1']);
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-range enum value with a suggestion', () => {
    const result = parseArgs(basicSpec, ['--mode', 'fest', 'pos1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('fast');
  });

  it('accepts a valid enum value', () => {
    const result = parseArgs(basicSpec, ['--mode', 'fast', 'pos1']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flagString(result.args, 'mode')).toBe('fast');
  });

  it('reports an unknown flag with a did-you-mean suggestion', () => {
    const result = parseArgs(basicSpec, ['--vebose', 'pos1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unknown flag');
  });

  it('treats everything after -- as positional', () => {
    const result = parseArgs(basicSpec, ['pos1', '--', '--verbose', '-n']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.positionals).toEqual(['pos1', '--verbose', '-n']);
  });

  it('requires a value for non-boolean flags', () => {
    const result = parseArgs(basicSpec, ['--name']);
    expect(result.ok).toBe(false);
  });

  it('fails when a required positional is missing', () => {
    const result = parseArgs(basicSpec, []);
    expect(result.ok).toBe(false);
  });

  it('collects a variadic trailing positional', () => {
    const result = parseArgs(basicSpec, ['first', 'a', 'b', 'c']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.positionals).toEqual(['first', 'a', 'b', 'c']);
  });

  it('does not mistake a negative number positional for a flag', () => {
    const variadicSpec: CommandSpec = {
      name: 'n',
      summary: '',
      flags: [],
      positionals: [{ name: 'nums', description: '', variadic: true }],
    };
    const result = parseArgs(variadicSpec, ['-3', '-3.5']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.positionals).toEqual(['-3', '-3.5']);
  });
});

describe('withGlobalFlags', () => {
  it('adds --help and --debug without duplicating existing flags', () => {
    const merged = withGlobalFlags(basicSpec);
    const names = merged.flags.map((f) => f.name);
    expect(names.filter((n) => n === 'help')).toHaveLength(1);
    expect(names).toContain('debug');
  });
});

describe('help rendering', () => {
  it('formatCommandHelp includes the usage line and every visible flag', () => {
    const text = formatCommandHelp(withGlobalFlags(basicSpec));
    expect(text).toContain('Usage:');
    expect(text).toContain('--name');
    expect(text).toContain('--help');
  });

  it('formatTopLevelHelp lists every command', () => {
    const text = formatTopLevelHelp([{ name: 'run', summary: 'Run it.' }], '1.2.3');
    expect(text).toContain('1.2.3');
    expect(text).toContain('run');
    expect(text).toContain('Run it.');
  });
});

describe('round-tripping flags (property tests)', () => {
  const stringFlagSpec: CommandSpec = {
    name: 'roundtrip',
    summary: '',
    flags: [{ name: 'value', type: 'string', description: '' }],
  };

  it('a single --value <s> round-trips for any non-flag-like string', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith('-') && !s.includes('\u0000')),
        (s) => {
          const result = parseArgs(stringFlagSpec, ['--value', s]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(flagString(result.args, 'value')).toBe(s);
        },
      ),
    );
  });

  const intFlagSpec: CommandSpec = {
    name: 'roundtrip',
    summary: '',
    flags: [{ name: 'n', type: 'integer', description: '' }],
  };

  it('a single --n <int> round-trips for any safe integer', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        const result = parseArgs(intFlagSpec, ['--n', String(n)]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(flagNumber(result.args, 'n')).toBe(n);
      }),
    );
  });

  const repeatSpec: CommandSpec = {
    name: 'roundtrip',
    summary: '',
    flags: [{ name: 'x', type: 'string', repeatable: true, description: '' }],
  };

  it('N repeats of --x <s> round-trip as an array of length N, in order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }).filter((s) => !s.startsWith('-'))),
        (values) => {
          const argv = values.flatMap((v) => ['--x', v]);
          const result = parseArgs(repeatSpec, argv);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(flagStringArray(result.args, 'x')).toEqual(values);
        },
      ),
    );
  });
});
