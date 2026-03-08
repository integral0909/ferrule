# @ferrule/lsp

A Language Server Protocol implementation for Ferrule Script, built entirely on `@ferrule/script`
(parsing, type checking, formatting, diagnostics) and the Node.js standard library — no
`vscode-languageserver*` dependency. JSON-RPC framing, dispatch, and cancellation are implemented
directly in `protocol/`; see that directory for the base protocol and `server.ts` for how every
`textDocument/*` request is wired to a feature module under `features/`.

```
source text ⇄ TextDocument (SourceFile)
                    │
                    ▼
     parse + check (@ferrule/script) ──► CheckResult (types, calls, diagnostics)
                    │
                    ▼
   scopeAnalysis.ts (let/closure-param/pattern bindings, scope-aware)
                    │
        ┌───────────┼────────────────────────────────────────────┐
        ▼           ▼            ▼            ▼           ▼      ▼
    hover     completion   signatureHelp  definition/   formatting/
                                          references/    codeAction/
                                          rename/         documentSymbol/
                                          highlight       semanticTokens
```

## Capabilities

| Capability                  | Notes                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textDocumentSync`          | Incremental (`didOpen`/`didChange`/`didClose`), UTF-16 positions                                                                                                                                         |
| `publishDiagnostics`        | Debounced on `didChange` via an injectable scheduler; immediate on open                                                                                                                                  |
| `hover`                     | Expression type (with fallibility), function signature+docs, variable binding info                                                                                                                       |
| `completion`                | Stdlib functions (snippets), in-scope variables, keywords, field paths seen elsewhere in the document; context-aware after `.`/`%` and inside call argument lists (named parameters)                     |
| `signatureHelp`             | Active parameter tracking, positional and named                                                                                                                                                          |
| `definition` / `references` | `let`/`let mut`/`let v, err`/closure-parameter/match-pattern bindings, scope-aware                                                                                                                       |
| `documentHighlight`         | Read vs. write (reassignment) distinguished                                                                                                                                                              |
| `rename`                    | Rejects invalid identifiers, reserved keywords, and same-scope collisions                                                                                                                                |
| `documentFormatting`        | Delegates to `@ferrule/script`'s canonical formatter                                                                                                                                                     |
| `codeAction`                | Quick fixes built from the checker's own suggested fixes                                                                                                                                                 |
| `documentSymbol`            | Every variable binding and `test` declaration                                                                                                                                                            |
| `semanticTokens` (full)     | Keywords, literals, comments, and scope-resolved variable/parameter/function classification — Ferrule Script has no separate TextMate/tree-sitter grammar, so this is the primary highlighting mechanism |

Position encoding is always UTF-16 (the LSP-mandated default, and what `@ferrule/script`'s own
`Span`s already use — see `src/text/positions.ts`), so no `general/positionEncodings` negotiation
is needed.

## Running it

The package exposes an executable, `ferrule-lsp`, that speaks LSP over stdio:

```sh
ferrule-lsp
```

(the `ferrule` CLI package also exposes this as `ferrule lsp`). For embedding in another tool,
call `startLanguageServer` directly with any pair of Node streams:

```ts
import { startLanguageServer } from '@ferrule/lsp';

const server = startLanguageServer({ input: process.stdin, output: process.stdout });
// server.dispose() to stop without waiting for `exit`
```

## Editor setup

### VS Code (generic LSP client extension)

Using an extension such as "Generic LSP Client" (or writing a thin one), point it at the
`ferrule-lsp` executable for files with the `ferrule`/`.fer` language id:

```json
{
  "genericLsp.servers": [
    {
      "languageId": "ferrule",
      "extensions": [".fer"],
      "command": "ferrule-lsp",
      "args": []
    }
  ]
}
```

### Neovim (0.11+, built-in LSP client)

```lua
vim.filetype.add({ extension = { fer = 'ferrule' } })

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'ferrule',
  callback = function(args)
    vim.lsp.start({
      name = 'ferrule-lsp',
      cmd = { 'ferrule-lsp' },
      root_dir = vim.fs.root(args.buf, { '.git', 'ferrule.yaml' }) or vim.fn.getcwd(),
    })
  end,
})
```

With `nvim-lspconfig`, an equivalent user config (until/unless a built-in `ferrule` entry exists):

```lua
require('lspconfig.configs').ferrule = {
  default_config = {
    cmd = { 'ferrule-lsp' },
    filetypes = { 'ferrule' },
    root_dir = require('lspconfig.util').root_pattern('.git', 'ferrule.yaml'),
  },
}
require('lspconfig').ferrule.setup({})
```

### Helix

In `languages.toml`:

```toml
[[language]]
name = "ferrule"
scope = "source.ferrule"
file-types = ["fer"]
roots = ["ferrule.yaml", ".git"]
language-servers = ["ferrule-lsp"]

[language-server.ferrule-lsp]
command = "ferrule-lsp"
```

Helix has no built-in Ferrule Script grammar, so syntax highlighting comes entirely from this
server's `semanticTokens` — no `tree-sitter-ferrule` grammar is required for highlighting to work,
only for indentation/text-object features Helix derives from tree-sitter specifically.

## Package layout

- `src/protocol/` — JSON-RPC 2.0 + LSP base-protocol framing (`Content-Length` headers, UTF-8 byte
  lengths), dispatch, and `$/cancelRequest` support. Transport-agnostic: `MessageConnection` takes
  any `{ input: Readable, output: Writable }` pair, which is how tests drive it with `PassThrough`
  streams instead of real stdio.
- `src/text/` — the document model (`TextDocument`/`DocumentStore`) and UTF-16 offset ⇄
  `{ line, character }` conversion, built on `@ferrule/script`'s `SourceFile`.
- `src/scopeAnalysis.ts` — an LSP-side scope resolver for `let`/closure-parameter/pattern bindings,
  mirroring `@ferrule/script`'s own checker scoping rules exactly, since `CheckResult` resolves
  types but doesn't expose a queryable scope tree after the fact.
- `src/analysis.ts` — parses and checks a document, cached per version.
- `src/features/` — one module per LSP capability, each a pure function from
  `(DocumentAnalysis, ScopeAnalysis, ...) → LSP response`.
- `src/server.ts` — wires every handler to a `MessageConnection`; `startLanguageServer` is the
  package's main entry point.
- `src/scheduler.ts` — the injectable debounce scheduler behind diagnostics republishing.
- `src/bin.ts` — the `ferrule-lsp` executable (stdio transport, `SIGTERM`/`SIGINT` handling).

## Known gaps

- Path/metadata-path completion offers full paths seen elsewhere in the document; it does not
  currently rank or fuzzy-match candidates beyond what the client's own completion UI does with
  `filterText`/`label`.
- `codeAction` only surfaces diagnostics' own suggested fixes (matching `@ferrule/script`'s `Fix`
  model) — there is no refactoring/source-action support beyond quick fixes.
- No workspace-wide features (`workspace/symbol`, multi-file references): Ferrule Script transforms
  are single-file programs, so every feature here is scoped to one open document.
- Inline `test { given { ... } expect { ... } }` blocks are only surfaced as document symbols;
  running them (`ferrule test`) is out of scope for this package.
