import { describe, expect, it } from 'vitest';
import {
  issueToDiagnostic,
  nodeToPlain,
  parseYamlDocument,
  renderDiagnostics,
  SecretRegistry,
  type ConfigDiagnostic,
} from '@ferrule/config';

describe('issueToDiagnostic', () => {
  it('places a value issue at the value range', () => {
    const doc = parseYamlDocument('a:\n  b: 1\n');
    const { positions } = nodeToPlain(doc, 'x.yaml');
    const diagnostic = issueToDiagnostic(
      { path: ['a', 'b'], code: 'too_small', message: 'must be at least 2' },
      positions,
    );
    expect(diagnostic.file).toBe('x.yaml');
    expect(diagnostic.range?.start.line).toBe(2);
    expect(diagnostic.message).toContain('a.b');
  });

  it('falls back to the nearest ancestor for a missing required key', () => {
    const doc = parseYamlDocument('a:\n  b: 1\n');
    const { positions } = nodeToPlain(doc, 'x.yaml');
    const diagnostic = issueToDiagnostic(
      { path: ['a', 'missing'], code: 'required', message: 'is required' },
      positions,
    );
    // "a.missing" was never written, so it falls back to "a"'s location: the start of its
    // mapping value, which begins on the nested line.
    expect(diagnostic.range?.start.line).toBe(2);
  });

  it('prefers a key location over a value location for "required" and "unknown_key"', () => {
    const doc = parseYamlDocument('a:\n  extra: 1\n');
    const { positions } = nodeToPlain(doc, 'x.yaml');
    const diagnostic = issueToDiagnostic(
      { path: ['a', 'extra'], code: 'unknown_key', message: 'is not recognised' },
      positions,
    );
    // The key "extra" starts at column 3 on line 2; the value "1" starts later on the same line.
    expect(diagnostic.range?.start.column).toBe(3);
  });

  it('carries the hint through', () => {
    const doc = parseYamlDocument('a: 1\n');
    const { positions } = nodeToPlain(doc, 'x.yaml');
    const diagnostic = issueToDiagnostic(
      { path: ['a'], code: 'invalid_enum', message: 'bad', hint: 'did you mean "b"?' },
      positions,
    );
    expect(diagnostic.hint).toBe('did you mean "b"?');
  });
});

describe('renderDiagnostics', () => {
  it('renders a code frame with the line, a caret, and the message', () => {
    const source = 'sources:\n  app:\n    type: htpp\n';
    const diagnostics: ConfigDiagnostic[] = [
      {
        file: 'config.yaml',
        range: {
          start: { offset: 24, line: 3, column: 11 },
          end: { offset: 28, line: 3, column: 15 },
        },
        message: 'sources.app.type: unknown type "htpp"',
        code: 'custom',
      },
    ];
    const rendered = renderDiagnostics(diagnostics, new Map([['config.yaml', source]]));
    expect(rendered).toContain('config.yaml:3:11');
    expect(rendered).toContain('type: htpp');
    expect(rendered).toContain('^');
    expect(rendered).toContain('unknown type "htpp"');
  });

  it('never prints a secret value, even if it ended up in the message or the source line', () => {
    const secrets = new SecretRegistry();
    secrets.register('hunter2');
    const source = 'password: hunter2\n';
    const diagnostics: ConfigDiagnostic[] = [
      {
        file: 'config.yaml',
        range: {
          start: { offset: 10, line: 1, column: 11 },
          end: { offset: 17, line: 1, column: 18 },
        },
        message: 'password hunter2 is too weak',
        code: 'custom',
      },
    ];
    const rendered = renderDiagnostics(diagnostics, new Map([['config.yaml', source]]), {
      secrets,
    });
    expect(rendered).not.toContain('hunter2');
    expect(rendered).toContain('**REDACTED**');
  });

  it('renders a diagnostic with no range using just the file name', () => {
    const diagnostics: ConfigDiagnostic[] = [
      {
        file: 'config.yaml',
        range: undefined,
        message: 'top level must be a mapping',
        code: 'invalid_type',
      },
    ];
    const rendered = renderDiagnostics(diagnostics, new Map());
    expect(rendered).toBe('config.yaml: error[invalid_type]: top level must be a mapping');
  });
});
