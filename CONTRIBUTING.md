# Contributing to AI Engineering Team (`aet`)

Thanks for helping make `aet` better. This document covers local setup, the rules that keep the codebase healthy, and what a good PR looks like.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team>

## Development setup

Requirements: **Node.js >= 20.10.0** and npm. Nothing else — the CLI has zero runtime dependencies.

```bash
git clone https://github.com/faizcasm/ai-engineering-team.git
cd ai-engineering-team
npm install        # devDependencies only (typescript, @types/node); `prepare` runs the build
```

Useful scripts:

| Script | Command | Purpose |
|---|---|---|
| `npm run build` | `tsc -p tsconfig.json` | Compile `src/` and `test/` into `dist/` |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` | Strict type checking without emitting |
| `npm test` | `npm run build && node --test "dist/test"` | Build, then run the Node test runner over `dist/test` |
| `npm run dev` | `npm run build && node dist/src/index.js` | Build and run the CLI locally |
| `npm start` | `node dist/src/index.js` | Run an existing build |

Run the CLI without installing it:

```bash
node dist/src/index.js --help
node dist/src/index.js doctor
```

### Testing offline with the mock provider

Tests and manual runs must not hit real networks or need API keys. Use the deterministic mock provider:

```bash
export AET_HOME=/tmp/aet-home                      # keep your real ~/.aet untouched
export AET_MOCK_SCRIPT=/path/to/script.json        # optional: scripted tool calls
node dist/src/index.js -p --provider mock "do the thing"
node dist/src/index.js team "demo" --plan-only --provider mock --dangerously-skip-permissions
```

A mock script is a JSON array of steps:

```json
[
  { "text": "I will create the file." },
  { "toolCalls": [{ "name": "Write", "input": { "file_path": "a.txt", "content": "hi" } }] },
  { "text": "Done." }
]
```

Add tests as `test/<area>.test.ts` files that compile into `dist/test`; the existing suites are `args`, `cli`, `core`, `permissions` and `util`.

## Code style

- **TypeScript, `strict` mode.** No `any` where a real type exists; prefer discriminated unions and explicit interfaces.
- **ESM only.** `"type": "module"` — always use explicit `.js` extensions in relative imports (`import { x } from "./y.js"`), including in tests.
- **Zero runtime dependencies — keep it that way.** `dependencies` must stay empty. Reach for Node built-ins (`node:fs`, `node:child_process`, native `fetch`, `node:test`) instead of adding packages. If you truly need a new *dev* dependency, justify it in the PR.
- **Formatting/idioms:** 2-space indent, double quotes, trailing semicolons, named exports, small single-purpose modules, `interface` for object shapes. Follow the style of the file you are editing.
- **Errors are actionable.** Message format: what failed, where, and what the user should do next (point at the flag, config key or command that fixes it).
- **No secrets in code or tests.** Use environment variables and the `mock` provider.
- **Public behaviour needs a test.** Bug fixes get a regression test; new tools/flags get coverage for both the happy path and the failure path.
- **Comments explain *why*, not *what*.** Keep the file-header docblocks accurate when behaviour changes.

## Commit messages

Use the imperative mood, lowercase, concise subject line (≤ 72 chars), with an optional body explaining the motivation:

```
add timeout control to the WebFetch tool

Bounded fetches keep subagents from hanging on slow docs sites.
```

Suggested scopes (prefix the subject when it helps review):

| Prefix | Use for |
|---|---|
| `cli:` | argument parsing, subcommands, help text |
| `tools:` | built-in tool behaviour and schemas |
| `agent:` / `team:` | the core loop, agents, orchestrator |
| `perm:` | permission engine, rules, approval UI |
| `mcp:` | MCP client/server configuration |
| `prov:` | providers, models, auth |
| `docs:` | README and `docs/*` |
| `test:` | test-only changes |
| `chore:` | build, tooling, housekeeping |

Breaking changes must say `BREAKING CHANGE:` in the body and update [CHANGELOG.md](CHANGELOG.md).

## Pull request checklist

Before you open a PR, make sure that:

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (build + `node --test dist/test`), including tests for new/changed behaviour.
- [ ] No runtime dependency was added — `dependencies` in `package.json` is still `{}`.
- [ ] New flags, config keys or tools are documented: `--help` / `aet help <command>` text, `docs/*.md`, and [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`.
- [ ] Public output stays parseable — if you touched print/JSON output, keep `--output-format json` and `stream-json` shapes backwards compatible or call out the break.
- [ ] Permission behaviour is explicit: read-only work stays auto-approved, mutating work still asks (or is gated by an allow rule).
- [ ] No secrets, no generated files, no unrelated reformatting.
- [ ] The change works offline with `--provider mock`.

PR description template:

```markdown
## What
## Why
## How tested
## Checklist (see CONTRIBUTING.md)
```

## Reporting issues

Open an issue at <https://github.com/faizcasm/ai-engineering-team/issues> with:

- `aet --version` output and your OS/Node version
- the exact command, config and (sanitised) output
- whether it reproduces with `--provider mock` (that separates CLI bugs from provider/API bugs)

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](LICENSE)
