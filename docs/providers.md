# Providers

`aet` is provider-agnostic: one agent loop, seven backends. Pick them with `--provider`, credentials come from environment variables first and `~/.aet/auth.json` second.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Provider table

| Provider id | API key env var | Base URL override | Default endpoint | Auth via `aet auth login` | Notes |
|---|---|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | ✅ | Native Messages API (`/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`), SSE streaming |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | ✅ | Chat Completions (`/chat/completions`), usage in stream |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | ✅ | OpenAI-compatible aggregator, usage in stream |
| `groq` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | ✅ | OpenAI-compatible |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | ✅ | OpenAI-compatible |
| `ollama` | `OLLAMA_API_KEY` (optional) | `OLLAMA_HOST` | `http://127.0.0.1:11434` | ➖ (local, no key needed) | Local `/api/chat`, NDJSON streaming |
| `mock` | — | — | — | ➖ (offline) | Deterministic scripted provider for tests/demos |

All HTTP is native `fetch` — no SDK, no runtime dependency.

## Choosing a provider and model

```bash
aet --provider anthropic --model claude-sonnet-4-5 "do the thing"
aet --model gpt-5.1                                  # provider inferred from the model id
aet --model openrouter/deepseek/deepseek-chat        # slash prefix selects the provider
aet --model anthropic:claude-haiku-4-5               # colon prefix also works
aet --provider ollama --model qwen2.5-coder:7b "review this diff"
aet --provider mock "offline demo"
```

Resolution order:

1. `--provider` (or `AET_PROVIDER` / config `provider`) — explicit wins
2. Model-id prefix — `openrouter/...`, `anthropic:...` etc. (the prefix is stripped and the rest is the model id)
3. Inference from the model id: `claude*` → anthropic, `gpt|o<number>|codex|chatgpt*` → openai, `openrouter/` or an id containing `:` → openrouter, `mock*` → mock, `OLLAMA_HOST` set or `ollama` in the id → ollama, `OPENAI_API_KEY` set without `ANTHROPIC_API_KEY` → openai, otherwise anthropic
4. Config `provider` / `model` defaults

Environment equivalents: `AET_PROVIDER=mock`, `AET_MODEL=gpt-5.1`, or `aet config set provider openrouter`.

## Credentials

```bash
aet auth status            # which providers have a key and where it came from
aet auth login anthropic   # key from AET_ANTHROPIC_API_KEY if set, otherwise read from stdin
aet auth logout anthropic  # remove the stored key
```

```bash
# non-interactive: pipe the key (env-var form also works)
printf '%s' "$OPENAI_KEY" | aet auth login openai
AET_OPENAI_API_KEY="$OPENAI_KEY" aet auth login openai
```

```
$ aet auth status

Credentials (env wins over ~/.aet/auth.json)

  ✓ anthropic    env a1b2c3••••••
  ○ openai       not configured
  ○ openrouter   not configured
  ○ groq         not configured
  ○ deepseek     not configured

aet auth login <provider> · aet auth logout <provider>
```

- **Environment always wins**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`.
- Keys stored by `auth login` live in `~/.aet/auth.json` (relocate with `AET_HOME`) with a `createdAt` stamp; `auth status` shows the source (`env` or `auth`) and a masked key.
- `auth login` accepts `AET_ANTHROPIC_API_KEY`, `AET_OPENAI_API_KEY`, `AET_OPENROUTER_API_KEY`, `AET_GROQ_API_KEY`, `AET_DEEPSEEK_API_KEY` as a non-interactive way to pass the value, e.g. `AET_DEEPSEEK_API_KEY="$KEY" aet auth login deepseek`; otherwise the key is read from stdin.
- Supported for `login`/`logout`: `anthropic`, `openai`, `openrouter`, `groq`, `deepseek`.
- Per-provider `baseUrl` can also be stored next to the key in `auth.json` (`{ "apiKey": "...", "baseUrl": "https://..." }`); otherwise the `*_BASE_URL` env var applies.

If a key is missing, the run stops with an actionable error:

```
No API key found for provider "anthropic".
  - set the env var (ANTHROPIC_API_KEY), or
  - run `aet auth login anthropic`, or
  - use `--provider mock` for an offline/demo run.
```

### `aet doctor`

`aet doctor` reports credentials, resolves the provider/model pair, and probes reachability (it skips the network probe for `mock`):

```
✓ API credentials          anthropic (env)
✓ Provider resolution      anthropic / claude-sonnet-4-5
✓ Provider reachability    200 in 214ms
```

## Models

The built-in registry supplies context windows, output limits and pricing used for cost estimates (`cost_usd` in `--output-format json`, `/cost` in the REPL). Unknown model ids still work — they fall back to 200k context / 32k output / $3 per M input / $15 per M output.

| Model id | Provider | Context | Max output | Input $/M | Output $/M |
|---|---|---|---|---|---|
| `claude-sonnet-4-5` | anthropic | 200,000 | 64,000 | 3.00 | 15.00 |
| `claude-sonnet-4-6` | anthropic | 200,000 | 64,000 | 3.00 | 15.00 |
| `claude-opus-4-5` | anthropic | 200,000 | 32,000 | 5.00 | 25.00 |
| `claude-opus-4-6` | anthropic | 200,000 | 32,000 | 5.00 | 25.00 |
| `claude-haiku-4-5` | anthropic | 200,000 | 16,000 | 1.00 | 5.00 |
| `claude-3-5-haiku-latest` | anthropic | 200,000 | 8,000 | 0.80 | 4.00 |
| `gpt-5.6-terra` | openai | 400,000 | 32,000 | 1.25 | 10.00 |
| `gpt-5.1` | openai | 400,000 | 32,000 | 1.25 | 10.00 |
| `gpt-4.1` | openai | 1,047,576 | 32,768 | 2.00 | 8.00 |
| `gpt-4.1-mini` | openai | 1,047,576 | 32,768 | 0.40 | 1.60 |
| `o4-mini` | openai | 200,000 | 100,000 | 1.10 | 4.40 |
| `deepseek-chat` | openrouter | 131,072 | 8,192 | 0.27 | 1.10 |
| `qwen2.5-coder:7b` | ollama | 32,768 | 8,192 | 0 | 0 |
| `llama3.1:8b` | ollama | 131,072 | 8,192 | 0 | 0 |
| `mock` | mock | 100,000 | 4,000 | 0 | 0 |

Cache reads bill at 10% and cache writes at 125% of the input rate. In the REPL, `/model` lists every model with its provider and context window:

```
current: claude-sonnet-4-5
available:
  claude-sonnet-4-5             anthropic · 200000 ctx
  gpt-5.1                       openai · 400000 ctx
  …
use /model <id> or --model <id>
```

Per-agent overrides: set `model:` in an agent's frontmatter (see [agents.md](agents.md)); `aet team --model <id>` overrides the model for every pipeline role.

## Ollama (local, no key)

```bash
# 1. start ollama and pull a tool-capable model
ollama pull qwen2.5-coder:7b

# 2. point aet at it (defaults to http://127.0.0.1:11434)
aet --provider ollama --model qwen2.5-coder:7b "explain this module"

# non-default host/port
OLLAMA_HOST=http://192.168.1.20:11434 aet --provider ollama --model llama3.1:8b -p "hi"
```

Ollama never requires a key: credentials resolve to `OLLAMA_API_KEY` if set, otherwise none, and the provider is always considered usable. Requests go to `<OLLAMA_HOST>/api/chat` with NDJSON streaming. If `OLLAMA_HOST` is exported, a bare model id can also infer `ollama`.

## Mock provider (offline)

`--provider mock` runs the entire agentic loop — tools, permissions, sessions, team pipeline — with **no key and no network**. It is what the test-suite and `aet doctor` use.

```bash
export AET_HOME=/tmp/aet-home                      # keep your real ~/.aet untouched
aet --provider mock "offline demo run"
aet -p --output-format json --provider mock "create hello.txt"
aet team "demo goal" --plan-only --provider mock --dangerously-skip-permissions
```

Drive it with a script via `AET_MOCK_SCRIPT=/path/to/script.json` — a JSON array of steps, consumed one per model request:

```json
[
  { "text": "I will create the file." },
  { "toolCalls": [{ "name": "Write", "input": { "file_path": "a.txt", "content": "hi" } }] },
  { "text": "Done." }
]
```

| Step field | Meaning |
|---|---|
| `text` | Assistant text (emitted word-by-word so streaming UIs are exercised) |
| `toolCalls[].name` / `toolCalls[].input` | A tool call the agent will execute |
| `stopReason` | Optional override (`tool_use`, `end_turn`, `max_tokens`, `error`) |
| `usage` | Optional `inputTokens` / `outputTokens` (otherwise estimated: input ≈ chars/4, output ≈ text length/4) |

Once the script is exhausted, the mock echoes `[mock] <last user prompt>` and ends the turn. Without `AET_MOCK_SCRIPT` that fallback is all you get. Costs are still computed from the model id's registry price (e.g. `claude-sonnet-4-5` prices), which is handy for testing cost reporting.

## Flags & environment summary

| Flag | Env | Config key |
|---|---|---|
| `--provider <id>` | `AET_PROVIDER` | `provider` |
| `--model <id>` | `AET_MODEL` | `model` |
| `--temperature <t>` | `AET_TEMPERATURE` | `temperature` |
| `--max-tokens <n>` | `AET_MAX_TOKENS` | `maxTokens` |
| — | `AET_MOCK_SCRIPT` | — |
| — | `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, `GROQ_BASE_URL`, `DEEPSEEK_BASE_URL`, `OLLAMA_HOST` | — (or `baseUrl` in `auth.json`) |

Precedence and the full key list: [configuration.md](configuration.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No API key found for provider "…"` | Export the matching env var or run `aet auth login <provider>`; or use `--provider mock` |
| Wrong backend selected | Pass `--provider` explicitly — inference from model ids is best-effort |
| `Provider reachability` fails in `aet doctor` | Check the base URL override, proxy/VPN and provider status page |
| Proxy/gateway needed | Set the `*_BASE_URL` env var to your gateway (it must expose the same API shape) |
| Costs look wrong | Costs come from the model registry; unknown ids use the default $3/$15 pricing |
| Want a fully offline run | `--provider mock` plus `AET_MOCK_SCRIPT`, ideally with `AET_HOME=/tmp/aet-home` |

## Related

- [configuration.md](configuration.md) — precedence of flags/env/config
- [agents.md](agents.md) — per-role model overrides
- [mcp.md](mcp.md) — MCP servers are independent of the LLM provider

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
