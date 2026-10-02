/** MCP server configuration files (~/.aet/mcp.json and .aet/mcp.json). */

import * as path from "node:path";
import { readTextFile, writeTextFileAtomic } from "../util/fsx.js";
import { getPaths, projectPaths } from "../core/paths.js";
import type { McpServerConfig } from "../core/config.js";

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export async function readMcpFile(filePath: string): Promise<McpConfigFile> {
  const contents = await readTextFile(filePath);
  if (!contents) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(contents) as Partial<McpConfigFile>;
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
}

export async function writeMcpFile(filePath: string, data: McpConfigFile): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** Merge global + project MCP config files (project wins). */
export async function loadMcpServers(cwd: string): Promise<Record<string, McpServerConfig>> {
  const global = await readMcpFile(getPaths().globalMcpConfig);
  const project = await readMcpFile(projectPaths(cwd).mcpConfig);
  return { ...global.mcpServers, ...project.mcpServers };
}

export type McpScope = "project" | "global";

export function mcpFileFor(cwd: string, scope: McpScope): string {
  return scope === "global" ? getPaths().globalMcpConfig : projectPaths(cwd).mcpConfig;
}

export async function saveMcpServer(cwd: string, scope: McpScope, name: string, server: McpServerConfig): Promise<string> {
  const file = mcpFileFor(cwd, scope);
  const data = await readMcpFile(file);
  data.mcpServers[name] = server;
  await writeMcpFile(file, data);
  return file;
}

export async function removeMcpServer(cwd: string, name: string): Promise<string | null> {
  for (const scope of ["project", "global"] as McpScope[]) {
    const file = mcpFileFor(cwd, scope);
    const data = await readMcpFile(file);
    if (data.mcpServers[name]) {
      delete data.mcpServers[name];
      await writeMcpFile(file, data);
      return file;
    }
  }
  return null;
}
