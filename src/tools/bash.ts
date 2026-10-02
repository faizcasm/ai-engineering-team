/** Shell tool with timeout, output capping and background execution. */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { humanDuration } from "../util/text.js";
import { humanBytes } from "../util/text.js";
import type { Tool, ToolResult } from "./types.js";
import { asObject, optionalBoolean, optionalNumber, optionalString, requireString } from "./types.js";

const MAX_OUTPUT_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface BackgroundShell {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  child: ChildProcess;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finished: boolean;
  truncated: boolean;
}

const backgrounds = new Map<string, BackgroundShell>();
let backgroundCounter = 0;

export function getBackground(id: string): BackgroundShell | undefined {
  return backgrounds.get(id);
}

export function listBackgroundShells(): BackgroundShell[] {
  return [...backgrounds.values()];
}

function appendOutput(shell: BackgroundShell, chunk: string): void {
  shell.output += chunk;
  if (shell.output.length > MAX_OUTPUT_CHARS * 2) {
    shell.output = `${shell.output.slice(0, MAX_OUTPUT_CHARS)}\n\u2026 [output truncated]`;
    shell.truncated = true;
  }
}

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}

export interface RunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** Run a command to completion (foreground). */
export function runCommand(options: RunOptions): Promise<RunResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: process.env.SHELL || "/bin/sh",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = (): void => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.(text);
    });

    const settle = (exitCode: number, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startedAt;
      resolve({ output: joinOutput(stdout, stderr), exitCode: timedOut ? 124 : exitCode, timedOut, durationMs });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: `failed to start: ${error.message}`, exitCode: 127, timedOut, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code, signal) => settle(code ?? (signal ? 1 : 0), signal));
  });
}

function joinOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim().length > 0) parts.push(stdout.replace(/\s+$/, ""));
  if (stderr.trim().length > 0) parts.push(`--- stderr ---\n${stderr.replace(/\s+$/, "")}`);
  if (parts.length === 0) return "(no output)";
  const joined = parts.join("\n");
  if (joined.length <= MAX_OUTPUT_CHARS) return joined;
  return `${joined.slice(0, MAX_OUTPUT_CHARS)}\n\u2026 [truncated ${humanBytes(joined.length - MAX_OUTPUT_CHARS)} of output]`;
}

function startBackground(options: { command: string; cwd: string; signal?: AbortSignal }): BackgroundShell {
  backgroundCounter += 1;
  const id = `bg_${backgroundCounter}`;
  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: process.env.SHELL || "/bin/sh",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", GIT_PAGER: "cat" },
    detached: process.platform !== "win32",
  });
  const shell: BackgroundShell = {
    id,
    command: options.command,
    cwd: options.cwd,
    startedAt: Date.now(),
    child,
    output: "",
    exitCode: null,
    signal: null,
    finished: false,
    truncated: false,
  };
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(shell, chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(shell, chunk.toString()));
  child.on("close", (code, signal) => {
    shell.exitCode = code;
    shell.signal = signal;
    shell.finished = true;
  });
  child.on("error", (error) => {
    appendOutput(shell, `failed to start: ${error.message}\n`);
    shell.exitCode = 127;
    shell.finished = true;
  });
  backgrounds.set(id, shell);
  return shell;
}

export const bashTool: Tool = {
  spec: {
    name: "Bash",
    description:
      "Run a shell command in the project directory and return its stdout/stderr plus exit code. " +
      "Use for builds, tests, git, package managers and any CLI. Long-running commands can run in the background.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
        description: { type: "string", description: "Short human-readable description of the command" },
        run_in_background: { type: "boolean", description: "Run detached and poll output with BashOutput" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const command = requireString(input, "command");
    const timeout = optionalNumber(input, "timeout");
    const description = optionalString(input, "description");
    const runInBackground = optionalBoolean(input, "run_in_background") ?? false;

    ctx.emit({ type: "progress", text: description ?? command });

    if (runInBackground) {
      const shell = startBackground({ command, cwd: ctx.cwd, signal: ctx.signal });
      ctx.emit({ type: "background_started", id: shell.id, command });
      return {
        output: `Started background session ${shell.id}: ${command}\nPoll with BashOutput { background_id: "${shell.id}" }.`,
        display: `${shell.id} ${command}`,
        meta: { backgroundId: shell.id },
      };
    }

    const result = await runCommand({ command, cwd: ctx.cwd, timeoutMs: timeout, signal: ctx.signal });
    const suffix = `[exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}, ${humanDuration(result.durationMs)}]`;
    return {
      output: `${result.output}\n${suffix}`,
      display: `${description ?? command} \u00b7 ${humanDuration(result.durationMs)} \u00b7 exit ${result.exitCode}`,
      isError: result.exitCode !== 0,
      meta: { exitCode: result.exitCode, durationMs: result.durationMs },
    };
  },
};

export const bashOutputTool: Tool = {
  spec: {
    name: "BashOutput",
    description: "Read the output of a background shell started with Bash(run_in_background).",
    inputSchema: {
      type: "object",
      properties: {
        background_id: { type: "string", description: "Background session id, e.g. bg_1" },
      },
      required: ["background_id"],
      additionalProperties: false,
    },
  },
  async execute(rawInput): Promise<ToolResult> {
    const input = asObject(rawInput);
    const id = requireString(input, "background_id");
    const shell = backgrounds.get(id);
    if (!shell) {
      return { output: `No background session "${id}". Active: ${[...backgrounds.keys()].join(", ") || "(none)"}.`, isError: true };
    }
    const status = shell.finished
      ? `exited with code ${shell.exitCode}${shell.signal ? ` (signal ${shell.signal})` : ""}`
      : "still running";
    const body = shell.output.length > 0 ? shell.output : "(no output yet)";
    return {
      output: `${body}\n[${status}, running for ${humanDuration(Date.now() - shell.startedAt)}]`,
      display: `${id} \u00b7 ${status}`,
      meta: { finished: shell.finished, exitCode: shell.exitCode },
    };
  },
};

export const killShellTool: Tool = {
  spec: {
    name: "KillShell",
    description: "Terminate a background shell started with Bash(run_in_background).",
    inputSchema: {
      type: "object",
      properties: {
        background_id: { type: "string", description: "Background session id" },
      },
      required: ["background_id"],
      additionalProperties: false,
    },
  },
  async execute(rawInput): Promise<ToolResult> {
    const input = asObject(rawInput);
    const id = requireString(input, "background_id");
    const shell = backgrounds.get(id);
    if (!shell) return { output: `No background session "${id}".`, isError: true };
    if (shell.finished) return { output: `${id} already exited (${shell.exitCode}).` };
    try {
      if (shell.child.pid && process.platform !== "win32") process.kill(-shell.child.pid, "SIGKILL");
      else shell.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    return { output: `Killed ${id}.`, display: `killed ${id}` };
  },
};

/** Used by tests / shutdown to clean up stray processes. */
export function killAllBackgroundShells(): void {
  for (const shell of backgrounds.values()) {
    if (shell.finished) continue;
    try {
      if (shell.child.pid && process.platform !== "win32") process.kill(-shell.child.pid, "SIGKILL");
      else shell.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

export function resolveWorkspacePath(target: string, cwd: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
