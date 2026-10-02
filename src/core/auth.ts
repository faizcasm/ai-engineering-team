/** API credential resolution: env vars first, then `~/.aet/auth.json`. */

import { readTextFile, writeTextFileAtomic } from "../util/fsx.js";
import { getPaths } from "./paths.js";

export type AuthProvider = "anthropic" | "openai" | "openrouter" | "groq" | "deepseek" | "ollama";

const ENV_KEYS: Record<AuthProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
};

export interface AuthStore {
  [provider: string]: { apiKey?: string; baseUrl?: string; createdAt?: string };
}

export async function readAuthStore(): Promise<AuthStore> {
  const file = getPaths().authFile;
  const contents = await readTextFile(file);
  if (!contents) return {};
  try {
    return JSON.parse(contents) as AuthStore;
  } catch {
    return {};
  }
}

export async function writeAuthStore(store: AuthStore): Promise<void> {
  await writeTextFileAtomic(getPaths().authFile, `${JSON.stringify(store, null, 2)}\n`);
}

export async function setCredential(provider: AuthProvider, apiKey: string, baseUrl?: string): Promise<void> {
  const store = await readAuthStore();
  store[provider] = { apiKey, baseUrl, createdAt: new Date().toISOString() };
  await writeAuthStore(store);
}

export async function clearCredential(provider: AuthProvider): Promise<boolean> {
  const store = await readAuthStore();
  if (!store[provider]) return false;
  delete store[provider];
  await writeAuthStore(store);
  return true;
}

export async function getCredential(provider: AuthProvider): Promise<{ apiKey?: string; baseUrl?: string; source: "env" | "auth" | "none" }> {
  for (const envName of ENV_KEYS[provider] ?? []) {
    const value = process.env[envName];
    if (value) return { apiKey: value, source: "env" };
  }
  if (provider === "ollama") {
    // Ollama usually runs locally without auth.
    return { apiKey: process.env.OLLAMA_API_KEY, source: "env" };
  }
  const store = await readAuthStore();
  const entry = store[provider];
  if (entry?.apiKey) return { apiKey: entry.apiKey, baseUrl: entry.baseUrl, source: "auth" };
  return { source: "none" };
}

export function baseUrlFor(provider: AuthProvider): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    case "openai":
      return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    case "openrouter":
      return process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    case "groq":
      return process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
    case "deepseek":
      return process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
    case "ollama":
      return process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    default:
      return undefined;
  }
}

export async function hasCredential(provider: AuthProvider): Promise<boolean> {
  const cred = await getCredential(provider);
  if (provider === "ollama") return true;
  return Boolean(cred.apiKey);
}
