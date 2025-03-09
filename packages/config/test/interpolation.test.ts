import { describe, expect, it } from 'vitest';
import {
  InterpolationError,
  interpolateString,
  interpolateTree,
  MapSecretBackend,
  nodeToPlain,
  parseYamlDocument,
  SecretRegistry,
  type InterpolationContext,
} from '@ferrule/config';

function ctx(overrides: Partial<InterpolationContext> = {}): InterpolationContext {
  return { env: {}, secrets: new SecretRegistry(), ...overrides };
}

describe('interpolateString', () => {
  it('substitutes a set environment variable', async () => {
    expect(await interpolateString('${FOO}', ctx({ env: { FOO: 'bar' } }))).toBe('bar');
  });

  it('substitutes an empty string for an unset bare variable', async () => {
    expect(await interpolateString('x${MISSING}y', ctx())).toBe('xy');
  });

  it('supports :- defaults, used only when unset or empty', async () => {
    expect(await interpolateString('${FOO:-fallback}', ctx())).toBe('fallback');
    expect(await interpolateString('${FOO:-fallback}', ctx({ env: { FOO: '' } }))).toBe('fallback');
    expect(await interpolateString('${FOO:-fallback}', ctx({ env: { FOO: 'set' } }))).toBe('set');
  });

  it('supports :? required variables with a custom error message', async () => {
    await expect(interpolateString('${FOO:?must be set}', ctx())).rejects.toThrow(
      InterpolationError,
    );
    await expect(interpolateString('${FOO:?must be set}', ctx())).rejects.toThrow(/must be set/);
    expect(await interpolateString('${FOO:?must be set}', ctx({ env: { FOO: 'ok' } }))).toBe('ok');
  });

  it('unescapes $$ to a literal $ without treating it as a directive', async () => {
    expect(await interpolateString('$$FOO', ctx({ env: { FOO: 'bar' } }))).toBe('$FOO');
    expect(await interpolateString('cost: $$5', ctx())).toBe('cost: $5');
  });

  it('leaves a bare "$" that is not followed by "{" or "$" alone', async () => {
    expect(await interpolateString('a $ b', ctx())).toBe('a $ b');
  });

  it('resolves ${secret:NAME} through the configured backend and registers the value', async () => {
    const secrets = new SecretRegistry();
    const backend = new MapSecretBackend({ db_password: 'hunter2' });
    const result = await interpolateString(
      'password=${secret:db_password}',
      ctx({ secrets, secretBackend: backend }),
    );
    expect(result).toBe('password=hunter2');
    expect(secrets.has('hunter2')).toBe(true);
  });

  it('fails when ${secret:...} is used without a configured backend', async () => {
    await expect(interpolateString('${secret:x}', ctx())).rejects.toThrow(InterpolationError);
  });

  it('fails when the named secret does not exist', async () => {
    const backend = new MapSecretBackend({});
    await expect(
      interpolateString('${secret:missing}', ctx({ secretBackend: backend })),
    ).rejects.toThrow(InterpolationError);
  });

  it('does not re-scan a substituted value: injected "${...}" text stays literal', async () => {
    const secrets = new SecretRegistry();
    const backend = new MapSecretBackend({ evil: 'prefix ${FOO} suffix' });
    const result = await interpolateString(
      '${secret:evil}',
      ctx({ env: { FOO: 'should-not-appear' }, secrets, secretBackend: backend }),
    );
    expect(result).toBe('prefix ${FOO} suffix');
    expect(result).not.toContain('should-not-appear');
  });

  it('fails on an unterminated interpolation', async () => {
    await expect(interpolateString('${FOO', ctx())).rejects.toThrow(InterpolationError);
  });

  it('fails on an invalid directive body', async () => {
    await expect(interpolateString('${123invalid}', ctx())).rejects.toThrow(InterpolationError);
  });
});

describe('interpolateTree', () => {
  it('interpolates every string scalar in a document, leaving other kinds and keys alone', async () => {
    const doc = parseYamlDocument('a: ${FOO}\nb: 1\nc:\n  - ${FOO}\n  - plain\n');
    const interpolated = await interpolateTree(doc, ctx({ env: { FOO: 'bar' } }));
    const { value } = nodeToPlain(interpolated, 'x.yaml');
    expect(value).toEqual({ a: 'bar', b: 1, c: ['bar', 'plain'] });
  });

  it('preserves node ranges after interpolation', async () => {
    const doc = parseYamlDocument('a: ${FOO}\n');
    const interpolated = await interpolateTree(doc, ctx({ env: { FOO: 'bar' } }));
    const { positions } = nodeToPlain(interpolated, 'x.yaml');
    expect(positions.resolve(['a'])?.range.start.line).toBe(1);
  });
});
