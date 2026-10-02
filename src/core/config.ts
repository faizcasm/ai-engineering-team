/**
 * Configuration layering.
 *
 * precedence (low -> high):
 *   built-in defaults < ~/.aet/config.json < <cwd>/.aet/config.json < env (AET_*) < CLI flags
 */

import * as path from "node:path";
import { readTextFile, writeTextFileAtomic, pathExists } from "../util/fsx.js";
import { getPaths, projectPaths } from "./paths.js";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

export interface Config {
  model: string;
  provider?: string;
  /** Default agent/role used for turns (see `src/team/agents.ts`). */
  agent: string;
  permissionMode: PermissionMode;
  /** Rules that auto-allow a tool, e.g. `Bash(git:*)`. */
  allowedTools: string[];
  /** Rules that hard-deny a tool. */
  disallowedTools: string[];
  /** Total context window in tokens. */
  contextWindow: number;
  /** Maximum output tokens per request. */
  maxTokens: number;
  /** Maximum agentic tool-loop iterations per user turn. */
  maxTurns: number;
  temperature?: number;
  /** Fraction of the context window that triggers auto-compaction. */
  autoCompact: number;
  /** Model used for compaction summaries (defaults to a fast model). */
  summarizeModel?: string;
  theme: "default" | "mono";
  color: boolean;
  verbose: boolean;
  debug: boolean;
  /** Optional backend (Express service) base URL used by `aet doctor`. */
  backendUrl?: string;
  /** Enable MCP servers listed in config. */
  mcpEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULT_CONFIG: Config = {
  model: "claude-sonnet-4-5",
  agent: "general",
  permissionMode: "default",
  allowedTools: ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "BashOutput", "KillShell"],
  disallowedTools: [],
  contextWindow: 200_000,
  maxTokens: 32_000,
  maxTurns: 60,
  autoCompact: 0.8,
  theme: "default",
  color: true,
  verbose: false,
  debug: false,
  mcpEnabled: true,
  mcpServers: {},
};

type RawConfig = Partial<Config> & { mcpServers?: Record<string, McpServerConfig> };

async function readJsonFile<T>(file: string): Promise<T | null> {
  const contents = await readTextFile(file);
  if (contents === null) return null;
  try {
    return JSON.parse(contents) as T;
  } catch {
    throw new Error(`Invalid JSON in ${file}`);
  }
}

function mergeConfig(base: Config, patch: RawConfig | null): Config {
  if (!patch) return base;
  const merged: Config = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (key === "mcpServers") {
      merged.mcpServers = { ...merged.mcpServers, ...(value as Record<string, McpServerConfig>) };
      continue;
    }
    if (key === "allowedTools" || key === "disallowedTools") {
      (merged as unknown as Record<string, string[]>)[key] = [...(value as string[])];
      continue;
    }
    if (key in DEFAULT_CONFIG || key === "provider" || key === "summarizeModel") {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function envOverrides(): RawConfig {
  const patch: RawConfig = {};
  const env = process.env;
  if (env.AET_MODEL) patch.model = env.AET_MODEL;
  if (env.AET_PROVIDER) patch.provider = env.AET_PROVIDER;
  if (env.AET_AGENT) patch.agent = env.AET_AGENT;
  if (env.AET_PERMISSION_MODE) patch.permissionMode = env.AET_PERMISSION_MODE as PermissionMode;
  if (env.AET_ALLOWED_TOOLS) patch.allowedTools = env.AET_ALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.AET_DISALLOWED_TOOLS) patch.disallowedTools = env.AET_DISALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.AET_MAX_TURNS) patch.maxTurns = Number(env.AET_MAX_TURNS);
  if (env.AET_CONTEXT_WINDOW) patch.contextWindow = Number(env.AET_CONTEXT_WINDOW);
  if (env.AET_MAX_TOKENS) patch.maxTokens = Number(env.AET_MAX_TOKENS);
  if (env.AET_TEMPERATURE) patch.temperature = Number(env.AET_TEMPERATURE);
  if (env.AET_SUMMARIZE_MODEL) patch.summarizeModel = env.AET_SUMMARIZE_MODEL;
  if (env.AET_BACKEND_URL) patch.backendUrl = env.AET_BACKEND_URL;
  if (env.AET_DEBUG) patch.debug = env.AET_DEBUG !== "0" && env.AET_DEBUG !== "false";
  if (env.AET_MCP !== undefined) patch.mcpEnabled = env.AET_MCP !== "0" && env.AET_MCP !== "false";
  if (env.AET_THEME) patch.theme = env.AET_THEME as Config["theme"];
  return patch;
}

export interface LoadConfigOptions {
  cwd: string;
  overrides?: RawConfig;
}

export async function loadConfig(options: LoadConfigOptions): Promise<Config> {
  const { cwd } = options;
  const paths = getPaths();
  const project = projectPaths(cwd);

  let config = mergeConfig(DEFAULT_CONFIG, await readJsonFile<RawConfig>(paths.userConfig));
  config = mergeConfig(config, await readJsonFile<RawConfig>(project.config));
  config = mergeConfig(config, envOverrides());
  config = mergeConfig(config, options.overrides ?? {});

  // CLI flag colour switch is expressed as `color: false` only.
  if (process.env.NO_COLOR && options.overrides?.color === undefined) {
    config.color = false;
  }
  if (!PERMISSION_MODES.includes(config.permissionMode)) {
    throw new Error(
      `Invalid permission mode "${config.permissionMode}". Expected one of: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  return config;
}

/** Persist a partial config into the user-level config file. */
export async function saveUserConfig(patch: RawConfig): Promise<Config> {
  const paths = getPaths();
  const current = (await readJsonFile<RawConfig>(paths.userConfig)) ?? {};
  const next: RawConfig = { ...current, ...patch };
  await writeTextFileAtomic(paths.userConfig, `${JSON.stringify(next, null, 2)}\n`);
  return mergeConfig(DEFAULT_CONFIG, next);
}

export async function readUserConfigRaw(): Promise<RawConfig | null> {
  return readJsonFile<RawConfig>(getPaths().userConfig);
}

/** Dot-path getter used by `aet config get <key>`. */
export function getConfigValue(config: Config, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      /* fall through to string */
    }
  }
  if (value.includes(",")) return value.split(",").map((s) => s.trim()).filter(Boolean);
  return value;
}

/** Resolve the directory containing a user-supplied path, defaulting to cwd. */
export function resolveCwd(cwdFlag?: string): string {
  return path.resolve(cwdFlag ?? process.cwd());
}
