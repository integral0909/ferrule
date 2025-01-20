# Security Policy

## Supported versions

Ferrule is pre-1.0. Security fixes are made on the latest release line only.

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/integral0909/ferrule/security/advisories/new).
Do not open a public issue.

Include, where possible:

- the affected version or commit,
- a minimal pipeline configuration or input that reproduces the issue,
- the impact you believe it has.

You can expect an acknowledgement within 5 working days and a status update at least every
two weeks until the issue is resolved. Fixed vulnerabilities are disclosed in a GitHub
Security Advisory once a release containing the fix is available.

## Security design principles

Ferrule processes untrusted input by design. The codebase follows these rules:

- **Parsers are bounded.** Every decoder enforces limits on nesting depth, message size, and
  field counts, and fails with a typed error rather than exhausting memory or stack.
- **No prototype pollution surface.** Event objects are `Map`-backed; untrusted keys are never
  written to plain JavaScript objects.
- **No dynamic code evaluation of input.** Ferrule Script compiles to closures; it never uses
  `eval` or `new Function` on user-supplied text.
- **Secrets stay out of logs.** Configuration values marked secret are redacted in diagnostics,
  the admin API, and `tap` output.
- **Minimal runtime dependencies**, reviewed on every addition, with automated dependency
  auditing in CI.
