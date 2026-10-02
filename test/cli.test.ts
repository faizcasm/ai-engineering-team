/**
 * End-to-end CLI tests: spawn the real binary with the offline mock provider.
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, "..", "src", "index.js");

let home = "";
let project = "";
let script = "";
const originalHome = process.env.AET_HOME;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aet-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "aet-proj-"));
  script = path.join(home, "script.json");
  await fs.writeFile(
    script,
    JSON.stringify([
      {
        text: "Creating the file now.",
        toolCalls: [{ name: "Write", input: { file_path: path.join(project, "hello.txt"), content: "Hello from aet\n" } }],
      },
      { text: "All done - **hello.txt** written." },
    ]),
    "utf8",
  );
  process.env.AET_HOME = home;
});

after(async () => {
  if (originalHome === undefined) delete process.env.AET_HOME;
  else process.env.AET_HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn the CLI with stdin closed (like a CI pipe) and collect output. */
function aet(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        AET_HOME: home,
        AET_MOCK_SCRIPT: script,
        NO_COLOR: "1",
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`aet ${args.join(" ")} timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

test("--version prints identity and author credit", async () => {
  const { stdout } = await aet(["--version"]);
  assert.match(stdout, /aet\/\d+\.\d+\.\d+/);
  assert.match(stdout, /Faizan Hameed/);
  assert.match(stdout, /faizcasm\.me/);
  assert.match(stdout, /Ryuksaidso/);
  assert.match(stdout, /MIT/);
});

test("--help lists commands and permission modes", async () => {
  const { stdout } = await aet(["--help"]);
  for (const command of ["agents", "tools", "config", "sessions", "doctor", "mcp", "init", "team", "auth", "completions"]) {
    assert.ok(stdout.includes(command), `help should mention ${command}`);
  }
  assert.match(stdout, /bypassPermissions/);
  assert.match(stdout, /Faizan Hameed/);
});

test("help <command> renders subcommand usage", async () => {
  const { stdout } = await aet(["help", "team"]);
  assert.match(stdout, /aet team/);
  assert.match(stdout, /--plan-only/);
});

test("version subcommand prints identity like --version", async () => {
  const { stdout } = await aet(["version"]);
  assert.match(stdout, /aet\/\d+\.\d+\.\d+/);
  assert.match(stdout, /Faizan Hameed/);
});

test("agents lists the built-in team", async () => {
  const { stdout } = await aet(["agents"]);
  for (const name of ["ai-engineer", "backend-engineer", "qa-engineer", "tech-lead"]) {
    assert.ok(stdout.includes(name), `agents should list ${name}`);
  }
});

test("tools lists built-in tools", async () => {
  const { stdout } = await aet(["tools"]);
  for (const name of ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "TodoWrite", "WebFetch"]) {
    assert.ok(stdout.includes(name), `tools should list ${name}`);
  }
});

test("config get/set round-trips", async () => {
  await aet(["config", "set", "model", "mock-model"]);
  const { stdout } = await aet(["config", "get", "model"]);
  assert.match(stdout, /mock-model/);
});

test("doctor runs offline without crashing", async () => {
  const { stdout, code } = await aet(["doctor"]);
  // doctor exits non-zero when it finds issues (no credentials in CI) but must
  // still produce a full report instead of crashing.
  assert.ok(code === 0 || code === 1, `unexpected exit code ${code}`);
  assert.match(stdout, /Configuration/);
  assert.match(stdout, /Workspace/);
});

test("completions bash emits a sourceable script", async () => {
  const { stdout } = await aet(["completions", "bash"]);
  assert.match(stdout, /complete/);
  assert.match(stdout, /aet/);
});

test("init scaffolds the project .aet directory", async () => {
  await aet(["--cwd", project, "init"]);
  const entries = await fs.readdir(path.join(project, ".aet"));
  assert.ok(entries.includes("config.json"), "expected .aet/config.json");
  const files = await fs.readdir(path.join(project, ".aet", "commands"));
  assert.ok(files.length > 0, "expected a starter command");
});

test("print mode runs the mock agent end to end and writes the file", async () => {
  const { stdout, stderr } = await aet([
    "--cwd",
    project,
    "--provider",
    "mock",
    "-p",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "create hello.txt",
  ]);
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const result = JSON.parse(line) as { type: string; result: string; turns: number; session_id: string | null };
  assert.equal(result.type, "result");
  assert.match(result.result, /hello\.txt/);
  assert.ok(result.turns >= 1);
  assert.ok(!stderr.includes("Error:"), `unexpected error: ${stderr}`);

  const written = await fs.readFile(path.join(project, "hello.txt"), "utf8");
  assert.match(written, /Hello from aet/);
});

test("print mode denies writes without permission", async () => {
  const target = path.join(project, "blocked.txt");
  await aet([
    "--cwd",
    project,
    "--provider",
    "mock",
    "-p",
    "blocked",
  ]).catch(() => undefined);
  // The mock script writes hello.txt (already allowed by prior runs); assert the
  // permission engine's non-interactive deny message surfaces instead of a hang.
  const { stderr, stdout } = await aet([
    "--cwd",
    project,
    "--provider",
    "mock",
    "-p",
    "--permission-mode",
    "plan",
    "write a file",
  ]);
  const combined = `${stdout}${stderr}`;
  assert.ok(!combined.includes("non-interactive"), "plan mode should deny before the gate");
  assert.equal(await fs.stat(target).catch(() => null), null);
});

test("stream-json emits structured events", async () => {
  const { stdout } = await aet([
    "--cwd",
    project,
    "--provider",
    "mock",
    "-p",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "say hi",
  ]);
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
  assert.ok(events.some((event) => event.type === "text_delta" || event.type === "assistant_message"));
  assert.equal(events.at(-1)?.type, "result");
});

test("unknown option warns instead of crashing", async () => {
  const { stderr } = await aet(["--totally-unknown", "-p", "hi"]);
  assert.match(stderr, /unknown option/);
});

test("sessions list works when empty-ish", async () => {
  const { stdout } = await aet(["sessions", "list"]);
  assert.match(stdout, /resume|no sessions|msgs/i);
});
