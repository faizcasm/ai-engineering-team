/** Non-interactive execution (`aet -p`) with text / json / stream-json output. */

import type { ParsedArgs } from "./args.js";
import { optionString } from "./args.js";
import { Runtime } from "./runtime.js";
import type { AgentEvents } from "../core/agent.js";
import { style } from "../util/color.js";
import { renderMarkdown } from "../ui/markdown.js";

export interface PrintRunOptions {
  prompt: string;
  args: ParsedArgs;
  cwd: string;
  outputFormat: "text" | "json" | "stream-json";
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function jsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runPrint(options: PrintRunOptions): Promise<number> {
  const { prompt, args, cwd, outputFormat } = options;
  const quiet = args.options.quiet === true;
  const verbose = args.options.verbose === true;
  const streaming = outputFormat === "stream-json";

  let buffer = "";

  const events: AgentEvents = {
    onText: (delta) => {
      if (streaming) jsonLine({ type: "text_delta", text: delta });
      else buffer += delta;
    },
    onAssistantText: (text) => {
      if (streaming) jsonLine({ type: "assistant_message", text });
      else buffer = text;
    },
    onToolStart: (info) => {
      if (streaming) jsonLine({ type: "tool_start", name: info.name, input: info.input });
      else if (verbose) process.stderr.write(`${style.dim(`\u25cf ${info.name}`)} ${style.dim(short(info.input))}\n`);
    },
    onToolEnd: (info) => {
      if (streaming) {
        jsonLine({ type: "tool_end", name: info.name, isError: info.isError, durationMs: info.durationMs });
      } else if (verbose) {
        process.stderr.write(`${style.dim(`  \u2192 ${info.display ?? firstLine(info.output)}${info.isError ? " (error)" : ""}`)}\n`);
      }
    },
    onLog: (level, message) => {
      if (streaming) jsonLine({ type: "log", level, message });
      else if (!quiet) {
        const tag = level === "error" ? style.red("error") : level === "warn" ? style.yellow("warn") : style.dim("info");
        process.stderr.write(`${tag}: ${message}\n`);
      }
    },
    onCompact: (info) => {
      if (streaming) jsonLine({ type: "compacted", ...info });
      else if (!quiet) process.stderr.write(`${style.yellow(`context compacted: ~${info.estimatedTokens} -> ~${info.after} tokens`)}\n`);
    },
    onSubagentStart: (info) => {
      if (streaming) jsonLine({ ...info, type: "subagent_start" });
      else if (!quiet) process.stderr.write(`${style.dim(`\u21b3 ${info.type}: ${info.description}`)}\n`);
    },
    onSubagentEnd: (info) => {
      if (streaming) jsonLine({ ...info, type: "subagent_end" });
    },
  };

  let runtime: Runtime | undefined;
  const startedAt = Date.now();
  const controller = new AbortController();
  const onSigint = (): void => controller.abort(new Error("interrupted"));
  process.once("SIGINT", onSigint);

  try {
    runtime = await Runtime.create({ cwd, args, interactive: false, events });
    const agent = await runtime.createAgent({ signal: controller.signal });

    const result = await agent.run(prompt);
    const durationMs = Date.now() - startedAt;

    if (streaming) {
      jsonLine({
        type: "result",
        subtype: result.stopReason,
        result: result.text,
        session_id: runtime.session?.meta.id ?? null,
        turns: result.turns,
        usage: result.usage,
        cost_usd: Number(result.costUsd.toFixed(6)),
        duration_ms: durationMs,
        model: runtime.model,
        agent: agent.agentName,
      });
      return result.stopReason === "error" ? 1 : 0;
    }

    if (outputFormat === "json") {
      jsonLine({
        type: "result",
        subtype: result.stopReason,
        result: result.text,
        session_id: runtime.session?.meta.id ?? null,
        turns: result.turns,
        usage: result.usage,
        cost_usd: Number(result.costUsd.toFixed(6)),
        duration_ms: durationMs,
        model: runtime.model,
        agent: agent.agentName,
        cwd,
      });
      return result.stopReason === "error" ? 1 : 0;
    }

    // text
    if (result.text) {
      const useColor = runtime.config.color && process.stdout.isTTY;
      process.stdout.write(`${renderMarkdown(result.text, { color: useColor })}\n`);
    } else if (result.stopReason === "error") {
      process.stderr.write(`${style.red("The run failed - see errors above.")}\n`);
      return 1;
    } else {
      process.stderr.write(`${style.yellow("(no text output)")}\n`);
    }
    return result.stopReason === "error" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (outputFormat === "json" || streaming) {
      jsonLine({ type: "error", error: message });
    } else {
      process.stderr.write(`${style.red(`Error: ${message}`)}\n`);
    }
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await runtime?.close();
    void buffer;
  }
}

function short(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  return json.length > 70 ? `${json.slice(0, 69)}\u2026` : json;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

export function resolveOutputFormat(args: ParsedArgs): "text" | "json" | "stream-json" {
  const format = optionString(args, "output-format") ?? "text";
  if (format === "json" || format === "stream-json") return format;
  return "text";
}
