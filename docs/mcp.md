# MCP servers

The Model Context Protocol (MCP) lets `aet` use external tool servers — filesystem access, GitHub, databases, browsers, internal APIs — without adding code to the CLI. `aet` speaks both standard transports: **stdio** (newline-delimited JSON-RPC over the child process's stdin/stdout) and **Streamable HTTP** (POST JSON-RPC with a JSON or SSE response), protocol version `2025-06-18`.

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Repo: <https://github.com/faizcasm/ai-engineering-team> · License: MIT

## Add a server

### stdio (local command)

Everything after `--` is the server command:

```bash
aet mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .

added filesystem → /path/to/project/.aet/mcp.json
verify with: aet mcp ping filesystem
```

```bash
# environment variables for the child process
aet mcp add github --env GITHUB_TOKEN=ghp_xxx -- gh mcp

# global scope: written to ~/.aet/mcp.json instead of .aet/mcp.json
aet mcp add postgres --global -- npx -y @modelcontextprotocol/server-postgres postgresql://localhost/app
```

### HTTP (remote URL)

```bash
aet mcp add github --url https://mcp.github.com/mcp --env GITHUB_TOKEN=ghp_xxx

added github → /path/to/project/.aet/mcp.json
verify with: aet mcp ping github
```

For HTTP servers, `--env K=V,K2=V2` values become request **headers**; for stdio servers they become the child process's **environment** (merged over yours).

## Inspect, test, remove

```bash
aet mcp list     # configured servers (project + global)
aet mcp ping     # health-check every server
aet mcp ping filesystem
aet mcp remove github      # also: aet mcp rm github
```

```
$ aet mcp list

MCP servers (2)

  filesystem
    npx -y @modelcontextprotocol/server-filesystem .
  github
    http https://mcp.github.com/mcp

config: .aet/mcp.json · aet mcp ping to test
```

```
$ aet mcp ping

  ✓ filesystem         412ms · 11 tools
  ✗ github             github: HTTP 401 Unauthorized …
```

`ping` exits non-zero if any server fails. It connects, sends `ping`, and lists tools — each step with an **8 second** timeout, so a first run that still has to download a package can time out (see [Troubleshooting](#troubleshooting)).

In the REPL: `/mcp` lists servers, `/mcp ping` health-checks them. `aet doctor` also pings every configured server and shows latency plus tool counts:

```
✓ MCP filesystem           412ms · 11 tools
```

## Where servers are stored

| File | Scope |
|---|---|
| `<cwd>/.aet/mcp.json` | Project — checked into the repo, shared with the team |
| `~/.aet/mcp.json` | Global (`--global`), available in every project |

Both are merged at load time with the **project entry winning** on a name clash. The file format:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "SOME_TOKEN": "…" },
      "enabled": true
    },
    "github": {
      "url": "https://mcp.github.com/mcp",
      "headers": { "GITHUB_TOKEN": "ghp_xxx" },
      "enabled": true
    }
  }
}
```

| Field | Applies to | Meaning |
|---|---|---|
| `command` | stdio | Executable to spawn (no shell) |
| `args` | stdio | Arguments array |
| `env` | stdio | Extra environment variables for the child |
| `url` | http | Endpoint URL (its presence selects HTTP transport) |
| `headers` | http | Extra request headers |
| `enabled` | both | `false` = skip the server (shown as `[disabled]` in `aet mcp list`) |
| `timeoutMs` | both | Connection/handshake timeout in ms (default 10000). Per-request I/O timeout stays at 30s |

You can also declare servers inline in config as `mcpServers` (`.aet/config.json` / `~/.aet/config.json`); those entries are merged **on top** of the `mcp.json` files. Config keys and precedence: [configuration.md](configuration.md).

Master switches: `"mcpEnabled": false` in config, or `AET_MCP=0` in the environment — MCP is then skipped entirely (`aet tools` will show no servers).

## Using the tools

Once a session starts, every server tool is registered alongside the built-ins as:

```
mcp__<server>__<tool>
```

```
$ aet tools

Tools (13) - available to every agent
  …
MCP servers (1) - tools appear as mcp__<server>__<tool>

  filesystem     npx -y @modelcontextprotocol/server-filesystem .
```

- The tool description gets a `(server: <name>)` suffix; progress output shows `server/tool`.
- Calls may run up to **120 seconds**; connections time out after **15 seconds**.
- If a server fails to start, the session continues with a warning (`MCP server "x" failed: …`) instead of aborting — with `--verbose` you also get `MCP server "x" ready (N tools)`.
- Image/resource content is summarised into text (e.g. `[image image/png - 12345 bytes]`), so model output stays text-only.

### Permissions

MCP tools are not read-only, and rules match the **exact** tool name (no wildcards inside a rule's tool position):

```bash
# allow exactly these tools
aet --allowed-tools "mcp__filesystem__read_file,mcp__filesystem__list_directory" -p "what is in ./docs?"

# hard-deny specific capabilities (deny beats every allow rule and mode)
aet --disallowed-tools "mcp__github__create_or_update_file,mcp__github__push_files" -p "open a PR"

# deny the shell but keep MCP
aet --disallowed-tools "Bash" -p "work through MCP only"
```

In `plan` mode MCP tools fall through to the approval prompt (auto-denied when non-interactive); in `bypassPermissions` they run without asking. Full rule grammar: [permissions.md](permissions.md).

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `ping` fails the first time, then works | `npx` is still downloading the package. Run `npx -y <package>` once yourself (or install it globally), then `aet mcp ping` again — ping only allows 8s per step. |
| `ENOENT` / `failed to start` | The `command` is not on `PATH` for `aet`. Use an absolute path (e.g. `command: /usr/local/bin/npx`) or install the server. |
| `exited with code N` | The server crashed on startup — run its command manually in your shell to see its stderr (the client keeps the last ~4000 chars of stderr for diagnostics). |
| HTTP `401/403` | Check the `--env K=V` values: for `--url` servers they are sent as headers (e.g. `Authorization=Bearer …`). |
| `initialize … timed out after 15000ms` | The server is slow to boot or the endpoint is wrong. Verify the URL, then `aet mcp ping <name>`. |
| Tools missing in a run | `aet tools` lists the servers; if a server is `[disabled]` set `"enabled": true`. Check `mcpEnabled` / `AET_MCP`. |
| Session start feels slow | Every enabled server is connected serially at start-up — disable servers you are not using (`"enabled": false`). |
| Need to start clean | `aet mcp remove <name>` (checks project first, then global) or edit the `mcp.json` file directly. |

## Related

- [tools.md](tools.md) — tool registration and rule matching
- [permissions.md](permissions.md) — allow/deny rules for `mcp__…` tools
- [configuration.md](configuration.md) — `mcpEnabled`, `mcpServers`, `AET_MCP`

---

**Author: Faizan Hameed (https://faizcasm.me) — Founder of Ryuksaidso** · Copyright (c) 2026 Faizan Hameed · [MIT License](../LICENSE)
