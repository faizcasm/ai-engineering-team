# AI Engineering Team (`aet`)

**Open-source agentic coding CLI with a built-in team of AI engineers** — a zero-runtime-dependency, TypeScript/Node ESM alternative to Claude Code and Codex.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

`aet` runs one prompt (or a whole plan) against your real workspace with real tools — read/write files, run shell commands, search the codebase, fetch docs, delegate to specialist subagents — behind an explicit permission system. It talks to Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, a local Ollama server, or a fully offline mock provider. No API keys required to try it.

---

**MIT License · Node.js >= 20.10 · 0 runtime dependencies · 13 built-in tools · 11 built-in agents · 7 providers · 4 permission modes**

> **Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso**

---

## Contents

- [Why aet](#why-aet)
- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Commands & flags](#commands--flags)
- [Permission modes](#permission-modes)
- [Team pipeline](#team-pipeline)
- [Custom agents & commands](#custom-agents--commands)
- [MCP servers](#mcp-servers)
- [Providers](#providers)
- [Output formats](#output-formats)
- [Documentation](#documentation)
- [Testing](#testing)
- [Contributing](#contributing)
- [License & author](#license--author)

---

## Why aet

| | |
|---|---|
| **Zero runtime dependencies** | `dependencies: {}` — only Node's standard library, native `fetch` and `tsc` at build time. Nothing to audit, nothing to break. |
| **A team, not a chat box** | Eleven purpose-built engineering roles and a `plan → delegate → review` pipeline, not just one generic assistant. |
| **Permission-first** | Every tool call is evaluated against deny rules, allow rules, a permission mode and read-only heuristics — then you. Non-interactive runs fail closed. |
| **Bring your own model** | Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, local Ollama, or an offline `mock` provider for demos and tests. |
| **Works where you work** | Project-local `.aet/` config, `AET.md`/`AGENTS.md` instruction files, JSONL sessions, shell completions, MCP servers. |
| **Scriptable** | `-p` one-shot mode with `--output-format json` / `stream-json` for CI, hooks and editor integrations. |

## Features

### Agents
Eleven built-in roles: `ai-engineer`, `architect`, `backend-engineer`, `devops-engineer`, `documentation-engineer`, `frontend-engineer`, `general`, `qa-engineer`, `researcher`, `reviewer`, `tech-lead`. Pick one with `--agent <role>`, switch mid-session with `/agent <role>` or `@<role> <prompt>`, or add your own as markdown in `.aet/agents/*.md`.

```
$ aet agents

AI Engineering Team (11 roles)

  🤖 ai-engineer             LLM features, agents, tool schemas, RAG, evals built-in
  🏗️ architect               System design, trade-offs, module and API structure built-in
  🔧 backend-engineer        APIs, services, data models, background jobs built-in
  🚀 devops-engineer         CI/CD, Docker, IaC, releases, environments built-in
  ✏️ documentation-engineer  READMEs, API references, guides, changelogs built-in
  🎨 frontend-engineer       UI components, state, accessibility, performance built-in
  ❓ general                 Default hands-on agent for everyday coding tasks built-in
  🧪 qa-engineer             Tests, bug reproduction, edge-case hunting built-in
  📚 researcher              Docs, libraries and codebase reconnaissance built-in
  🔍 reviewer                Strict code review with file:line findings built-in
  💡 tech-lead               Plans work, breaks goals into tasks, delegates to specialists built-in

Use: aet --agent <role>  |  in REPL: /agent <role>  |  @ai-engineer <prompt>
Add your own: .aet/agents/*.md or /home/you/.aet/agents
```

### Providers
`anthropic` · `openai` · `openrouter` · `groq` · `deepseek` · `ollama` (local) · `mock` (offline). Credentials come from environment variables first, then `~/.aet/auth.json` via `aet auth login`. Every provider has a `*_BASE_URL` override. See [docs/providers.md](docs/providers.md).

### Permissions
Four modes — `default`, `acceptEdits`, `plan`, `bypassPermissions` — plus Claude-Code-compatible allow/deny rules such as `Bash(git:*)`, `Edit(src/**)` and `WebFetch(domain:github.com)`. See [docs/permissions.md](docs/permissions.md).

```
  ▲ Bash (approval required)
  $ git push origin main
  y allow once   a always allow (Bash(git:*))   n deny
  ? approve? [y/a/N] _
```

### Tools
13 built-in tools: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `Bash`, `BashOutput`, `KillShell`, `WebFetch`, `TodoWrite`, `Task` — plus any MCP tool. See [docs/tools.md](docs/tools.md).

```
$ aet tools

Tools (13) - available to every agent

  Read        Read a text file from disk. Returns numbered lines (`N-> content`)…
  Write       Create or overwrite a file with the given content…
  Edit        Replace an exact string in an existing file…
  MultiEdit   Apply several edits to one file in a single call…
  Glob        Find files by glob pattern, e.g. `src/**/*.ts`…
  Grep        Search file contents with a regular expression…
  LS          List directory contents (directories first)…
  Bash        Run a shell command in the project directory…
  BashOutput  Read the output of a background shell…
  KillShell   Terminate a background shell…
  WebFetch    Fetch an http/https URL and return its content as readable text…
  TodoWrite   Maintain a structured task list for the current session…
  Task        Delegate a self-contained chunk of work to a specialist subagent…

MCP: no servers configured (aet mcp add <name> <command...>)
```

### MCP
Add stdio or HTTP Model Context Protocol servers; their tools show up as `mcp__<server>__<tool>` and are individually permissioned. See [docs/mcp.md](docs/mcp.md).

### Sessions
Every turn is persisted to `~/.aet/sessions/<id>.jsonl`. Continue with `-c`/`--continue`, jump back with `--resume [id]`, or manage them with `aet sessions [list|delete <id>]` and the `/sessions`, `/resume`, `/export` REPL commands.

### Team pipeline
`aet team "<goal>"` runs **plan → delegate → review**: a tech-lead decomposes the goal into 1–8 tasks with role assignments and dependencies, specialists execute in parallel (bounded by `--max-parallel`), and a reviewer inspects the real diff before the report is printed.

## Install

### From npm

```bash
npm install -g ai-engineering-team
```

Binaries installed: `aet`, `ai-team`, `ai-engineering-team` (all the same entry point).

### From source

```bash
git clone https://github.com/faizcasm/ai-engineering-team.git
cd ai-engineering-team
npm install          # runs `prepare` → tsc build
npm run build        # tsc -p tsconfig.json
node dist/src/index.js --help
```

Optionally `npm link` to expose `aet` globally.

Requirements: **Node.js >= 20.10.0**, no other runtime dependencies.

## Quickstart

```bash
# 1. scaffold project config, AET.md, a sample agent and a sample command
aet init

# 2. verify installation, config, credentials, MCP and backend health
aet doctor

# 3. credentials — either export a key …
export ANTHROPIC_API_KEY=sk-ant-…
# … or store one for later (reads from stdin if not given as an argument)
aet auth login anthropic
aet auth status

# 4. interactive REPL
aet "add rate limiting to the /api/users endpoint"

# 5. one-shot, machine readable — perfect for scripts and CI
aet -p "summarise this repository" --output-format json
```

No key at hand? Everything works offline with the deterministic mock provider:

```bash
aet --provider mock "offline demo run"
aet -p --output-format json --provider mock "create hello.txt"
```

### What `aet doctor` looks like

```
aet doctor v1.0.0

  ✓ Node.js runtime          v26.9.0 (requires >= 20.10)
  ✓ AET home writable        /home/you/.aet
  ✓ Configuration            model=claude-sonnet-4-5 agent=general mode=default
  ✓ API credentials          anthropic (env)
  ✓ Provider resolution      anthropic / claude-sonnet-4-5
  ✓ Provider reachability    200 in 214ms
  ✓ MCP servers              none configured
  ✓ Workspace                /home/you/projects/api (git repo)
  ✓ Instruction files        AET.md

checked in 312ms · 0 issue(s)
```

### What a print run looks like

```bash
$ aet -p --output-format json --provider mock "create hello.txt"
{"type":"result","subtype":"end_turn","result":"I will create the file.","session_id":"20261003-020924-cict","turns":1,"usage":{"inputTokens":418,"outputTokens":6},"cost_usd":0.001344,"duration_ms":29,"model":"claude-sonnet-4-5","agent":"general","cwd":"/tmp/aet-demo"}
```

### Project scaffolding from `aet init`

```
created .aet/ scaffolding:
  .aet/config.json
  AET.md
  .aet/agents/backend-expert.md
  .aet/commands/review.md

next: edit AET.md with your project instructions, then run `aet`
```

`aet init --force` overwrites existing files; it also appends `.aet/sessions/` and `.aet/cache/` to `.gitignore` when that file exists.

## Commands & flags

Run `aet help <command>` for extended usage.

| Command | What it does |
|---|---|
| `aet [options] [prompt…]` | Start the REPL, or run one turn with `-p` / piped stdin |
| `aet init` | Scaffold `.aet/` (config, agents, commands) + `AET.md` in the current project |
| `aet doctor` | Diagnose installation, credentials, MCP servers and backend health |
| `aet agents` | List built-in and custom team roles |
| `aet tools` | List built-in tools and configured MCP servers |
| `aet team "<goal>"` | Multi-agent plan → delegate → review pipeline |
| `aet mcp [list\|add\|remove\|ping]` | Manage MCP servers (stdio and HTTP) |
| `aet config [list\|get <key>\|set <key> <value>\|reset]` | Read/write configuration |
| `aet auth [status\|login <provider>\|logout <provider>]` | Manage stored API keys |
| `aet sessions [list\|delete <id>]` | List or delete saved sessions (`aet sessions resume <id>` resumes) |
| `aet completions [bash\|zsh\|fish]` | Print a shell completion script |
| `aet help [command]` / `aet --help` | Help |
| `aet version` / `aet -V` | Print version, author and build info |

### Global options

| Flag | Description |
|---|---|
| `-p, --print` | Non-interactive: run one turn, print the answer, exit |
| `-m, --model <model>` | Model id (e.g. `claude-sonnet-4-5`, `gpt-5.1`, `openrouter/deepseek/…`) |
| `--provider <id>` | `anthropic`, `openai`, `openrouter`, `groq`, `deepseek`, `ollama`, `mock` |
| `-a, --agent <role>` | Team role for this run (see `aet agents`) |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `--accept-edits` | Shorthand for `--permission-mode acceptEdits` |
| `--plan` | Shorthand for `--permission-mode plan` (read-only) |
| `--dangerously-skip-permissions` | No approval prompts at all (bypassPermissions) |
| `--allowed-tools <rules>` | Comma-separated allow rules, e.g. `"Bash(git:*),Write(src/**)"` |
| `--disallowed-tools <rules>` | Comma-separated deny rules |
| `--max-turns <n>` | Max tool iterations per turn (default 60) |
| `--max-tokens <n>` | Max output tokens per request |
| `--temperature <t>` | Sampling temperature |
| `--append-system-prompt <text>` | Extra instructions appended to the system prompt |
| `--output-format <fmt>` | `text` (default), `json`, `stream-json` — for `--print` |
| `-c, --continue` | Continue the most recent session in this directory |
| `--resume [id]` | Resume a session (omit the value for the most recent one) |
| `--cwd <dir>` | Run as if started in `<dir>` |
| `--url <url>` | MCP server URL (`aet mcp add`) |
| `--env <K=V,…>` | Environment variables for an MCP server |
| `--global` | Write to `~/.aet` instead of the project `.aet/` |
| `-f, --force` | Overwrite existing files (`aet init`) |
| `-v, --verbose` | Verbose output (tool results, token counts) |
| `-q, --quiet` | Suppress non-essential output |
| `--debug` | Debug logging to stderr |
| `--no-color` | Disable ANSI colors |
| `-V, --version` | Print version and exit |
| `-h, --help` | Show help |

### The REPL

`aet` with a TTY opens an interactive session. Useful input forms and commands:

| Input | Effect |
|---|---|
| `!git status` | Run a shell command directly |
| `@src/index.ts what does this export?` | Inline a file into your prompt |
| `@reviewer check my last change` | Run the prompt as a specific role |
| `\` at end of line, or `.` alone | Multi-line input |
| `/help` | All slash commands (`/clear`, `/compact`, `/model [id]`, `/agents`, `/agent <name>`, `/tools`, `/todos`, `/permissions [mode]`, `/config`, `/mcp`, `/sessions`, `/resume`, `/export <file>`, `/team <goal>`, `/commands`, `/cost`, `/context`, `/theme default\|mono`, `/verbose`, `/debug`, `/exit`) |

## Permission modes

| Mode | Edits (`Write`/`Edit`/`MultiEdit`) | Shell | Reads | `Task` / `WebFetch` | MCP tools (`mcp__…`) |
|---|---|---|---|---|---|
| `default` | ask | ask (read-only commands auto-approved) | auto | ask | ask |
| `acceptEdits` | **auto-approved** | ask (read-only commands auto-approved) | auto | ask | ask |
| `plan` | **denied** | **denied** unless read-only | auto | **denied** | ask¹ |
| `bypassPermissions` | auto | auto | auto | auto | auto |

¹ Plan mode has no mutating-tool match for MCP tools, so they fall through to the approval prompt — which is auto-denied in non-interactive runs. Deny rules always win.

- Set with `--permission-mode <mode>` or the shorthands `--accept-edits`, `--plan`, `--dangerously-skip-permissions`; in the REPL with `/permissions <mode>`; persistently via `permissionMode` in config.
- Allow/deny rules are evaluated **before** the mode: deny rules win, then allow rules.
- Non-interactive runs (`-p`, piped stdin) have no prompt — anything that needs approval is **denied** with a message pointing at `--dangerously-skip-permissions`, an allow rule, or `bypassPermissions`.

Full rule syntax and examples: **[docs/permissions.md](docs/permissions.md)**.

## Team pipeline

```bash
aet team "ship a REST API with tests and CI"
aet team "explain and document the auth flow" --plan-only
aet team "migrate the user table" --max-parallel 2 --model claude-opus-4-6
```

How it runs:

1. **Plan** — a tech-lead prompt turns the goal into a JSON plan: 1–8 tasks (3–5 preferred), each with an `id`, `title`, self-contained `description`, an assigned `role` and `dependsOn` links.
2. **Delegate** — tasks run with dependency-aware scheduling and bounded parallelism (`--max-parallel`, default 3). Each specialist gets a fresh agent, the team goal, the tech lead's approach and any upstream task output.
3. **Review** — a `reviewer` agent inspects the actual workspace changes (`git diff`, modified files) and produces a verdict, remaining risks and prioritised follow-ups.
4. **Report** — the markdown report, per-task timings, total cost and session id are printed.

`--plan-only` stops after step 1 — ideal for reviewing the plan before spending tokens.

Example run (illustrative content, real log/report format):

```
 → tech-lead: planning…
 → backend-engineer: add /api/users rate limiter
 ✓ backend-engineer: add /api/users rate limiter (12s)
 → qa-engineer: cover the limiter with tests
 ✓ qa-engineer: cover the limiter with tests (18s)
 → reviewer: inspecting the work…

# Team report: ship a REST API with tests and CI

**Approach:** Expose the API behind an Express router, add a token-bucket limiter …
## Tasks

- ✅ **Add /api/users rate limiter** `backend-engineer` (12s)
- ✅ **Cover the limiter with tests** `qa-engineer` (18s)

## Review

1. Verdict: limiter is in place, 6 tests pass locally …
2. What remains / risks: burst sizing is still a guess …

— completed in 41s
cost: $0.0871 · 41s· session 20261003-021130-k2fa
```

*(`--plan-only` report on the mock provider, verbatim:)*

```
# Team report: demo goal

**Approach:** I will create the file.

## Tasks

— completed in 3ms

cost: $0.0010 · 3ms· session 20261003-020924-z9oo
```

The same pipeline is available inside the REPL with `/team <goal>`.

## Custom agents & commands

### Agents — `.aet/agents/*.md` (project) or `~/.aet/agents/*.md` (global)

```markdown
---
name: database-expert
description: Designs schemas, indexes and migrations
tools: Read, Grep, Glob, Bash, Edit
model: claude-haiku-4-5
permissionMode: acceptEdits
emoji: 🗄️
---
You are the database expert for THIS repository.

- Learn the schema and migration conventions already in use before writing SQL.
- Prefer additive migrations; never rewrite history.
- Validate inputs, keep transactions small, and update tests alongside schema changes.
```

Supported frontmatter fields: `name` (defaults to the file name), `description` (defaults to the first line of the body), `tools` (comma-separated allow-list; omitted = all tools), `model`, `permissionMode`, `emoji`. Everything after the closing `---` is the system prompt. Project files override global files, and a `name` matching a built-in replaces it. Verify with `aet agents`.

### Commands — `.aet/commands/*.md` → `/name` in the REPL

```markdown
---
name: review
description: Review the current diff like a strict staff engineer
allowed-tools: Read, Glob, Grep, Bash
---
Review the uncommitted changes in this repository ($ARGUMENTS).

1. Run `git status --porcelain` and `git diff` to see what changed.
2. Read the changed files with context around every hunk.
3. Report: summary, blockers (file:line + why + fix), suggestions, verdict.
```

Supported frontmatter fields: `name`, `description`, `model`, `agent`, `allowed-tools` (or `allowed_tools`). In the body, `$ARGUMENTS`, `{{args}}` and `{{arg}}` are replaced by the text typed after `/review`, and `@path/to/file.ts` references are inlined (up to 50k chars each) before the prompt is sent. List them with `/commands`.

### Workspace instructions

`aet` loads the first instruction files it finds, in this order: `AET.md`, `AGENTS.md`, `CLAUDE.md`, `.aet/AGENTS.md`. `aet init` creates a commented `AET.md` template covering purpose, commands, architecture, conventions and out-of-scope areas.

## MCP servers

```bash
# stdio server (everything after `--` is the command)
aet mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .

# HTTP server with headers
aet mcp add github --url https://mcp.github.com/mcp --env GITHUB_TOKEN=ghp_xxx

# install globally instead of in this project
aet mcp add postgres --global -- npx -y @modelcontextprotocol/server-postgres postgresql://…

aet mcp list
aet mcp ping            # or: aet mcp ping filesystem
aet mcp remove github
```

Servers live in `.aet/mcp.json` (project) or `~/.aet/mcp.json` (`--global`; project wins on name clashes). Tools appear to the model as `mcp__<server>__<tool>` and rules match that exact name:

```bash
aet --allowed-tools "mcp__filesystem__read_file,mcp__filesystem__list_directory" -p "what is in ./docs?"
aet --disallowed-tools "mcp__github__create_or_update_file,mcp__github__push_files" -p "open a PR"
```

Details and troubleshooting: **[docs/mcp.md](docs/mcp.md)**.

## Providers

| Provider id | API key env var | Base URL override (default) | Example model ids |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`) | `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` (`https://api.openai.com/v1`) | `gpt-5.1`, `gpt-5.6-terra`, `gpt-4.1`, `o4-mini` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` (`https://openrouter.ai/api/v1`) | `deepseek/deepseek-chat`, `deepseek-chat` |
| `groq` | `GROQ_API_KEY` | `GROQ_BASE_URL` (`https://api.groq.com/openai/v1`) | any Groq OpenAI-compatible id |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` (`https://api.deepseek.com/v1`) | `deepseek-chat` |
| `ollama` | none required (`OLLAMA_API_KEY` optional) | `OLLAMA_HOST` (`http://127.0.0.1:11434`) | `qwen2.5-coder:7b`, `llama3.1:8b` |
| `mock` | none | — | `mock` (drive it with `AET_MOCK_SCRIPT=/path/script.json`) |

- Resolution order: `--provider` flag → model-id prefix (`openrouter/deepseek/…`, `anthropic:claude-haiku-4-5`) → inference from the model id → config `provider`.
- Credentials: **env var wins**, then `~/.aet/auth.json` written by `aet auth login <provider>` (`anthropic`, `openai`, `openrouter`, `groq`, `deepseek`).
- `aet doctor` reports which sources were found and whether the endpoint responds.

Full reference: **[docs/providers.md](docs/providers.md)**.

## Output formats

`--output-format` applies to `-p`/`--print` (and piped stdin):

| Format | Shape |
|---|---|
| `text` (default) | Rendered markdown answer on stdout; logs, warnings and `--verbose` tool traces on stderr |
| `json` | One JSON object on stdout |
| `stream-json` | Newline-delimited JSON events as they happen, then a final `result` event |

`json` result object:

```json
{
  "type": "result",
  "subtype": "end_turn",
  "result": "I will create the file.",
  "session_id": "20261003-020924-cict",
  "turns": 1,
  "usage": { "inputTokens": 418, "outputTokens": 6 },
  "cost_usd": 0.001344,
  "duration_ms": 29,
  "model": "claude-sonnet-4-5",
  "agent": "general",
  "cwd": "/tmp/aet-demo"
}
```

`stream-json` event types: `text_delta`, `assistant_message`, `tool_start`, `tool_end`, `log`, `compacted`, `subagent_start`, `subagent_end`, `result`, and `error` on failure. Exit code is `0` for a normal turn, `1` when the run fails, `2` for usage errors.

```bash
aet -p --output-format stream-json "refactor the parser" | jq -r 'select(.type=="tool_start") | .name'
```

## Documentation

| Guide | Covers |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Every config key, precedence, file locations, env vars |
| [docs/agents.md](docs/agents.md) | The 11 built-in roles, custom agent files, `/agent` & `@role`, the team pipeline |
| [docs/tools.md](docs/tools.md) | Built-in tool inputs and permission behaviour, MCP tool naming |
| [docs/permissions.md](docs/permissions.md) | Modes, rule syntax, approval UI, non-interactive behaviour |
| [docs/providers.md](docs/providers.md) | Providers, credentials, base URLs, models, offline mock |
| [docs/mcp.md](docs/mcp.md) | Adding/inspecting MCP servers, transports, troubleshooting |

Also: [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · `aet help <command>`

## Testing

```bash
npm test          # npm run build && node --test "dist/test"
npm run typecheck # tsc --noEmit
npm run dev       # build, then run the CLI from dist
```

The suite runs fully offline against the `mock` provider — no API keys, no network.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the code style rules (TypeScript strict, ESM, **keep the zero-dependency promise**) and the PR checklist.

## License & author

Released under the [MIT License](LICENSE).

> **Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso**
>
> Repo: <https://github.com/faizcasm/ai-engineering-team> · Copyright (c) 2026 Faizan Hameed · License: MIT
