# Contributing to Ferrule

Thanks for your interest in improving Ferrule.

## Getting set up

```sh
pnpm install
pnpm run check
```

`check` runs formatting, lint, type checking (including tests), and the full test suite. CI
runs the same steps on Linux, macOS, and Windows.

## Conventions

- **TypeScript, strict.** The base config enables `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`. Don't weaken them locally; restructure the code instead.
- **ESM only.** Relative imports use the `.js` extension (`import { x } from './x.js'`).
- **No `any` at module boundaries.** Use `unknown` and narrow.
- **Errors carry codes.** Throw `FerruleError` (or a subclass) with a stable `code` so users and
  tests can match on it. Messages are for humans and may change.
- **Hot paths avoid allocation.** Code that runs per event is written with that in mind;
  benchmarks accompany performance-sensitive changes.
- **Tests live next to their package** in `packages/<name>/test`. Property-based tests
  (`fast-check`) are expected for parsers, codecs, and anything with an inverse.

## Commit messages

Use the imperative mood and a short subject line (≤ 72 characters), for example
`core: support negative indices in field paths`. Prefix with the package name when a change is
scoped to one package.

## Adding a dependency

Runtime dependencies need a clear justification in the pull request: Ferrule runs inside
people's infrastructure and every dependency is attack surface. Prefer the Node.js standard
library. Development dependencies are less restricted but should still be well maintained.

## Reporting security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
