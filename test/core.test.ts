/**
 * Sessions, config and custom slash commands (filesystem behaviour).
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Session } from "../src/core/session.js";
import { loadCustomCommands, expandCommand, expandFileReferences } from "../src/slash/commands.js";
import { parseFrontmatter, BUILTIN_AGENTS, getAgent, agentNames } from "../src/team/agents.js";

let home = "";
let project = "";
const originalHome = process.env.AET_HOME;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aet-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "aet-project-"));
  process.env.AET_HOME = home;
});

after(async () => {
  if (originalHome === undefined) delete process.env.AET_HOME;
  else process.env.AET_HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

/* --------------------------------------------------------------- sessions */

test("sessions persist to and reload from JSONL", async () => {
  const session = await Session.create({ cwd: project, model: "mock-model", agent: "general" });
  await session.addMessage({
    role: "user",
    content: [{ type: "text", text: "hello there" }],
    ...( { timestamp: new Date().toISOString() } as object),
  } as never);

  const loaded = await Session.load(session.meta.id);
  assert.ok(loaded, "session should reload");
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.meta.model, "mock-model");
  assert.match(loaded.meta.title, /hello there/);
});

test("session titles are derived from the first user message and truncated", async () => {
  const session = await Session.create({ cwd: project, model: "m", agent: "general" });
  await session.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(200) }] } as never);
  assert.ok(session.meta.title.length <= 72, `title too long: ${session.meta.title.length}`);
});

test("latestForCwd only returns sessions for that directory", async () => {
  const session = await Session.create({ cwd: project, model: "m", agent: "general" });
  const found = await Session.latestForCwd(project);
  assert.equal(found?.id, session.meta.id);
  assert.equal(await Session.latestForCwd(path.join(project, "nowhere")), undefined);
});

test("sessions can be listed and removed", async () => {
  const session = await Session.create({ cwd: project, model: "m", agent: "general" });
  const listed = await Session.list(50);
  assert.ok(listed.some((entry) => entry.id === session.meta.id));

  assert.equal(await Session.remove(session.meta.id), true);
  assert.equal(await Session.remove(session.meta.id), false);
  assert.equal(await Session.load(session.meta.id), null);
});

test("loading a resumed session allows further appends (write queue is armed)", async () => {
  const session = await Session.create({ cwd: project, model: "m", agent: "general" });
  const id = session.meta.id;
  const loaded = await Session.load(id);
  assert.ok(loaded);
  // Regression: Object.create skipped field initialisers and `writing` was undefined.
  await loaded.note("info", "after resume");
  const reloaded = await Session.load(id);
  assert.ok(reloaded?.notes.includes("after resume"));
});

/* ------------------------------------------------------------------ config */

test("parseScalar understands JSON-ish values", async () => {
  const { parseScalar, DEFAULT_CONFIG } = await import("../src/core/config.js");
  assert.equal(parseScalar("true"), true);
  assert.equal(parseScalar("42"), 42);
  assert.deepEqual(parseScalar("[1,2]"), [1, 2]);
  assert.equal(parseScalar("plain text"), "plain text");
  assert.equal(typeof DEFAULT_CONFIG.contextWindow, "number");
});

/* ------------------------------------------------------- custom  commands */

test("custom commands load from .aet/commands with frontmatter", async () => {
  const dir = path.join(project, ".aet", "commands");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "review.md"),
    "---\ndescription: Review the diff\nallowed-tools: Read, Bash\n---\nReview these changes: $ARGUMENTS\n",
    "utf8",
  );

  const commands = await loadCustomCommands(project);
  const review = commands.get("review");
  assert.ok(review, "review command should load");
  assert.equal(review.description, "Review the diff");
  assert.deepEqual(review.allowedTools, ["Read", "Bash"]);
  assert.match(review.body, /Review these changes/);
});

test("expandCommand substitutes $ARGUMENTS and {{args}}", () => {
  assert.equal(expandCommand("Do $ARGUMENTS now", "the thing"), "Do the thing now");
  assert.equal(expandCommand("Do {{args}} now", "the thing"), "Do the thing now");
  assert.equal(expandCommand("nothing here", "x"), "nothing here");
});

test("expandFileReferences inlines @file references", async () => {
  await fs.writeFile(path.join(project, "notes.md"), "# Notes\nkeep me\n", "utf8");
  const output = await expandFileReferences("look at @notes.md please", project);
  assert.match(output, /# Notes/);
  assert.match(output, /```md notes\.md/);
  assert.ok(!output.includes("@notes.md"));
});

test("expandFileReferences leaves unknown references alone", async () => {
  const output = await expandFileReferences("see @missing-file.md", project);
  assert.equal(output, "see @missing-file.md");
});

/* ------------------------------------------------------------------ agents */

test("eleven built-in agents exist with unique names", () => {
  assert.equal(BUILTIN_AGENTS.length, 11);
  const names = new Set(BUILTIN_AGENTS.map((agent) => agent.name));
  assert.equal(names.size, BUILTIN_AGENTS.length);
  for (const name of ["ai-engineer", "architect", "backend-engineer", "devops-engineer", "frontend-engineer", "qa-engineer", "reviewer", "tech-lead", "researcher", "documentation-engineer", "general"]) {
    assert.ok(names.has(name), `missing built-in agent: ${name}`);
  }
});

test("every built-in agent has a description and system prompt material", () => {
  for (const agent of BUILTIN_AGENTS) {
    assert.ok(agent.description.length > 10, `${agent.name} needs a description`);
    assert.ok(agent.systemPrompt.length > 40, `${agent.name} needs a prompt`);
  }
});

test("parseFrontmatter extracts attributes and body", () => {
  const parsed = parseFrontmatter("---\nname: helper\ndescription: Helps\n---\nDo the work.\n");
  assert.equal(parsed.attributes.name, "helper");
  assert.equal(parsed.attributes.description, "Helps");
  assert.match(parsed.body, /Do the work/);
});

test("getAgent is case-insensitive and agentNames is sorted-capable", async () => {
  const { resolveAgents } = await import("../src/team/agents.js");
  const agents = await resolveAgents(project);
  assert.ok(getAgent(agents, "BACKEND-ENGINEER"));
  assert.equal(getAgent(agents, "does-not-exist"), undefined);
  assert.ok(agentNames(agents).includes("general"));
});
