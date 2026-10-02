# Configuration

Everything `aet` does can be configured through layered configuration: built-in defaults, a user config file, a project config file, environment variables and CLI flags.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Precedence

From lowest to highest priority (later sources win):

```
built-in defaults
  < ~/.aet/config.json            (user config)
  < <cwd>/.aet/config.json        (project config)
  < environment (AET_* variables)
  < CLI flags                     (also REPL mutations like /model, /permissions)
```

`aet config list` prints the merged result and the same order:

```
$ aet config list

Configuration (defaults < ~/.aet/config.json < .aet/config.json < env < flags)

  model              claude-sonnet-4-5
  agent              general
  permissionMode     default
  allowedTools       [Read, Glob, Grep, LS, TodoWrite, Task, BashOutput, KillShell]
  disallowedTools    []
  contextWindow      200000
  maxTokens          32000
  maxTurns           60
  autoCompact        0.8
  theme              default
  color              true
  verbose            false
  debug              false
  mcpEnabled         true
  mcpServers         {}
```

Merge rules:

- Scalars are replaced by the higher-priority source.
- `allowedTools` / `disallowedTools` are **replaced wholesale** (not concatenated) by whatever layer sets them.
- `mcpServers` objects are **merged key by key**; a project entry with the same name overrides the user entry.
- Unknown keys in a config file are ignored (only recognised keys are applied) — so `$comment` and `$schema`-style annotations are safe to leave in the file.
- `undefined`/`null` values are skipped rather than applied.
- `permissionMode` is validated at load; an invalid value fails fast:
  `Invalid permission mode "x". Expected one of: default, acceptEdits, plan, bypassPermissions`
- `NO_COLOR` (any value) disables colour unless `--no-color`-style overrides are absent and you re-enable it via `/theme default`; `--no-color` and `AET_THEME=mono` are the supported switches.

## File locations

### User-level (`~/.aet/`, or wherever `AET_HOME` points)

Set `AET_HOME` to relocate the whole home directory (useful in tests/CI):

| Path | Purpose |
|---|---|
| `~/.aet/` | Root of all CLI state (`AET_HOME` overrides it) |
| `~/.aet/config.json` | User configuration — written by `aet config set` |
| `~/.aet/auth.json` | Stored API keys (`aet auth login`) |
| `~/.aet/sessions/` | Session transcripts, one `<id>.jsonl` per session |
| `~/.aet/agents/` | Global custom agents (`*.md`) |
| `~/.aet/commands/` | Global custom slash commands (`*.md`) |
| `~/.aet/mcp.json` | Global MCP server registry |
| `~/.aet/history` | REPL prompt history |
| `~/.aet/logs/` | Debug logs |

### Project-level (`<cwd>/.aet/`)

| Path | Purpose |
|---|---|
| `<cwd>/.aet/config.json` | Project configuration (checked in, shared with the team) |
| `<cwd>/.aet/agents/` | Project agents (override global/built-ins of the same name) |
| `<cwd>/.aet/commands/` | Project slash commands |
| `<cwd>/.aet/mcp.json` | Project MCP servers (merged over `~/.aet/mcp.json`) |
| `<cwd>/AET.md` | Workspace instructions loaded into every session |
| `<cwd>/AGENTS.md`, `<cwd>/CLAUDE.md`, `<cwd>/.aet/AGENTS.md` | Alternative instruction files (checked in that order) |

`aet init` creates `.aet/config.json`, `AET.md`, a sample agent, a sample command, and appends `.aet/sessions/` + `.aet/cache/` to `.gitignore`. Use `--force` to overwrite existing files.

## Configuration keys

| Key | Type | Default | Env var | CLI flag | Notes |
|---|---|---|---|---|---|
| `model` | string | `claude-sonnet-4-5` | `AET_MODEL` | `-m, --model <id>` | Any model id; prefixes like `openrouter/deepseek/…` select the provider |
| `provider` | string | inferred from the model | `AET_PROVIDER` | `--provider <id>` | `anthropic`, `openai`, `openrouter`, `groq`, `deepseek`, `ollama`, `mock` |
| `agent` | string | `general` | `AET_AGENT` | `-a, --agent <role>` | Default role for turns (see [agents.md](agents.md)) |
| `permissionMode` | string | `default` | `AET_PERMISSION_MODE` | `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `allowedTools` | string[] | `["Read","Glob","Grep","LS","TodoWrite","Task","BashOutput","KillShell"]` | `AET_ALLOWED_TOOLS` (comma list) | `--allowed-tools <rules>` | Rules that auto-allow a tool, e.g. `Bash(git:*)` |
| `disallowedTools` | string[] | `[]` | `AET_DISALLOWED_TOOLS` (comma list) | `--disallowed-tools <rules>` | Hard deny rules — evaluated before allow rules |
| `contextWindow` | number | `200000` | `AET_CONTEXT_WINDOW` | — | Total context budget in tokens |
| `maxTokens` | number | `32000` | `AET_MAX_TOKENS` | `--max-tokens <n>` | Max output tokens per request |
| `maxTurns` | number | `60` | `AET_MAX_TURNS` | `--max-turns <n>` | Max tool-loop iterations per user turn |
| `temperature` | number | unset | `AET_TEMPERATURE` | `--temperature <t>` | Sampling temperature |
| `autoCompact` | number | `0.8` | — | — | Fraction of `contextWindow` that triggers automatic compaction |
| `summarizeModel` | string | unset (uses the active model) | `AET_SUMMARIZE_MODEL` | — | Model used to write compaction summaries |
| `theme` | `default` \| `mono` | `default` | `AET_THEME` | — | `mono` also disables colour; REPL: `/theme default\|mono` |
| `color` | boolean | `true` | `NO_COLOR` (disables) | `--no-color` | ANSI colour output |
| `verbose` | boolean | `false` | — | `-v, --verbose` | Tool results, token counts; REPL: `/verbose` |
| `debug` | boolean | `false` | `AET_DEBUG` (`0`/`false` disables) | `--debug` | Debug logging to stderr |
| `backendUrl` | string | unset | `AET_BACKEND_URL` | — | Optional backend base URL; `aet doctor` probes `<backendUrl>/health` |
| `mcpEnabled` | boolean | `true` | `AET_MCP` (`0`/`false` disables) | — | Master switch for MCP servers |
| `mcpServers` | object | `{}` | — | — | Inline server definitions, merged over the `mcp.json` files |

Additional flags that are **not** stored as config keys but affect a run: `--append-system-prompt <text>`, `--print`, `--output-format`, `--continue`, `--resume`, `--cwd`, `--force`, `--quiet`, `--global`, `--url`, `--env`, and the `aet team` options `--plan-only` / `--max-parallel`.

### Environment variables (summary)

| Variable | Effect |
|---|---|
| `AET_HOME` | Relocate `~/.aet` (all state: config, auth, sessions, agents, commands, logs) |
| `AET_MODEL`, `AET_PROVIDER`, `AET_AGENT`, `AET_PERMISSION_MODE` | Override the matching config keys |
| `AET_ALLOWED_TOOLS`, `AET_DISALLOWED_TOOLS` | Comma-separated rule lists |
| `AET_MAX_TURNS`, `AET_CONTEXT_WINDOW`, `AET_MAX_TOKENS`, `AET_TEMPERATURE` | Numeric overrides |
| `AET_SUMMARIZE_MODEL` | Compaction summary model |
| `AET_BACKEND_URL` | Backend base URL for `aet doctor` |
| `AET_DEBUG`, `AET_MCP`, `AET_THEME` | Boolean/enum overrides |
| `AET_MOCK_SCRIPT` | Path to a JSON script for the `mock` provider |
| `NO_COLOR` | Disable colours |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_API_KEY` | Provider credentials (always win over `~/.aet/auth.json`) |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, `GROQ_BASE_URL`, `DEEPSEEK_BASE_URL`, `OLLAMA_HOST` | Provider endpoint overrides |
| `AET_ANTHROPIC_API_KEY`, `AET_OPENAI_API_KEY`, … | Read by `aet auth login <provider>` when no key is given on stdin |

## Managing configuration

```bash
aet config list                 # merged configuration + precedence order
aet config get model            # one value (dot paths allowed: aet config get mcpServers)
aet config set model gpt-5.1    # writes ~/.aet/config.json
aet config set allowedTools "Bash(git:*),Edit(src/**)"
aet config reset                # restore user config to defaults
```

Values are parsed as scalars: `true`/`false`/`null`, numbers, JSON arrays/objects (`[...]`, `{...}`), comma-separated lists, otherwise strings.

Inside the REPL: `/config` reads values, `/config set <key> <value>` writes them, `/permissions <mode>` switches permission mode, `/model <id>` switches model for the session.

## Examples

### Project config checked into git — `.aet/config.json`

```json
{
  "$comment": "Shared team defaults for this repository",
  "model": "claude-sonnet-4-5",
  "agent": "general",
  "permissionMode": "default",
  "allowedTools": [
    "Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "BashOutput", "KillShell",
    "Bash(git status)", "Bash(git diff:*)", "Bash(npm test)", "Bash(npm run build)",
    "Edit(src/**)", "Edit(test/**)"
  ],
  "disallowedTools": ["Bash(rm:*)", "Bash(sudo:*)"],
  "maxTurns": 80,
  "autoCompact": 0.75
}
```

### User config — `~/.aet/config.json`

```json
{
  "provider": "openrouter",
  "model": "openrouter/deepseek/deepseek-chat",
  "theme": "default",
  "verbose": false,
  "mcpEnabled": true
}
```

### One-off overrides with flags

```bash
aet --model claude-opus-4-6 --permission-mode plan "explain the auth flow"
aet --allowed-tools "Bash(npm:*),Edit(src/**)" -p "fix the failing test"
AET_AGENT=reviewer aet -p "review the current diff"
```

### Offline / CI

```bash
export AET_HOME=/tmp/aet-home
export AET_MOCK_SCRIPT=/tmp/aet-mock-script.json
aet -p --provider mock --output-format json "hello"
```

## Related

- [agents.md](agents.md) — roles and custom agent files
- [permissions.md](permissions.md) — modes and rule syntax
- [providers.md](providers.md) — credentials, base URLs, models
- [mcp.md](mcp.md) — MCP server configuration

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
