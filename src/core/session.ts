/** Session persistence: JSONL transcripts under ~/.aet/sessions. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendJsonLine, ensureDir, pathExists, readTextFile, writeTextFileAtomic } from "../util/fsx.js";
import { randomId } from "../util/text.js";
import { nowIso } from "../util/time.js";
import { getPaths } from "./paths.js";
import type { Message } from "./types.js";
import { messageText } from "./types.js";
import type { Todo } from "../tools/types.js";
import { VERSION } from "../version.js";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  agent: string;
  version: string;
  messageCount?: number;
  tokens?: number;
}

export type SessionEntry =
  | ({ type: "meta" } & SessionMeta)
  | { type: "message"; message: Message }
  | { type: "todos"; todos: Todo[] }
  | { type: "note"; level: "info" | "warn" | "error"; text: string; at: string }
  | { type: "summary"; text: string; at: string };

function sessionFile(id: string): string {
  return path.join(getPaths().sessionsDir, `${id}.jsonl`);
}

export function newSessionId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomId(4)}`;
}

export class Session {
  meta: SessionMeta;
  messages: Message[] = [];
  todos: Todo[] = [];
  notes: string[] = [];
  private readonly filePath: string;
  private writing: Promise<void> = Promise.resolve();

  private constructor(meta: SessionMeta, filePath: string) {
    this.meta = meta;
    this.filePath = filePath;
  }

  static async create(options: { cwd: string; model: string; agent: string; title?: string }): Promise<Session> {
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: options.title ?? "New session",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      cwd: options.cwd,
      model: options.model,
      agent: options.agent,
      version: VERSION,
      messageCount: 0,
      tokens: 0,
    };
    const filePath = sessionFile(id);
    await ensureDir(path.dirname(filePath));
    await writeTextFileAtomic(filePath, "");
    const session = new Session(meta, filePath);
    await session.append({ type: "meta", ...meta });
    return session;
  }

  static async load(id: string): Promise<Session | null> {
    const filePath = sessionFile(id);
    if (!(await pathExists(filePath))) {
      const matches = await Session.list();
      const match = matches.find((entry) => entry.id.startsWith(id));
      if (!match) return null;
      return Session.load(match.id);
    }
    const contents = await readTextFile(filePath);
    if (contents === null) return null;

    let meta: SessionMeta | null = null;
    const session = Object.create(Session.prototype) as Session;
    (session as unknown as { filePath: string }).filePath = filePath;
    session.messages = [];
    session.todos = [];
    session.notes = [];
    // Object.create skips field initializers, so re-arm the write queue.
    session.writing = Promise.resolve();

    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }
      switch (entry.type) {
        case "meta":
          meta = entry;
          break;
        case "message":
          session.messages.push(entry.message);
          break;
        case "todos":
          session.todos = entry.todos;
          break;
        case "note":
          session.notes.push(entry.text);
          break;
        default:
          break;
      }
    }
    if (!meta) return null;
    session.meta = meta;
    return session;
  }

  static async list(limit = 50): Promise<SessionMeta[]> {
    const dir = getPaths().sessionsDir;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const metas: Array<SessionMeta & { mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = await fs.stat(filePath);
        const contents = await readTextFile(filePath);
        const firstLine = contents?.split("\n", 1)[0];
        if (!firstLine) continue;
        const parsed = JSON.parse(firstLine) as { type?: string } & SessionMeta;
        if (parsed.type !== "meta") continue;
        const count = contents ? contents.split("\n").filter((line) => line.includes('"type":"message"')).length : 0;
        metas.push({ ...parsed, messageCount: count, mtime: stat.mtimeMs });
      } catch {
        /* skip corrupt */
      }
    }
    metas.sort((a, b) => b.mtime - a.mtime);
    return metas.slice(0, limit).map(({ mtime: _mtime, ...meta }) => meta);
  }

  static async latestForCwd(cwd: string): Promise<SessionMeta | undefined> {
    const all = await Session.list(100);
    return all.find((meta) => meta.cwd === cwd);
  }

  static async remove(id: string): Promise<boolean> {
    const filePath = sessionFile(id);
    if (!(await pathExists(filePath))) return false;
    await fs.unlink(filePath);
    return true;
  }

  async append(entry: SessionEntry): Promise<void> {
    this.writing = this.writing.then(() => appendJsonLine(this.filePath, entry)).catch(() => undefined);
    await this.writing;
  }

  async addMessage(message: Message): Promise<void> {
    this.messages.push(message);
    this.meta.messageCount = this.messages.length;
    this.meta.updatedAt = nowIso();
    await this.append({ type: "message", message });
    if (this.meta.title === "New session") await this.deriveTitle();
  }

  async setTodos(todos: Todo[]): Promise<void> {
    this.todos = todos;
    await this.append({ type: "todos", todos });
  }

  async note(level: "info" | "warn" | "error", text: string): Promise<void> {
    this.notes.push(text);
    await this.append({ type: "note", level, text, at: nowIso() });
  }

  async summarize(text: string): Promise<void> {
    await this.append({ type: "summary", text, at: nowIso() });
  }

  async setMeta(patch: Partial<SessionMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch, updatedAt: nowIso() };
    // Rewrite the head meta line so `sessions list` shows fresh titles.
    const contents = await readTextFile(this.filePath);
    if (contents === null) return;
    const lines = contents.split("\n").filter((line) => line.length > 0);
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]!) as SessionEntry;
        if (first.type === "meta") {
          lines[0] = JSON.stringify({ type: "meta", ...this.meta });
          await writeTextFileAtomic(this.filePath, `${lines.join("\n")}\n`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  get title(): string {
    return this.meta.title;
  }

  async deriveTitle(): Promise<void> {
    const firstUser = this.messages.find((message) => message.role === "user");
    if (!firstUser) return;
    const text = messageText(firstUser).replace(/\s+/g, " ").trim();
    if (!text) return;
    await this.setMeta({ title: text.length > 72 ? `${text.slice(0, 71)}\u2026` : text });
  }
}
