/** Provider resolution: turn (model, provider hints, credentials) into a client. */

import { baseUrlFor, getCredential, type AuthProvider } from "../core/auth.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { MockProvider } from "./mock.js";
import { inferProvider } from "./models.js";
import type { Provider } from "../core/types.js";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "groq" | "deepseek" | "ollama" | "mock";

export interface ResolveOptions {
  model: string;
  provider?: string;
  debug?: boolean;
}

export interface ResolvedProvider {
  provider: Provider;
  providerId: ProviderId;
  model: string;
}

export class MissingCredentialError extends Error {
  constructor(readonly providerId: string) {
    super(
      `No API key found for provider "${providerId}".\n` +
        `  - set the env var (${envHint(providerId)}), or\n` +
        `  - run \`aet auth login ${providerId}\`, or\n` +
        `  - use \`--provider mock\` for an offline/demo run.`,
    );
    this.name = "MissingCredentialError";
  }
}

function envHint(providerId: string): string {
  switch (providerId) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    default:
      return "OLLAMA_HOST";
  }
}

/** Split `openrouter/deepseek/deepseek-chat` style ids. */
export function splitModelAlias(model: string): { provider?: string; model: string } {
  const known: ProviderId[] = ["anthropic", "openai", "openrouter", "groq", "deepseek", "ollama", "mock"];
  if (model.includes(":")) {
    const [prefix, rest] = model.split(/:(.+)/);
    if (prefix && known.includes(prefix as ProviderId) && rest) return { provider: prefix, model: rest };
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    if (known.includes(prefix as ProviderId)) {
      // `openrouter/deepseek/...` keeps the nested path as the model id.
      return { provider: prefix, model: model.slice(slash + 1) };
    }
  }
  return { model };
}

export async function resolveProvider(options: ResolveOptions): Promise<ResolvedProvider> {
  const alias = splitModelAlias(options.model);
  const explicit = options.provider ?? alias.provider;
  const model = alias.model;

  const providerId = (explicit ?? inferProvider(model)) as ProviderId;
  const debug = options.debug
    ? (message: string, extra?: unknown): void => {
        process.stderr.write(`[debug] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`);
      }
    : undefined;

  if (providerId === "mock") {
    return { provider: new MockProvider({ debug }), providerId: "mock", model };
  }

  if (providerId === "ollama") {
    const cred = await getCredential("ollama");
    return {
      provider: new OllamaProvider({ baseUrl: cred.baseUrl ?? baseUrlFor("ollama"), apiKey: cred.apiKey, debug }),
      providerId: "ollama",
      model,
    };
  }

  const authProvider = (providerId === "anthropic" || providerId === "openai" || providerId === "openrouter" || providerId === "groq" || providerId === "deepseek"
    ? providerId
    : "openai") as AuthProvider;

  const credential = await getCredential(authProvider);
  if (!credential.apiKey) throw new MissingCredentialError(authProvider);

  const baseUrl = credential.baseUrl ?? baseUrlFor(authProvider);

  if (authProvider === "anthropic") {
    return {
      provider: new AnthropicProvider({ apiKey: credential.apiKey, baseUrl, debug }),
      providerId: "anthropic",
      model,
    };
  }

  return {
    provider: new OpenAiProvider({
      apiKey: credential.apiKey,
      baseUrl: baseUrl ?? "https://api.openai.com/v1",
      providerId: authProvider,
      debug,
      includeUsage: authProvider === "openai" || authProvider === "openrouter",
    }),
    providerId: authProvider as ProviderId,
    model,
  };
}

export { AnthropicProvider, OpenAiProvider, OllamaProvider, MockProvider };
export { inferProvider, getModelInfo, listModels, costUsd } from "./models.js";
