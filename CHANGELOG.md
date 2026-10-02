# Changelog

All notable changes to **AI Engineering Team (`aet`)** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · <https://github.com/faizcasm/ai-engineering-team>

## [1.0.0] - 2026-10-03

First public release of **AI Engineering Team** — a zero-runtime-dependency, TypeScript/Node ESM agentic coding CLI with a built-in team of AI engineering agents.

### Added

#### CLI
- `aet [options] [prompt...]` entry point: interactive REPL on a TTY, non-interactive one-shot with `-p/--print` or piped stdin.
- Commands: `agents`, `tools`, `config` (`list`/`get`/`set`/`reset`), `sessions` (`list`/`resume`/`delete`), `doctor`, `mcp` (`list`/`add`/`remove`/`ping`), `init`, `team`, `auth` (`status`/`login`/`logout`), `completions` (`bash`/`zsh`/`fish`), `help`.
- Global options: `--print`, `--model`, `--provider`, `--agent`, `--permission-mode`, `--accept-edits`, `--plan`, `--dangerously-skip-permissions`, `--allowed-tools`, `--disallowed-tools`, `--max-turns`, `--max-tokens`, `--temperature`, `--append-system-prompt`, `--output-format`, `--continue`, `--resume`, `--cwd`, `--url`, `--env`, `--global`, `--force`, `--verbose`, `--quiet`, `--debug`, `--no-color`, `--version`, `--help`; command-specific `--plan-only` and `--max-parallel` for `aet team`.
- `aet init` scaffolds `.aet/config.json`, `AET.md`, a sample `.aet/agents/*.md`, a sample `.aet/commands/*.md` and updates `.gitignore` (`--force` to overwrite).
- `aet doctor` checks the Node runtime, `~/.aet` writability, merged configuration, API credentials, provider resolution and reachability, MCP server health, backend health and workspace instruction files.
- `aet completions bash|zsh|fish` for shell tab completion.
- `--output-format text|json|stream-json` for scripted runs, with `result` / `error` objects and NDJSON event streaming (`text_delta`, `assistant_message`, `tool_start`, `tool_end`, `log`, `compacted`, `subagent_start`, `subagent_end`).

#### Agents
- Eleven built-in roles: `ai-engineer`, `architect`, `backend-engineer`, `devops-engineer`, `documentation-engineer`, `frontend-engineer`, `general`, `qa-engineer`, `researcher`, `reviewer`, `tech-lead`.
- Custom agents from `.aet/agents/*.md` (project) and `~/.aet/agents/*.md` (global) with `name`, `description`, `tools`, `model`, `permissionMode` and `emoji` frontmatter; project files override global and built-in definitions.
- Role selection via `--agent`, `/agent <name>` in the REPL, and `@<role> <prompt>` shorthand.
- `Task` tool for delegating self-contained work to a specialist subagent with fresh context.

#### Providers
- `anthropic`, `openai`, `openrouter`, `groq`, `deepseek`, `ollama` and `mock` providers over native `fetch` with SSE streaming.
- Credential resolution: environment variables first (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_API_KEY`), then `~/.aet/auth.json` via `aet auth login|logout|status`.
- Per-provider base URL overrides (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, `GROQ_BASE_URL`, `DEEPSEEK_BASE_URL`, `OLLAMA_HOST`).
- Model-id prefix and colon aliases (`openrouter/deepseek/…`, `anthropic:claude-haiku-4-5`) plus provider inference from the model id.
- Model registry with context windows, pricing and per-model cost estimation (`cost_usd` in print output, `/cost` in the REPL).
- Deterministic offline `mock` provider driven by `AET_MOCK_SCRIPT` for demos, tests and `aet doctor` — no key or network required.

#### Permissions
- Four modes: `default`, `acceptEdits`, `plan`, `bypassPermissions` (shorthands `--accept-edits`, `--plan`, `--dangerously-skip-permissions`), switchable in the REPL with `/permissions <mode>`.
- Claude-Code-compatible rule syntax: `Bash`, `Bash(git:*)`, `Bash(npm test)`, `Edit(src/**)`, `Write(/abs/path.ts)`, `WebFetch(domain:github.com)`, `mcp__github__search`, `Task(<role>)`, `*`.
- Evaluation order: deny rules → allow rules → permission mode → read-only heuristics → interactive approval.
- Read-only tools and read-only shell commands (`git status`, `ls`, `npm test`-style prefixes) never prompt.
- Interactive approval UI with `y` (allow once), `a` (always allow, persists a suggested rule), `n` (deny); queued so parallel subagents cannot interleave prompts.
- Fail-closed behaviour for non-interactive sessions: approval-required calls are denied with an actionable message.

#### Tools
- Thirteen built-in tools: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `Bash`, `BashOutput`, `KillShell`, `WebFetch`, `TodoWrite`, `Task`.
- `Bash` with timeout control (120s default, 600s max) and background execution polled via `BashOutput` / stopped via `KillShell`.
- `Grep` with `content` / `files_with_matches` / `count` output modes, glob filters and multiline matching; `Glob` sorted by modification time; `Read` with numbered lines and offset/limit paging.
- `TodoWrite` structured task list rendered in the REPL.

#### MCP
- MCP client with both standard transports: stdio (newline-delimited JSON-RPC) and Streamable HTTP (JSON or SSE responses), protocol version `2025-06-18`.
- `aet mcp add <name> -- <command...>`, `aet mcp add <name> --url <url> [--env K=V,…]`, `--global` scope, `aet mcp list`, `aet mcp remove`, `aet mcp ping` with latency and tool counts.
- Config files `.aet/mcp.json` (project) and `~/.aet/mcp.json` (global), merged with project winning on name clashes.
- Server tools are exposed as `mcp__<server>__<tool>` so allow/deny rules can target them individually.
- `mcpEnabled` config key and `AET_MCP` env var to disable MCP entirely.

#### Team pipeline
- `aet team "<goal>"` and `/team <goal>` run plan → delegate → review: a tech-lead JSON plan (1–8 tasks with roles and `dependsOn`), dependency-aware execution with bounded parallelism (`--max-parallel`, default 3), then a reviewer pass over the actual workspace changes.
- `--plan-only` stops after the plan; `--model` overrides the model for all roles.
- Markdown team report with approach, per-task status and timings, review verdict, total cost, duration and session id.

#### Sessions & REPL
- JSONL session transcripts in `~/.aet/sessions/`, listable and resumable (`-c/--continue`, `--resume [id]`, `aet sessions`).
- REPL commands: `/help`, `/clear`, `/compact`, `/resume`, `/sessions`, `/export`, `/model`, `/agents`, `/agent`, `/tools`, `/todos`, `/permissions`, `/config`, `/mcp`, `/commands`, `/team`, `/cost`, `/context`, `/theme`, `/verbose`, `/debug`, `/version`, `/exit`.
- Prompt conveniences: `!command` shell passthrough, `@path` file inlining, `@<role>` role switching, multi-line input with `\` or `.`.
- Auto-compaction of long contexts (`autoCompact`, default 0.8 of the context window) with `/context` and `/cost` introspection.
- Custom slash commands from `.aet/commands/*.md` and `~/.aet/commands/*.md` with `$ARGUMENTS` / `{{args}}` expansion, `model`/`agent`/`allowed-tools` frontmatter.

#### Configuration
- Layered configuration: defaults < `~/.aet/config.json` < `<project>/.aet/config.json` < `AET_*` env vars < CLI flags.
- Config keys: `model`, `provider`, `agent`, `permissionMode`, `allowedTools`, `disallowedTools`, `contextWindow`, `maxTokens`, `maxTurns`, `temperature`, `autoCompact`, `summarizeModel`, `theme`, `color`, `verbose`, `debug`, `backendUrl`, `mcpEnabled`, `mcpServers`.
- Workspace instruction files loaded into the system prompt: `AET.md`, `AGENTS.md`, `CLAUDE.md`, `.aet/AGENTS.md`.

#### Backend
- Optional Express 5 + TypeScript service (`backend/`) with a LangGraph-style plan → assign → execute → review → finalize workflow, provider-agnostic LLM chat API with SSE streaming and retries, MCP server registry CRUD, PostgreSQL/Prisma persistence, Redis rate limiting, BullMQ email queue, and a `/health` endpoint checked by `aet doctor` via `backendUrl`.

### Notes
- Zero runtime dependencies (`dependencies: {}`); `@types/node` and `typescript` are the only dev dependencies.
- Requires Node.js >= 20.10.0.
- Bins: `aet`, `ai-team`, `ai-engineering-team`.

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](LICENSE)
