# Agents

`aet` ships with a built-in **AI Engineering Team** of eleven roles. Any role can drive a session, run as a subagent via the `Task` tool, or act as a specialist inside the `aet team` pipeline.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Built-in roles

List them at any time with `aet agents` (or `/agents` in the REPL):

| Role | Emoji | Description |
|---|---|---|
| `general` | ❓ | Default hands-on agent for everyday coding tasks |
| `tech-lead` | 💡 | Plans work, breaks goals into tasks, delegates to specialists |
| `architect` | 🏗️ | System design, trade-offs, module and API structure |
| `backend-engineer` | 🔧 | APIs, services, data models, background jobs |
| `frontend-engineer` | 🎨 | UI components, state, accessibility, performance |
| `ai-engineer` | 🤖 | LLM features, agents, tool schemas, RAG, evals |
| `qa-engineer` | 🧪 | Tests, bug reproduction, edge-case hunting |
| `reviewer` | 🔍 | Strict code review with file:line findings |
| `devops-engineer` | 🚀 | CI/CD, Docker, IaC, releases, environments |
| `researcher` | 📚 | Docs, libraries and codebase reconnaissance |
| `documentation-engineer` | ✏️ | READMEs, API references, guides, changelogs |

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

### What each role is optimised for

- **general** — reads before writing, makes the smallest change that satisfies the request, verifies with build/tests, references files as `path:line`.
- **tech-lead** — decides, delegates and integrates; when asked to plan, outputs a numbered task list with role assignments, dependencies, risks and a definition of done. This is the role behind `aet team`'s planning step.
- **architect** — boundaries, data flow, contracts, failure modes, scaling, migration paths; argues 2–3 options then recommends one, and produces concrete file/module layouts and schemas.
- **backend-engineer** — APIs, services, data models, background jobs; matches the repository's framework, validates inputs at the boundary, keeps functions small, updates tests with behaviour changes.
- **frontend-engineer** — accessible, responsive, fast UIs; handles loading/empty/error/success states for every data surface and verifies with the repo's lint/typecheck/build commands.
- **ai-engineer** — prompts, tool schemas, agent loops, RAG, evaluations, observability; treats prompts as code and prefers eval-driven development.
- **qa-engineer** — reads the diff first, targets the riskiest paths, writes/runs tests, reports *what / where / steps to reproduce / expected vs actual / severity*; never weakens a test to make it pass.
- **reviewer** — staff-engineer review: correctness, edge cases, security, performance, error handling, API compatibility, coverage, consistency. Output: summary → blockers (file:line + why + fix) → suggestions → **APPROVE** or **REQUEST CHANGES**.
- **devops-engineer** — CI/CD, Docker, IaC, observability, releases; declarative config in the repo, no committed secrets, fast incremental pipelines, documented env vars.
- **researcher** — facts before code; every claim grounded in a file path + line, URL or command output, with facts separated from assumptions.
- **documentation-engineer** — READMEs, API references, guides, changelogs; leads with what it is and how to run it in 30 seconds, uses real runnable examples, never invents APIs.

## Selecting a role

| Where | How |
|---|---|
| CLI (one run) | `aet --agent qa-engineer "find bugs in src/graph"` (short form `-a`) |
| CLI (config) | `"agent": "reviewer"` in `.aet/config.json`, or `AET_AGENT=reviewer`, or `aet config set agent reviewer` |
| REPL (persist for session) | `/agent <name>` — `/agents` lists them with a `▸` marker on the active one |
| REPL (one prompt) | `@<name> <prompt>` e.g. `@reviewer check my last change` |
| Subagent (inside a run) | the `Task` tool with `subagent_type: <name>` |
| Custom command | `agent: <name>` in a `.aet/commands/*.md` frontmatter |

Unknown role names fall back to `general`, and role names are matched case-insensitively.

## Custom agents — `.aet/agents/*.md`

Add project agents in `.aet/agents/` and/or global agents in `~/.aet/agents/` (relocate the home with `AET_HOME`). Every `*.md` file is loaded; project files are applied after global files, and a `name` that matches a built-in **replaces** the built-in (later files win).

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
- Keep transactions small and update tests alongside schema changes.
```

### Frontmatter fields (all supported keys)

| Field | Type | Required | Behaviour |
|---|---|---|---|
| `name` | string | no | Role id used by `--agent`, `/agent`, `@name` and `Task`. Defaults to the file name without `.md`. Lower-cased. |
| `description` | string | no | Shown by `aet agents` / `/agents`. Defaults to the first line of the body (truncated to 120 chars). |
| `tools` | comma-separated list | no | Restricts the tool set for this role, e.g. `tools: Read, Grep, Glob, Bash, Edit`. Omit for **all** registered tools. |
| `model` | string | no | Model override for this role (takes precedence over the run's `--model`). |
| `permissionMode` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` | no | Permission policy for this role; otherwise the session's mode applies. |
| `emoji` | string | no | Status-line glyph. Defaults to `⚙️`. |

Everything after the closing `---` is the **system prompt** for the role. If the file has no frontmatter, the whole file is used as the prompt. A file with an empty body is ignored.

The frontmatter parser is deliberately simple: `key: value` lines, optional single/double quotes around the value, and no nested structures — keep values flat.

### `aet init` sample

`aet init` writes a starting point you can copy:

```markdown
---
name: backend-expert
description: Domain-specific backend role for this repository
tools: Read, Glob, Grep, LS, Bash, Edit, Write, MultiEdit, TodoWrite
model:
permissionMode: acceptEdits
---
You are the backend specialist for THIS repository.

- Learn the framework and patterns already in use before writing code.
- Validate inputs, handle errors explicitly, and keep handlers thin.
- Update tests alongside implementation changes.
```

### How a role is injected

The active role's description and system prompt are embedded in the system prompt as your team role, alongside workspace instructions (`AET.md` / `AGENTS.md` / `CLAUDE.md`) and any `--append-system-prompt` text. Restricting `tools` limits what the model can call; permissions still apply on top (see [permissions.md](permissions.md)).

## The `Task` tool (subagents)

Any role can hand off self-contained work to a specialist with fresh context:

```json
{
  "description": "Write parser tests",
  "prompt": "Add unit tests for parseArgs in test/args.test.ts covering quoted strings and --flag=value. Report files touched and how you verified.",
  "subagent_type": "qa-engineer",
  "model": "claude-haiku-4-5"
}
```

- `description`, `prompt` and `subagent_type` are required; `model` is optional.
- The subagent runs its own tool loop and returns its final report to the caller.
- Delegation is a permission-gated action (`Task`), so it is prompted for in `default` mode and denied in `plan` mode unless allow-listed (e.g. `allowedTools: ["Task"]`, which is in the defaults).
- Subagent permission prompts are tagged `- subagent` in the approval UI.

## The team pipeline — `aet team "<goal>"`

```bash
aet team "ship a REST API with tests and CI"
aet team "explain and document the auth flow" --plan-only
aet team "migrate the user table" --max-parallel 2 --model claude-opus-4-6
```

1. **Plan (tech-lead).** A tech-lead prompt asks for a strict JSON plan: `summary` plus 1–8 tasks (3–5 preferred) with `id`, `title`, self-contained `description`, a `role` from the list above, and `dependsOn` ids. Dangling dependencies are dropped; a plan with no executable tasks is an error.
2. **Delegate (specialists).** Tasks run with dependency-aware scheduling and bounded parallelism — `--max-parallel <n>` (default 3). Each specialist starts fresh with the team goal, the tech lead's approach and the output of any completed upstream tasks, then reports what it changed, why, how it was verified and what the next task must know.
3. **Review (`reviewer`).** The reviewer inspects the *actual* workspace changes (git diff, modified files) and returns: verdict → remaining risks → prioritised follow-ups.
4. **Report.** Markdown report with approach, per-task ✅/❌ status and durations, the review, plus cost, total duration and the session id.

Flags: `--plan-only` (stop after the plan), `--max-parallel <n>`, `--model <id>` (all roles), plus every global flag. In the REPL use `/team <goal>`.

Progress is logged to stderr, so stdout stays clean:

```
 → tech-lead: planning…
 → backend-engineer: add /api/users rate limiter
 ✓ backend-engineer: add /api/users rate limiter (12s)
 → reviewer: inspecting the work…
```

Failure handling: if the plan cannot be parsed as JSON the run stops with `stopReason: "error"` and the raw summary is kept; if a task fails, the report marks it ❌ and the reviewer still runs on whatever was produced. `Ctrl+C` aborts cleanly (`aborted`).

## Related

- [configuration.md](configuration.md) — the `agent` key and `AET_AGENT`
- [permissions.md](permissions.md) — `permissionMode` per role, `Task` rules
- [tools.md](tools.md) — the toolset available to every role
- [providers.md](providers.md) — per-role `model` overrides

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
