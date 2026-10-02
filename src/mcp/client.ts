/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Supports the two standard transports:
 *   - stdio:  newline-delimited JSON-RPC over stdin/stdout
 *   - http:   Streamable HTTP (POST JSON-RPC, JSON or SSE response)
 *
 * Exposed MCP tools are namespaced as `mcp__<server>__<tool>` so permission
 * rules can target them individually.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { McpServerConfig } from "../core/config.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { asObject, optionalString } from "../tools/types.js";
import { parseSse } from "../providers/http.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(message: string, readonly server: string) {
    super(message);
    this.name = "McpError";
  }
}

type State = "disconnected" | "connecting" | "ready" | "failed";

export class McpClient {
  readonly name: string;
  private readonly config: McpServerConfig;
  private state: State = "disconnected";
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private sessionId?: string;
  private stderrLog = "";

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  get status(): State {
    return this.state;
  }

  get logs(): string {
    return this.stderrLog;
  }

  async connect(timeoutMs?: number): Promise<void> {
    if (this.state === "ready") return;
    const budget = timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.state = "connecting";
    try {
      if (this.config.url) await this.connectHttp(budget);
      else await this.connectStdio(budget);
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      throw error instanceof McpError ? error : new McpError((error as Error).message, this.name);
    }
  }

  /* ------------------------------------------------------------ stdio */

  private async connectStdio(timeoutMs: number): Promise<void> {
    const command = this.config.command;
    if (!command) throw new McpError("stdio server is missing `command`", this.name);

    const env: Record<string, string> = { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>;
    const child = spawn(command, this.config.args ?? [], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdioData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrLog = `${this.stderrLog}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => this.failAll(new McpError(`failed to start: ${error.message}`, this.name)));
    child.on("close", (code) => this.failAll(new McpError(`exited with code ${code}`, this.name)));

    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aet", version: "1.0.0" },
    }, timeoutMs);
    this.notify("notifications/initialized", {});
  }

  private onStdioData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.handleMessage(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return; // notification
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (message.error) {
      entry.reject(new McpError(`${this.name}: ${message.error.message} (code ${message.error.code})`, this.name));
    } else {
      entry.resolve(message.result);
    }
  }

  /* ------------------------------------------------------------- http */

  private async connectHttp(timeoutMs: number): Promise<void> {
    const url = this.config.url;
    if (!url) throw new McpError("http server is missing `url`", this.name);
    const result = await this.httpPost(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "aet", version: "1.0.0" },
        },
      },
      timeoutMs,
    );
    this.handleMessage(JSON.stringify(result));
    this.notify("notifications/initialized", {});
  }

  private async httpPost(message: JsonRpcMessage, timeoutMs: number): Promise<JsonRpcMessage> {
    const url = this.config.url!;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new McpError(`${this.name}: HTTP ${response.status} ${body.slice(0, 200)}`, this.name);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (!response.body) throw new McpError(`${this.name}: empty SSE body`, this.name);
      for await (const payload of parseSse(response.body)) {
        try {
          const parsed = JSON.parse(payload) as JsonRpcMessage;
          if (parsed.id !== undefined && Number(parsed.id) === Number(message.id)) return parsed;
        } catch {
          /* ignore keep-alives */
        }
      }
      throw new McpError(`${this.name}: SSE stream closed without a response`, this.name);
    }
    return (await response.json()) as JsonRpcMessage;
  }

  /* -------------------------------------------------------- rpc helpers */

  private notify(method: string, params: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    if (this.config.url) {
      void this.httpPost(message, DEFAULT_TIMEOUT_MS).catch(() => undefined);
      return;
    }
    this.write(JSON.stringify(message));
  }

  private write(payload: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new McpError(`${this.name}: not connected`, this.name);
    }
    this.child.stdin.write(`${payload}\n`);
  }

  private rpc(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };

    if (this.config.url) {
      return this.httpPost(message, timeoutMs).then((response) => {
        if (response.error) {
          throw new McpError(`${this.name}: ${response.error.message}`, this.name);
        }
        return response.result;
      });
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${this.name}: ${method} timed out after ${timeoutMs}ms`, this.name));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (this.state === "connecting") this.state = "failed";
    else if (this.state === "ready") this.state = "failed";
  }

  /* -------------------------------------------------------------- API */

  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolDescriptor[]> {
    const result = (await this.rpc("tools/list", {}, timeoutMs)) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolResult> {
    const result = (await this.rpc("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    const parts: string[] = [];
    for (const block of result.content ?? []) {
      if (block.type === "text") parts.push(block.text ?? "");
      else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "unknown"} - ${Math.round((block.data?.length ?? 0) * 0.75)} bytes]`);
      else if (block.type === "resource") parts.push(`[resource ${JSON.stringify(block).slice(0, 200)}]`);
      else parts.push(`[${block.type}]`);
    }
    const output = parts.join("\n").trim() || "(no content)";
    return { output, isError: result.isError ?? false, display: `${this.name}/${name}` };
  }

  async ping(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    const startedAt = Date.now();
    await this.rpc("ping", {}, timeoutMs);
    return Date.now() - startedAt;
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new McpError(`${this.name}: client closed`, this.name));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin?.end();
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.state = "disconnected";
  }
}

/** Wrap an MCP tool as a local Tool with `mcp__server__tool` naming. */
export function toLocalTool(serverName: string, descriptor: McpToolDescriptor, client: McpClient): Tool {
  const fullName = `mcp__${serverName}__${descriptor.name}`;
  return {
    spec: {
      name: fullName,
      description: `${descriptor.description || "MCP tool"}\n(server: ${serverName})`,
      inputSchema: descriptor.inputSchema ?? { type: "object", properties: {} },
    },
    async execute(rawInput, ctx): Promise<ToolResult> {
      const input = rawInput === undefined || rawInput === null ? {} : asObject(rawInput);
      ctx.emit({ type: "progress", text: `${fullName}` });
      return client.callTool(descriptor.name, input);
    },
  };
}

export interface McpServerStatus {
  name: string;
  status: State;
  transport: "stdio" | "http";
  tools: number;
  error?: string;
}

export class McpRegistry {
  private readonly clients: McpClient[] = [];
  private tools: Tool[] = [];

  constructor(private readonly servers: Record<string, McpServerConfig>) {}

  async start(): Promise<{ tools: Tool[]; status: McpServerStatus[] }> {
    const status: McpServerStatus[] = [];
    for (const [name, config] of Object.entries(this.servers)) {
      if (config.enabled === false) {
        status.push({ name, status: "disconnected", transport: config.url ? "http" : "stdio", tools: 0 });
        continue;
      }
      const client = new McpClient(name, config);
      try {
        await client.connect();
        const descriptors = await client.listTools();
        this.clients.push(client);
        this.tools.push(...descriptors.map((descriptor) => toLocalTool(name, descriptor, client)));
        status.push({ name, status: "ready", transport: config.url ? "http" : "stdio", tools: descriptors.length });
      } catch (error) {
        status.push({
          name,
          status: "failed",
          transport: config.url ? "http" : "stdio",
          tools: 0,
          error: (error as Error).message,
        });
        await client.close();
      }
    }
    return { tools: this.tools, status };
  }

  registeredTools(): Tool[] {
    return this.tools;
  }

  getStatus(): McpServerStatus[] {
    return this.clients.map((client) => ({
      name: client.name,
      status: client.status,
      transport: this.servers[client.name]?.url ? "http" : "stdio",
      tools: 0,
    }));
  }

  async stop(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close()));
    this.clients.length = 0;
    this.tools = [];
  }
}

export async function pingServer(name: string, config: McpServerConfig): Promise<{ ok: boolean; latencyMs?: number; error?: string; tools?: number }> {
  const client = new McpClient(name, config);
  try {
    await client.connect(8000);
    const latencyMs = await client.ping(8000);
    const tools = (await client.listTools(8000)).length;
    await client.close();
    return { ok: true, latencyMs, tools };
  } catch (error) {
    await client.close();
    return { ok: false, error: (error as Error).message };
  }
}

export function resolveServerCommand(server: McpServerConfig, cwd: string): McpServerConfig {
  if (!server.command) return server;
  const resolved = server.command.includes(path.sep) || server.command.startsWith(".") ? path.resolve(cwd, server.command) : server.command;
  return { ...server, command: resolved };
}

export { optionalString };
