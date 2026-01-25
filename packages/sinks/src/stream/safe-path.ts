import * as nodePath from 'node:path';

/**
 * Validates that a templated path segment does not attempt to escape the sink's configured base
 * directory: no `..` path segment and no absolute-path segment (`/etc/passwd`, `C:\...`, a leading
 * `~`) is allowed anywhere in a *rendered* path fragment. This is checked against the raw rendered
 * string (before joining with the base directory) so a field value like `../../etc/passwd` is
 * rejected even though `path.join` would otherwise happily normalise it away.
 */
export function containsUnsafeSegment(renderedFragment: string): boolean {
  if (renderedFragment === '') return false;
  const normalized = renderedFragment.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('~')) return true;
  // A Windows drive letter (`C:`) anywhere is also treated as an escape attempt, regardless of
  // platform, since a template's field-derived values are untrusted input.
  if (/^[A-Za-z]:/.test(normalized)) return true;
  const segments = normalized.split('/');
  return segments.some((segment) => segment === '..');
}

/**
 * Resolves `relativePath` against `baseDir`, guaranteeing the result stays inside `baseDir`.
 * Throws {@link PathEscapeError} if it does not (belt-and-braces on top of
 * {@link containsUnsafeSegment}, which callers should also check per templated fragment so they
 * can reject just the offending event rather than crash the sink).
 */
export function resolveWithinBase(baseDir: string, relativePath: string): string {
  const base = nodePath.resolve(baseDir);
  const resolved = nodePath.resolve(base, relativePath);
  const relative = nodePath.relative(base, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative)
  ) {
    throw new PathEscapeError(relativePath);
  }
  return resolved;
}

export class PathEscapeError extends Error {
  constructor(readonly attemptedPath: string) {
    super(`path ${JSON.stringify(attemptedPath)} escapes the configured base directory`);
    this.name = 'PathEscapeError';
  }
}
