/** Well-known filesystem locations for global and project-level state. */

import * as os from "node:os";
import * as path from "node:path";

export interface AetPaths {
  /** `~/.aet` - global home for all CLI state. */
  home: string;
  /** `~/.aet/config.json` - user configuration. */
  userConfig: string;
  /** `~/.aet/auth.json` - stored API credentials. */
  authFile: string;
  /** `~/.aet/sessions` - session transcripts. */
  sessionsDir: string;
  /** `~/.aet/commands` - global custom slash commands. */
  globalCommandsDir: string;
  /** `~/.aet/agents` - global custom agents. */
  globalAgentsDir: string;
  /** `~/.aet/mcp.json` - global MCP server registry. */
  globalMcpConfig: string;
  /** `~/.aet/history` - REPL prompt history. */
  historyFile: string;
  /** `~/.aet/logs` - debug logs. */
  logsDir: string;
}

export function homeDir(): string {
  return process.env.AET_HOME?.trim() || path.join(os.homedir(), ".aet");
}

export function getPaths(): AetPaths {
  const home = homeDir();
  return {
    home,
    userConfig: path.join(home, "config.json"),
    authFile: path.join(home, "auth.json"),
    sessionsDir: path.join(home, "sessions"),
    globalCommandsDir: path.join(home, "commands"),
    globalAgentsDir: path.join(home, "agents"),
    globalMcpConfig: path.join(home, "mcp.json"),
    historyFile: path.join(home, "history"),
    logsDir: path.join(home, "logs"),
  };
}

/** Project-level `.aet` directory inside `cwd`. */
export function projectDir(cwd: string): string {
  return path.join(cwd, ".aet");
}

export function projectPaths(cwd: string): {
  dir: string;
  config: string;
  agentsDir: string;
  commandsDir: string;
  mcpConfig: string;
  instructions: string[];
} {
  const dir = projectDir(cwd);
  return {
    dir,
    config: path.join(dir, "config.json"),
    agentsDir: path.join(dir, "agents"),
    commandsDir: path.join(dir, "commands"),
    mcpConfig: path.join(dir, "mcp.json"),
    // Instruction files searched at project root (Claude Code / Codex compatible).
    instructions: [
      path.join(cwd, "AET.md"),
      path.join(cwd, "AGENTS.md"),
      path.join(cwd, "CLAUDE.md"),
      path.join(dir, "AGENTS.md"),
    ],
  };
}
