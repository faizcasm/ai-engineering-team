# Permissions

Every tool call is checked before it runs. `aet` starts from a conservative default, lets you widen or narrow it with rules and modes, and always fails **closed** when nobody is watching the terminal.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Evaluation order

For each tool invocation, in this order:

1. **Deny rules** (`disallowedTools`) — first match wins → **deny**
2. **Allow rules** (`allowedTools`) — first match wins → **allow**
3. **Permission mode** — may allow, deny or fall through
4. **Read-only heuristics** — read-only tools and read-only shell commands → **allow**
5. **Ask the user** through the interactive approval prompt — and if the session is non-interactive, → **deny**

Because deny beats allow, a deny rule can always carve an exception out of a permissive allow list or mode.

## Permission modes

| Mode | Edits (`Write`/`Edit`/`MultiEdit`) | Shell | Reads | `Task` / `WebFetch` | MCP tools |
|---|---|---|---|---|---|
| `default` | ask | ask (read-only commands auto-approved) | auto | ask | ask |
| `acceptEdits` | **auto-approved** (`acceptEdits mode`) | ask (read-only commands auto-approved) | auto | ask | ask |
| `plan` | **denied** | **denied** unless read-only | auto | **denied** | ask¹ |
| `bypassPermissions` | auto | auto | auto | auto | auto |

¹ Plan mode's mutating check covers edit tools, non-read-only `Bash`, `Task` and `WebFetch`; MCP tools fall through to the approval prompt, which is auto-denied when non-interactive.

Set a mode with any of:

```bash
aet --permission-mode plan "explain the auth flow"
aet --plan "explain the auth flow"                # shorthand for plan
aet --accept-edits "apply the rename"             # shorthand for acceptEdits
aet --dangerously-skip-permissions "run the migration"   # bypassPermissions
aet config set permissionMode acceptEdits         # persistent default
# in the REPL:
/permissions
/permissions acceptEdits
```

`plan` mode is the safe default for exploration: it answers with
`plan mode is read-only - re-run with --permission-mode default to make changes` for anything that could mutate state.

## Rule syntax

Rules are strings, comma-separated on the command line and array entries in config. The grammar is `Tool` or `Tool(qualifier)`:

```
Read                        any Read call
Bash                        any shell command
Bash(git:*)                 shell commands starting with `git`
Bash(npm test)              exactly `npm test` (and `npm test …`)
Write(/home/me/x.ts)        writes to that path
Edit(src/**)                edits under src/
WebFetch(domain:github.com) that domain and its subdomains
Task(qa-engineer)           delegation to the qa-engineer role
mcp__github__search         an MCP tool (exact name)
*                           every tool
```

Notes on matching:

- A rule **without** a qualifier matches one tool exactly; `*` (no qualifier) matches every tool.
- There is **no** wildcarding of tool names — `Bash*` or `mcp__github__*` will not match. Use the exact tool name (`mcp__filesystem__read_file`) or the `*` rule.
- Rules are matched **before** the mode, so `"disallowedTools": ["Bash"]` blocks the shell even in `bypassPermissions`.

### Qualifiers by tool family

| Family | Qualifier | Matching |
|---|---|---|
| `Bash` | `git:*` | prefix — command equals `git` or starts with `git ` / `git` |
| | `*` | any command |
| | `npm test` | exact command, or the command plus arguments |
| `WebFetch` | `domain:github.com` | hostname equals `github.com` or ends with `.github.com` (`www.` ignored) |
| | a glob | matched against the URL |
| `Task` | `qa-engineer` | exact role, or a glob over the role name |
| `Read` `Write` `Edit` `MultiEdit` `Glob` `Grep` `LS` | `src/**`, `src`, `docs/*.md`, `/abs/path/**` | path glob relative to the workspace (or absolute); a bare directory name matches everything inside it |
| MCP tools | — | use the tool-name position: `mcp__filesystem__read_file` |

Path patterns resolve against the working directory (`--cwd` respected) and also match direct children (`src/**/*`), so `Edit(src/**)` covers `src/a/b.ts` and `src/a.ts`.

## Read-only surface (never prompts)

**Tools:** `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `TaskList`, `BashOutput`, `KillShell`.

**Shell prefixes:** `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `which`, `whoami`, `date`, `uname`, `echo`, `printenv`, `env`, `stat`, `file`, `du`, `df`, `free`, `node -v`, `npm -v`, `git status`, `git log`, `git diff`, `git show`, `git branch`, `git remote -v`, `git config --get`, `git stash list`, `git ls-files`, `git blame`, `git describe`, `grep`, `rg`, `find`, `tree`, `ps`, `hostname`, `id`, `python --version`, `tsc --version`, `tsc --noEmit`, `npx tsc --noEmit`, `lsb_release`, `curl -sI`, `ping -c`.

A chained command counts as read-only only if **every** segment is (`git status && git log` ✓). Commands are disqualified by:

- any output redirection (`>`), history expansion (`!`) or command chaining where a segment is not read-only
- mutating words anywhere in the command: `rm`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `kill`, `write`

So `git status && npm run build > out.log` needs approval, while `git diff -- src` does not.

## Configuration

```bash
aet config set allowedTools "Bash(git:*),Bash(npm test),Edit(src/**)"
aet config set disallowedTools "Bash(rm:*),Bash(sudo:*),WebFetch(domain:example.com)"
aet config get allowedTools
aet config list
```

```json
// .aet/config.json  (project)  or  ~/.aet/config.json  (user)
{
  "permissionMode": "default",
  "allowedTools": ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "BashOutput", "KillShell", "Bash(git:*)"],
  "disallowedTools": ["Bash(rm:*)", "Bash(sudo:*)"]
}
```

| Source | Syntax |
|---|---|
| Config files | JSON arrays of rule strings |
| CLI | `--allowed-tools "Bash(git:*),Edit(src/**)"` and `--disallowed-tools "Bash(rm:*)"` (comma-separated) |
| Environment | `AET_ALLOWED_TOOLS`, `AET_DISALLOWED_TOOLS` (comma-separated) |
| REPL | `/permissions` to inspect, approval prompt `a` to persist an allow rule |

Defaults:

```json
{
  "permissionMode": "default",
  "allowedTools": ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "BashOutput", "KillShell"],
  "disallowedTools": []
}
```

Precedence and the full key list: [configuration.md](configuration.md). Each agent can pin its own `permissionMode` (see [agents.md](agents.md)).

## Interactive approval UI

When a call needs approval, `aet` prints a queued prompt (parallel subagents cannot interleave questions):

```
  ▲ Bash (approval required)
  $ git push origin main
  y allow once   a always allow (Bash(git:*))   n deny
  ? approve? [y/a/N] _
```

| Key | Effect |
|---|---|
| `y` / `yes` | Allow this call only |
| `a` / `always` / `s` | Allow now **and** persist the suggested rule to `allowedTools` in `~/.aet/config.json` |
| `n` / `no` / empty | Deny this call (`user declined`) |
| anything else | Prints `please answer y, a or n` and asks again |
| Ctrl+C | Interrupt the run |

The suggested rule is derived from the request:

| Request | Suggested rule |
|---|---|
| `Bash` | `Bash(<first-word>:*)` → `Bash(git:*)` |
| `WebFetch` | `WebFetch(domain:<host>)` |
| `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`LS` | `<Tool>(<dirname>/**)` — directory-scoped so the whole folder stays editable |
| anything else | the bare tool name |

Prompts originating from a subagent are tagged `- subagent`. If persisting fails, the run still continues and reports `could not persist rule: …`.

## Non-interactive behaviour

Runs with `-p/--print`, piped stdin, or any context without a terminal have no prompt, so anything that would have asked is **denied**:

```
approval required but the session is non-interactive (use --dangerously-skip-permissions,
--permission-mode bypassPermissions, or an allow rule)
```

Ways to make a non-interactive run succeed:

```bash
aet -p --permission-mode bypassPermissions "run the migration"   # or --dangerously-skip-permissions
aet -p --accept-edits "apply the codemod"                        # edits only
aet -p --allowed-tools "Bash(npm test),Bash(npm run build)" "verify CI"
aet -p --permission-mode plan "explain the architecture"         # read-only work needs nothing
```

Other deny reasons you will see in logs and `--verbose` output:

| Reason | Meaning |
|---|---|
| `matched deny rule <rule>` | A `disallowedTools` entry matched |
| `allowed by <rule>` | An `allowedTools` entry matched |
| `plan mode is read-only - re-run with --permission-mode default to make changes` | Plan mode blocked a mutating call |
| `read-only tool` / `read-only shell command` | Auto-approved by the heuristics |
| `user declined` / `terminal not available` | You pressed `n`, or the terminal was gone |
| `non-interactive session` | A gate answered `deny` because nothing could ask |

Exit codes are unaffected by denials themselves: the agent receives the denial and adapts (or reports the failure), and the run exits `1` only when the turn errors.

## Recipes

```bash
# Safe read-only investigation in CI
aet -p --permission-mode plan --output-format json "map the auth flow"

# Hands-off edit run that may still not touch the shell
aet -p --accept-edits "rename the REPORTS constant across src/"

# Let git/npm through, keep asking about everything else
aet --allowed-tools "Bash(git:*),Bash(npm:*),Edit(src/**),Edit(test/**)" "fix the flaky test"

# Lock the agent out of the shell entirely
aet --disallowed-tools "Bash" "refactor without running anything"

# Only filesystem MCP reads
aet --allowed-tools "mcp__filesystem__read_file,mcp__filesystem__list_directory" "summarise ./docs"

# Fully unattended (use only in sandboxed/CI contexts)
aet -p --dangerously-skip-permissions --output-format json "apply the codemod"
```

Persist a project-wide policy in `.aet/config.json` so every teammate and every CI run shares it.

## Related

- [tools.md](tools.md) — which tool is read-only, which is not
- [agents.md](agents.md) — per-role `permissionMode` and `Task` delegation
- [configuration.md](configuration.md) — precedence of flags, env and config files

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
