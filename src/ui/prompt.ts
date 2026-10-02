/** Interactive terminal prompts: questions, choices, permission gate. */

import * as readline from "node:readline";
import { style } from "../util/color.js";
import type { PermissionDecision, PermissionGate, PermissionRequest } from "../core/permissions.js";
import { suggestAllowRule } from "../core/permissions.js";

export type Rl = readline.Interface;

/**
 * Tracks whether an interactive prompt currently owns the terminal.
 * The REPL consults this so lines typed during an approval prompt are not
 * mistaken for the next user message.
 */
export const promptState = { active: 0 };

type LineProvider = () => Promise<string | null>;

let lineProvider: LineProvider | null = null;

/**
 * The REPL registers its own line queue so prompts (approvals, menus) consume
 * the same input stream as the main loop - typed-ahead lines are never lost
 * and never consumed twice.
 */
export function setLineProvider(provider: LineProvider | null): void {
  lineProvider = provider;
}

export function question(rl: Rl, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      promptState.active = Math.max(0, promptState.active - 1);
      rl.removeListener("close", onClose);
      rl.removeListener("error", onError);
      resolve(value);
    };
    const onClose = (): void => finish("");
    const onError = (): void => finish("");

    rl.once("close", onClose);
    rl.once("error", onError);
    promptState.active += 1;

    if (lineProvider) {
      process.stdout.write(prompt);
      void lineProvider().then((line) => finish(line === null ? "" : line.trim()));
      return;
    }

    try {
      rl.question(prompt, (answer) => finish(answer.trim()));
    } catch {
      // readline can throw ERR_USE_AFTER_CLOSE if stdin already ended.
      finish("");
    }
  });
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Numbered single-select menu. */
export async function choose<T>(rl: Rl, title: string, choices: Array<Choice<T>>): Promise<T | null> {
  process.stdout.write(`\n${style.bold(title)}\n`);
  choices.forEach((choice, index) => {
    const hint = choice.hint ? style.dim(`  ${choice.hint}`) : "";
    process.stdout.write(`  ${style.cyan(String(index + 1))}. ${choice.label}${hint}\n`);
  });
  while (true) {
    const answer = await question(rl, `${style.bold("?")} Select 1-${choices.length} (empty to cancel): `);
    if (answer.length === 0) return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1]!.value;
    }
    process.stdout.write(`${style.yellow("  Please enter a number from the list.")}\n`);
  }
}

export interface GateOptions {
  /** Invoked when the user picks "always"; should persist an allow rule. */
  onRemember?: (rule: string) => void | Promise<void>;
  /** Render extra context (e.g. a diff preview) before the question. */
  preview?: (request: PermissionRequest) => string | undefined;
}

function describeRequest(request: PermissionRequest): string {
  const target = request.target ?? "";
  switch (request.tool) {
    case "Bash":
      return `$ ${target}`;
    case "Read":
      return `read ${target}`;
    case "Write":
      return `write ${target}`;
    case "Edit":
    case "MultiEdit":
      return `edit ${target}`;
    case "WebFetch":
      return `fetch ${target}`;
    case "Task":
      return `delegate to ${target}`;
    default:
      return target ? `${request.tool} ${target}` : request.tool;
  }
}

/**
 * Serializes permission prompts so parallel subagents cannot interleave
 * questions on the same readline instance.
 */
export class QueuedGate implements PermissionGate {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rlProvider: () => Rl,
    private readonly options: GateOptions = {},
  ) {}

  ask(request: PermissionRequest, reason: string): Promise<PermissionDecision> {
    const next = this.chain.then(() => this.askNow(request, reason));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async askNow(request: PermissionRequest, reason: string): Promise<PermissionDecision> {
    const rule = suggestAllowRule(request);
    const preview = this.options.preview?.(request);
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${style.yellow("\u25B2")} ${style.bold(request.tool)} ${style.dim(`(${reason})`)}${request.source === "subagent" ? style.dim(" - subagent") : ""}`);
    if (preview) lines.push(preview);
    lines.push(`  ${style.white(describeRequest(request))}`);
    lines.push(`  ${style.dim("y")} allow once   ${style.dim("a")} always allow ${style.dim(`(${rule})`)}   ${style.dim("n")} deny`);
    process.stdout.write(`${lines.join("\n")}\n`);

    while (true) {
      let rl: Rl;
      try {
        rl = this.rlProvider();
      } catch {
        return { action: "deny", reason: "terminal not available" };
      }
      const answer = (await question(rl, `  ${style.bold("?")} approve? [y/a/N] `)).toLowerCase();
      if (answer === "" || answer === "n" || answer === "no") {
        return { action: "deny", reason: "user declined" };
      }
      if (answer === "y" || answer === "yes") {
        return { action: "allow", reason: "user approved" };
      }
      if (answer === "a" || answer === "always" || answer === "s") {
        try {
          await this.options.onRemember?.(rule);
        } catch (error) {
          process.stdout.write(`  ${style.red(`could not persist rule: ${(error as Error).message}`)}\n`);
        }
        return { action: "allow", reason: "user approved (remembered)", remembered: true };
      }
      process.stdout.write(`  ${style.yellow("please answer y, a or n")}\n`);
    }
  }
}

/** Gate that answers "deny" to everything (non-interactive fallback). */
export const denyGate: PermissionGate = {
  async ask(): Promise<PermissionDecision> {
    return { action: "deny", reason: "non-interactive session" };
  },
};
