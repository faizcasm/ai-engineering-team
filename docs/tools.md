# Tools

Every agent — built-in or custom — runs against your workspace through a fixed set of built-in tools, plus any tools contributed by MCP servers. List them with `aet tools` (or `/tools` in the REPL).

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Overview

| Tool | Purpose | Key inputs | Permission behaviour |
|---|---|---|---|
| `Read` | Read a text file with line numbers | `file_path`, `offset`, `limit` | read-only → always allowed |
| `Write` | Create/overwrite a file (creates parents, shows a diff) | `file_path`, `content` | edit → mode-dependent |
| `Edit` | Replace an exact string in a file | `file_path`, `old_string`, `new_string`, `replace_all` | edit → mode-dependent |
| `MultiEdit` | Several ordered edits to one file in a single call | `file_path`, `edits[]` | edit → mode-dependent |
| `Glob` | Find files by pattern (newest first) | `pattern`, `path`, `limit`, `modified_desc` | read-only → always allowed |
| `Grep` | Regex search of file contents | `pattern`, `path`, `glob`, `ignore_case`, `multiline`, `output_mode`, `head_limit` | read-only → always allowed |
| `LS` | List a directory (non-recursive, dirs first) | `path`, `ignore` | read-only → always allowed |
| `Bash` | Run a shell command (optionally in the background) | `command`, `timeout`, `description`, `run_in_background` | read-only commands auto-approved, otherwise ask |
| `BashOutput` | Poll output of a background shell | `background_id` | read-only → always allowed |
| `KillShell` | Terminate a background shell | `background_id` | read-only → always allowed |
| `WebFetch` | Fetch an http(s) URL as readable text | `url`, `prompt`, `max_chars` | ask (denied in `plan` mode) |
| `TodoWrite` | Maintain the session task list | `todos[]` | read-only → always allowed |
| `Task` | Delegate work to a specialist subagent | `description`, `prompt`, `subagent_type`, `model` | ask (denied in `plan` mode) |

"Mode-dependent" means the [permission mode](permissions.md) decides: `default` asks, `acceptEdits` auto-approves edits, `plan` denies, `bypassPermissions` auto-approves. Deny rules are evaluated **before** all of this; read-only work is never prompted in any mode.

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

## Built-in tools

### `Read`

Read a text file from disk. Output is line-numbered (`N-> content`) so edits can cite `file_path:line`. Prefer it over shell `cat`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | yes | Absolute or workspace-relative |
| `offset` | number | no | 1-based start line (default `1`) |
| `limit` | number | no | Max lines to return (default `2000`) |

Permission: read-only — allowed in every mode unless a deny rule matches.

### `Write`

Create or overwrite a file with the given content. Parent directories are created as needed and the result includes a diff of what changed.

| Input | Type | Required |
|---|---|---|
| `file_path` | string | yes |
| `content` | string | yes |

Permission: edit tool — `default` prompts, `acceptEdits` approves, `plan` denies, `bypassPermissions` approves.

### `Edit`

Replace an exact string in an existing file.

| Input | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | yes | Absolute or workspace-relative |
| `old_string` | string | yes | Must match **exactly once** unless `replace_all` |
| `new_string` | string | yes | Replacement text |
| `replace_all` | boolean | no | Replace every occurrence (default `false`) |

Permission: edit tool (same as `Write`). Read the file first and copy `old_string` verbatim, including indentation.

### `MultiEdit`

Apply several edits to one file in a single call. Edits run in order and each `old_string` must match exactly once.

| Input | Type | Required |
|---|---|---|
| `file_path` | string | yes |
| `edits` | array | yes — `{ old_string, new_string, replace_all? }` per item |

Permission: edit tool (same as `Write`).

### `Glob`

Find files by glob pattern — `src/**/*.ts`, `**/*.test.{js,ts}`; supports `*`, `**`, `?` and `{a,b}`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | yes | Glob pattern |
| `path` | string | no | Directory to search from (default: workspace root) |
| `limit` | number | no | Max results (default `200`) |
| `modified_desc` | boolean | no | Sort newest first (default `true`) |

Permission: read-only.

### `Grep`

Search file contents with a regular expression; results come back as `path:line:content`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | yes | Regular expression |
| `path` | string | no | File or directory (default: workspace root) |
| `glob` | string | no | Filter files, e.g. `*.ts` |
| `ignore_case` | boolean | no | Case-insensitive |
| `multiline` | boolean | no | `.` matches newlines |
| `output_mode` | `content` \| `files_with_matches` \| `count` | no | Default `content` |
| `head_limit` | number | no | Max results (default `100`) |

Permission: read-only.

### `LS`

List directory contents, directories first. Non-recursive — use `Glob` for recursive searches.

| Input | Type | Required | Notes |
|---|---|---|---|
| `path` | string | no | Default: workspace root |
| `ignore` | string[] | no | Entry names to hide |

Permission: read-only.

### `Bash`

Run a shell command in the project directory; returns stdout/stderr plus the exit code. Use it for builds, tests, git, package managers and any CLI.

| Input | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | The shell command |
| `timeout` | number | no | Milliseconds — default `120000`, max `600000` |
| `description` | string | no | Short human-readable description (shown in progress output) |
| `run_in_background` | boolean | no | Run detached; poll with `BashOutput`, stop with `KillShell` |

Permission: commands on the built-in read-only list (`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `which`, `whoami`, `echo`, `env`, `du`, `df`, `node -v`, `npm -v`, `git status`, `git log`, `git diff`, `git show`, `git branch`, `git remote -v`, `git config --get`, `git stash list`, `git ls-files`, `git blame`, `grep`, `rg`, `find`, `tree`, `ps`, `tsc --noEmit`, `curl -sI`, `ping -c`, …) are auto-approved. Chains of read-only commands (`git status && git log`) are allowed too; anything containing a redirect or a mutating word (`rm`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `kill`, `write`) is **not** read-only and needs approval (or an allow rule like `Bash(git:*)`).

### `BashOutput`

Read the output of a background shell started with `Bash` with `run_in_background: true`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `background_id` | string | yes | e.g. `bg_1` |

Returns the captured output plus `[still running]` or `[exited with code N, running for …]`. Permission: read-only.

### `KillShell`

Terminate a background shell.

| Input | Type | Required |
|---|---|---|
| `background_id` | string | yes |

Permission: read-only (the process may already have exited — that is reported, not an error).

### `WebFetch`

Fetch an http/https URL and return its content as readable text (HTML is converted to plain text). Use it for documentation, issues, RFCs and API references.

| Input | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Only `http:` / `https:` are accepted |
| `prompt` | string | no | What to extract (recorded for context) |
| `max_chars` | number | no | Truncate after N characters (default `60000`) |

Permission: not read-only → prompts in `default`/`acceptEdits`, **denied in `plan` mode**, auto-approved in `bypassPermissions`. Allow-list a domain with `WebFetch(domain:github.com)`.

### `TodoWrite`

Maintain a structured task list for the session. Call it at the start of a multi-step job and update it as work progresses — exactly one `in_progress` item, finished items `completed`.

| Input | Type | Required |
|---|---|---|
| `todos` | array | yes — `{ content, status, activeForm? }`, where `status` ∈ `pending` / `in_progress` / `completed` |

The list replaces the previous one and is rendered in the REPL (`/todos`). Permission: read-only.

### `Task`

Delegate a self-contained chunk of work to a specialist subagent — fresh context, its own tool loop — and get back its final report. Use it for parallelisable or context-heavy work: research, implementing a module, writing tests, reviewing a diff.

| Input | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | 3–5 word summary |
| `prompt` | string | yes | Full instructions: paths, constraints, expected output format |
| `subagent_type` | string | yes | A known team role (see [agents.md](agents.md)) |
| `model` | string | no | Model override for the subagent |

Permission: prompts in `default`/`acceptEdits`, **denied in `plan` mode**, auto-approved in `bypassPermissions`. `Task` is in the default `allowedTools` list, so it is pre-approved unless you remove it. Scope it with `Task(qa-engineer)`-style rules; subagent prompts are labelled `- subagent` in the approval UI.

## MCP tools

Tools from configured MCP servers are registered alongside the built-ins under the name:

```
mcp__<server>__<tool>
```

For example, a server named `filesystem` exposing `read_file` becomes `mcp__filesystem__read_file`. The description gains a `(server: <name>)` suffix and the progress display shows `server/tool`.

- Discovery happens at session start (`aet tools` and `/tools` show the servers; run `aet mcp ping` to verify).
- Servers with `"enabled": false` are skipped, and `mcpEnabled: false` (or `AET_MCP=0`) disables MCP entirely.
- Transport/timeouts: stdio and Streamable HTTP both connect with a 15s timeout; a tool call may run for up to 120s. See [mcp.md](mcp.md).
- Permission: MCP tools are not read-only and do not match plan mode's mutating list — they fall through to the approval prompt (auto-denied when non-interactive). Deny rules always win.

Rules match the **exact** tool name — there is no wildcard inside the tool-position of a rule:

```bash
# allow exactly two filesystem tools, ask for everything else
aet --allowed-tools "mcp__filesystem__read_file,mcp__filesystem__list_directory" -p "list ./docs"

# hard-deny specific tools (deny beats any allow rule)
aet --disallowed-tools "mcp__github__create_or_update_file,mcp__github__push_files" -p "open a PR"

# hard-deny a whole tool (deny beats any allow rule and any mode)
aet --disallowed-tools "Bash" -p "no shell access in this run"
```

Note: `*` as a deny rule matches **everything** (deny is evaluated first), so pair it with a carefully chosen allow list — or use a permission mode instead.

## Allow / deny rule examples

Rule syntax is shared with [permissions.md](permissions.md); the short version for tools:

```bash
aet --allowed-tools "Bash(git:*),Bash(npm test),Edit(src/**),WebFetch(domain:github.com),Task(qa-engineer)" \
    -p "green refactor of src/parser"
```

| Rule | Matches |
|---|---|
| `Read` | any `Read` call |
| `Bash` | any shell command |
| `Bash(git:*)` | commands starting with `git` |
| `Bash(npm test)` | exactly `npm test` (or `npm test …`) |
| `Edit(src/**)` | edits to files under `src/` |
| `Write(/home/me/x.ts)` | writes to that exact path |
| `WebFetch(domain:github.com)` | github.com and its subdomains |
| `Task(qa-engineer)` | delegation to the `qa-engineer` role |
| `mcp__filesystem__read_file` | that MCP tool |
| `*` | every tool (qualifier-free) |

Persist rules with `aet config set allowedTools "Bash(git:*),Edit(src/**)"` or in `.aet/config.json`; the approval UI's `a` (always allow) writes the suggested rule for you.

## Tool loop limits

- `maxTurns` (default `60`) caps tool iterations per user turn — `--max-turns <n>`.
- `maxTokens` (default `32000`) caps output per request — `--max-tokens <n>`.
- `autoCompact` (default `0.8` of `contextWindow`) triggers context compaction; watch it with `/context`.
- `Bash` timeouts: 120s default, 600s max; use `run_in_background` for longer jobs.

## Related

- [permissions.md](permissions.md) — modes, rule grammar, approval UI
- [agents.md](agents.md) — roles and subagents used by `Task`
- [mcp.md](mcp.md) — adding MCP servers
- [configuration.md](configuration.md) — `allowedTools` / `disallowedTools` / `maxTurns`

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
