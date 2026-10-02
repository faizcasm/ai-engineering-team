#!/usr/bin/env node
/**
 * AI Engineering Team (aet) - open source agentic coding CLI.
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 * Repository: https://github.com/faizcasm/ai-engineering-team
 * License: MIT
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Closing stdout early (`aet tools | head -3`) must not crash the process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
}

import { parseArgs, splitAtCommand, optionBool, optionString, type ParsedArgs, type OptionSpec } from "./cli/args.js";
import { GLOBAL_OPTIONS, COMMANDS, COMMAND_OPTIONS, renderHelp, renderVersion } from "./cli/help.js";
import { runSubcommand } from "./cli/commands.js";
import { runPrint, readStdin, resolveOutputFormat } from "./cli/print.js";
import { Runtime } from "./cli/runtime.js";
import { Repl } from "./ui/repl.js";
import { MissingCredentialError } from "./providers/index.js";
import { style, setColorEnabled } from "./util/color.js";
import { resolveCwd } from "./core/config.js";
import { CREDIT, REPO_URL, VERSION } from "./version.js";

const COMMAND_NAMES = (COMMANDS as ReadonlyArray<{ name: string }>).map((command) => command.name);

function printHelpAndExit(): number {
  process.stdout.write(`${renderHelp()}\n`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    // Split at the subcommand so `aet --cwd x team "goal" --plan-only` parses
    // global options from the head and subcommand options/args from the tail.
    const { head, command, tail } = splitAtCommand(argv, GLOBAL_OPTIONS, COMMAND_NAMES);
    const extra: OptionSpec[] = (command && COMMAND_OPTIONS[command]) || [];

    if (command) {
      const headArgs = parseArgs(head, GLOBAL_OPTIONS);
      // Unknown flags after the command belong to it (`aet mcp add fs npx -y ...`).
      const tailArgs = parseArgs(tail, [...GLOBAL_OPTIONS, ...extra], { keepUnknown: true });
      args = {
        options: { ...headArgs.options, ...tailArgs.options },
        positionals: [...headArgs.positionals, command, ...tailArgs.positionals],
        unknown: headArgs.unknown,
        passthrough: tailArgs.passthrough,
      };
    } else {
      args = parseArgs(head, [...GLOBAL_OPTIONS, ...extra]);
    }
  } catch (error) {
    process.stderr.write(`${style.red(`Error: ${(error as Error).message}`)}\n\n`);
    process.stderr.write(`Run \`aet --help\` for usage.\n`);
    return 2;
  }

  // Colours are re-configured once config is loaded; this covers early output.
  if (optionBool(args, "no-color") || process.env.NO_COLOR) setColorEnabled(false);

  if (optionBool(args, "version")) {
    process.stdout.write(`${renderVersion()}\n`);
    return 0;
  }

  if (optionBool(args, "help")) return printHelpAndExit();

  if (args.unknown.length > 0) {
    process.stderr.write(
      `${style.yellow("warning")}: unknown option(s) ${args.unknown.join(", ")} - run \`aet --help\`\n`,
    );
  }

  // Validate --cwd before doing anything else.
  const cwd = resolveCwd(optionString(args, "cwd"));
  if (!existsSync(cwd)) {
    process.stderr.write(`${style.red(`Error: --cwd directory does not exist: ${cwd}`)}\n`);
    return 2;
  }

  // `aet sessions resume <id>` is sugar for `aet --resume <id>`: it drops out of
  // the subcommand path so the run path starts a REPL bound to that session.
  let positionals = [...args.positionals];
  if (positionals[0] === "sessions" && positionals[1] === "resume") {
    const id = positionals[2];
    if (!id) {
      process.stderr.write("usage: aet sessions resume <id>   (or: aet --resume [id])\n");
      return 2;
    }
    args.options.resume = id;
    positionals = [];
  }

  const first = positionals[0];
  if (first && COMMAND_NAMES.includes(first)) {
    const rest = positionals.slice(1);
    return runSubcommand(first, rest, args, path.resolve(cwd));
  }

  // ---------------------------------------------------------------- run ---
  const isPrint = optionBool(args, "print") || !process.stdin.isTTY;
  const promptFromArgs = positionals.join(" ").trim();
  let prompt = promptFromArgs;

  if (!prompt) {
    // No positional prompt: read piped stdin (scripts / `cat file | aet -p`).
    const piped = (await readStdin()).trim();
    if (piped) prompt = piped;
  }

  if (!prompt && optionBool(args, "print")) {
    process.stderr.write(
      `${style.red("Error: --print requires a prompt (argument or piped stdin).")}\n` +
        `  e.g. aet -p "explain this repository"\n`,
    );
    return 2;
  }

  try {
    let code: number;
    if (isPrint && prompt) {
      code = await runPrint({
        prompt,
        args,
        cwd: path.resolve(cwd),
        outputFormat: resolveOutputFormat(args),
      });
    } else {
      // Interactive REPL.
      const runtime = await Runtime.create({ cwd: path.resolve(cwd), args, interactive: true });
      const repl = new Repl(runtime, args);
      await repl.start(prompt);
      code = 0;
    }
    // Background shells / MCP child processes can keep the event loop alive
    // after the UI is done - guarantee the process actually terminates.
    scheduleForcedExit(code);
    return code;
  } catch (error) {
    return reportFatal(error);
  }
}

/** Force-exit shortly after a long-running session completes. */
function scheduleForcedExit(code: number): void {
  setTimeout(() => process.exit(code), 250);
}

function reportFatal(error: unknown): number {
  if (error instanceof MissingCredentialError) {
    process.stderr.write(`\n${style.red("Missing credentials")}\n${error.message}\n\n`);
    process.stderr.write(`${style.dim(`Docs: ${REPO_URL}/blob/main/docs/providers.md`)}\n`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${style.red(`Error: ${message}`)}\n`);
  if (process.env.AET_DEBUG) {
    process.stderr.write(`${style.dim(error instanceof Error && error.stack ? error.stack : "")}\n`);
  }
  process.stderr.write(`${style.dim(`Run \`aet doctor\` to diagnose. ${CREDIT}`)}\n\n`);
  return 1;
}

/** Entry point when executed as a binary. */
async function run(): Promise<void> {
  const code = await main();
  process.exitCode = code;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  run().catch((error: unknown) => {
    reportFatal(error);
    process.exit(1);
  });
}

export { VERSION };
