import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import logger from "../config/logger.config.js";
import AppError from "./AppError.js";

import { createMcpServerSchema } from "../validations/mcp.validation.js";
import type { CreateMcpServerInput } from "../validations/mcp.validation.js";

/* =====================================================
   TYPES
===================================================== */

export type McpTransport = "stdio" | "sse" | "http";

export type McpSource = "config" | "memory";

export type McpPingStatus =
  | "online"
  | "offline"
  | "disabled";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  source: McpSource;
  createdAt: string;
  updatedAt: string;
}

export interface McpPingResult {
  id: string;
  name: string;
  status: McpPingStatus;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  detail: string;
  checkedAt: string;
}

export type McpServerView = McpServer & {
  env?: Record<string, string>;
  lastPing: McpPingResult | null;
};

/* =====================================================
   STORE
===================================================== */

const REDACTED = "***";

const memoryServers = new Map<string, McpServer>();
const pings = new Map<string, McpPingResult>();

let configServers: McpServer[] = [];
let configLoaded = false;

const configEntrySchema = z.object({
  name: z.string().max(60).optional(),
  transport: z.enum(["stdio", "sse", "http"]).optional(),
  command: z.string().max(300).optional(),
  args: z.array(z.string().max(300)).max(50).optional(),
  url: z.string().max(500).optional(),
  env: z.record(z.string(), z.string().max(2000)).optional(),
  enabled: z.boolean().optional(),
});

/* =====================================================
   CONFIG LOADING
===================================================== */

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "server"
  );
}

function fromMap(
  map: Record<string, unknown>
): Array<Record<string, unknown>> {
  return Object.entries(map).map(([name, value]) => ({
    ...(typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}),

    name,
  }));
}

function extractEntries(
  parsed: unknown
): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null
    );
  }

  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;

    if (
      record.mcpServers &&
      typeof record.mcpServers === "object"
    ) {
      return fromMap(
        record.mcpServers as Record<string, unknown>
      );
    }

    if (
      record.command ||
      record.url ||
      record.transport
    ) {
      return [record];
    }

    return fromMap(record);
  }

  return [];
}

function inferTransport(
  entry: Record<string, unknown>
): "stdio" | "sse" | "http" | undefined {
  if (typeof entry.transport === "string") {
    return entry.transport as McpTransport;
  }

  if (typeof entry.command === "string") {
    return "stdio";
  }

  if (typeof entry.url === "string") {
    return "http";
  }

  return undefined;
}

function buildConfigServers(
  entries: Array<Record<string, unknown>>,
  source: string
): McpServer[] {
  const servers: McpServer[] = [];

  entries.forEach((entry, index) => {
    const parsed = configEntrySchema.safeParse(entry);

    if (!parsed.success) {
      logger.warn("Ignoring invalid MCP config entry", {
        source,
        index,
        issues: parsed.error.issues,
      });

      return;
    }

    const value = parsed.data;
    const name =
      value.name || `server-${index + 1}`;

    const transport =
      value.transport || inferTransport(entry);

    const validated = createMcpServerSchema.safeParse({
      name,
      transport,
      command: value.command,
      args: value.args,
      url: value.url,
      env: value.env,
      enabled: value.enabled,
    });

    if (!validated.success) {
      logger.warn("Ignoring invalid MCP config entry", {
        source,
        name,
        issues: validated.error.issues,
      });

      return;
    }

    const id = `cfg-${slugify(name)}-${index}`;

    const now = new Date().toISOString();

    servers.push({
      id,
      name: validated.data.name,
      transport: validated.data.transport,

      ...(validated.data.command && {
        command: validated.data.command,
      }),

      ...(validated.data.args && {
        args: [...validated.data.args],
      }),

      ...(validated.data.url && {
        url: validated.data.url,
      }),

      ...(validated.data.env && {
        env: { ...validated.data.env },
      }),

      enabled: validated.data.enabled ?? true,
      source: "config",
      createdAt: now,
      updatedAt: now,
    });
  });

  return servers;
}

function loadConfigServers(): McpServer[] {
  const collected: McpServer[] = [];

  const rawEnv = process.env.MCP_SERVERS?.trim();

  if (rawEnv) {
    try {
      const parsed = JSON.parse(rawEnv);
      collected.push(
        ...buildConfigServers(extractEntries(parsed), "MCP_SERVERS")
      );
    } catch (error) {
      logger.warn("MCP_SERVERS is not valid JSON", {
        message:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  const configPath = process.env.MCP_CONFIG_PATH?.trim();

  if (configPath) {
    const resolved = path.resolve(configPath);

    try {
      const raw = fs.readFileSync(resolved, "utf8");
      const parsed = JSON.parse(raw);

      collected.push(
        ...buildConfigServers(extractEntries(parsed), resolved)
      );
    } catch (error) {
      logger.warn("Could not load MCP config file", {
        path: resolved,

        message:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  return collected;
}

function ensureLoaded(): void {
  if (configLoaded) {
    return;
  }

  configServers = loadConfigServers();
  configLoaded = true;

  logger.info("MCP server registry loaded", {
    configServers: configServers.length,
    memoryServers: memoryServers.size,
  });
}

/* =====================================================
   QUERIES
===================================================== */

function allServers(): McpServer[] {
  ensureLoaded();

  return [...configServers, ...memoryServers.values()];
}

function toView(server: McpServer): McpServerView {
  return {
    ...server,

    ...(server.env && {
      env: Object.fromEntries(
        Object.keys(server.env).map((key) => [
          key,
          REDACTED,
        ])
      ),
    }),

    args: server.args ? [...server.args] : undefined,
    lastPing: pings.get(server.id) || null,
  };
}

export function listServers(): McpServerView[] {
  return allServers().map(toView);
}

export function getServer(id: string): McpServerView {
  const server = allServers().find(
    (entry) => entry.id === id
  );

  if (!server) {
    throw new AppError("MCP server not found", 404);
  }

  return toView(server);
}

function assertNotConfigBacked(id: string): void {
  ensureLoaded();

  if (configServers.some((server) => server.id === id)) {
    throw new AppError(
      "Config-backed MCP servers cannot be changed at runtime. " +
        "Update MCP_SERVERS or MCP_CONFIG_PATH instead.",
      409
    );
  }
}

/* =====================================================
   MUTATIONS
===================================================== */

export function createServer(
  input: CreateMcpServerInput
): McpServerView {
  ensureLoaded();

  const duplicate = allServers().find(
    (server) => server.name === input.name
  );

  if (duplicate) {
    throw new AppError(
      `MCP server "${input.name}" already exists`,
      409
    );
  }

  const now = new Date().toISOString();

  const server: McpServer = {
    id: randomUUID(),
    name: input.name,
    transport: input.transport,
    enabled: input.enabled ?? true,
    source: "memory",
    createdAt: now,
    updatedAt: now,

    ...(input.command && { command: input.command }),
    ...(input.args && { args: [...input.args] }),
    ...(input.url && { url: input.url }),
    ...(input.env && { env: { ...input.env } }),
  };

  memoryServers.set(server.id, server);

  logger.info("MCP server registered", {
    id: server.id,
    name: server.name,
    transport: server.transport,
  });

  return toView(server);
}

export function deleteServer(id: string): void {
  assertNotConfigBacked(id);

  if (!memoryServers.has(id)) {
    throw new AppError("MCP server not found", 404);
  }

  memoryServers.delete(id);
  pings.delete(id);

  logger.info("MCP server removed", { id });
}

/* =====================================================
   PING
===================================================== */

function pingTimeoutMs(): number {
  const raw = Number(process.env.MCP_PING_TIMEOUT_MS);

  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

async function pingHttp(
  server: McpServer
): Promise<Omit<McpPingResult, "id" | "name" | "checkedAt">> {
  const timeoutMs = pingTimeoutMs();
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(server.url as string, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timer);

    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }

    const ok = response.status < 500;

    return {
      status: ok ? "online" : "offline",
      ok,
      latencyMs: 0,
      httpStatus: response.status,

      detail: ok
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} from ${server.url}`,
    };
  } catch (error) {
    clearTimeout(timer);

    const aborted = controller.signal.aborted;
    const message =
      error instanceof Error ? error.message : String(error);

    return {
      status: "offline",
      ok: false,
      latencyMs: 0,
      httpStatus: null,

      detail: aborted
        ? `Timed out after ${timeoutMs}ms`
        : message,
    };
  }
}

async function pingStdio(
  server: McpServer
): Promise<Omit<McpPingResult, "id" | "name" | "checkedAt">> {
  const command = server.command || "";

  const candidates = command.includes("/")
    ? [path.resolve(command)]
    : (process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));

  for (const candidate of candidates) {
    try {
      await fs.promises.access(
        candidate,
        fs.constants.X_OK
      );

      return {
        status: "online",
        ok: true,
        latencyMs: 0,
        httpStatus: null,
        detail: `Resolved at ${candidate}`,
      };
    } catch {
      // Try the next PATH entry.
    }
  }

  return {
    status: "offline",
    ok: false,
    latencyMs: 0,
    httpStatus: null,
    detail: `Command "${command}" was not found on PATH`,
  };
}

export async function pingServer(
  id: string
): Promise<McpPingResult> {
  const server = getServer(id);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  let result: Omit<
    McpPingResult,
    "id" | "name" | "checkedAt"
  >;

  if (!server.enabled) {
    result = {
      status: "disabled",
      ok: false,
      latencyMs: 0,
      httpStatus: null,
      detail: "Server is disabled",
    };
  } else if (server.transport === "stdio") {
    result = await pingStdio(server);
  } else {
    result = await pingHttp(server);
  }

  const ping: McpPingResult = {
    id: server.id,
    name: server.name,
    checkedAt,
    ...result,
    latencyMs: Date.now() - startedAt,
  };

  pings.set(server.id, ping);

  logger.info("MCP server pinged", {
    id: ping.id,
    status: ping.status,
    latencyMs: ping.latencyMs,
  });

  return ping;
}
