import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

/* =====================================================
   TYPES
===================================================== */

export type LLMProvider = "anthropic" | "openai";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface LLMRequest {
  messages: ChatMessage[];
  provider?: LLMProvider;
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export type LLMOptions = Omit<LLMRequest, "messages">;

export interface LLMUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LLMResponse {
  provider: LLMProvider;
  model: string;
  content: string;
  stopReason: string | null;
  usage: LLMUsage;
  latencyMs: number;
}

export interface ProviderCatalog {
  provider: LLMProvider;
  label: string;
  apiKeyConfigured: boolean;
  defaultModel: string;
  models: string[];
}

interface ResolvedConfig {
  provider: LLMProvider;
  apiKey: string;
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/* =====================================================
   CONSTANTS
===================================================== */

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
const OPENAI_DEFAULT_MODEL = "gpt-5.6-terra";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;

const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 400;

const RETRYABLE_STATUS = new Set([
  408, 429, 500, 502, 503, 504,
]);

const MODEL_CATALOG: Record<LLMProvider, string[]> = {
  anthropic: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-opus-5",
  ],

  openai: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-4.1",
    "gpt-4o",
  ],
};

/* =====================================================
   HELPERS
===================================================== */

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new AppError(
      "Malformed response from LLM provider",
      502
    );
  }

  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];

  return typeof value === "string" ? value : null;
}

function readNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function readArray(
  record: Record<string, unknown>,
  key: string
): unknown[] | null {
  const value = record[key];

  return Array.isArray(value) ? value : null;
}

function readErrorMessage(
  value: unknown
): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    return readString(
      value as Record<string, unknown>,
      "message"
    );
  }

  return null;
}

/* =====================================================
   CONFIGURATION
===================================================== */

export function resolveProvider(
  value?: string
): LLMProvider {
  const candidate = (
    value || process.env.LLM_PROVIDER || "anthropic"
  ).toLowerCase();

  if (candidate === "anthropic") {
    return "anthropic";
  }

  if (candidate === "openai") {
    return "openai";
  }

  throw new AppError(
    `Unsupported LLM provider "${candidate}". Use "anthropic" or "openai".`,
    400
  );
}

function defaultModel(provider: LLMProvider): string {
  const envModel = process.env.LLM_MODEL?.trim();
  const envProvider = process.env.LLM_PROVIDER?.trim();

  if (envModel && (!envProvider || envProvider === provider)) {
    return envModel;
  }

  return provider === "anthropic"
    ? ANTHROPIC_DEFAULT_MODEL
    : OPENAI_DEFAULT_MODEL;
}

function buildEndpoint(
  provider: LLMProvider,
  baseUrl: string
): string {
  const trimmed = baseUrl.replace(/\/+$/, "");

  const path =
    provider === "anthropic" ? "messages" : "chat/completions";

  if (trimmed.endsWith(`/${path}`)) {
    return trimmed;
  }

  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/${path}`;
  }

  return `${trimmed}/v1/${path}`;
}

export function resolveConfig(
  options: LLMOptions = {}
): ResolvedConfig {
  const provider = resolveProvider(options.provider);

  const apiKey =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const variable =
      provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENAI_API_KEY";

    throw new AppError(
      `Missing API key for provider "${provider}". Set ${variable} in your environment.`,
      500
    );
  }

  const baseUrl =
    process.env.LLM_BASE_URL?.trim() ||
    (provider === "anthropic"
      ? ANTHROPIC_BASE_URL
      : OPENAI_BASE_URL);

  const model =
    options.model?.trim() || defaultModel(provider);

  return {
    provider,
    apiKey,
    endpoint: buildEndpoint(provider, baseUrl),
    model,

    temperature: clamp(
      options.temperature ??
        envNumber("LLM_TEMPERATURE", DEFAULT_TEMPERATURE),
      0,
      2
    ),

    maxTokens: Math.max(
      1,
      Math.round(
        options.maxTokens ??
          envNumber("LLM_MAX_TOKENS", DEFAULT_MAX_TOKENS)
      )
    ),
  };
}

export function listModels(): ProviderCatalog[] {
  const providers: LLMProvider[] = ["anthropic", "openai"];

  return providers.map((provider) => ({
    provider,

    label:
      provider === "anthropic"
        ? "Anthropic Messages API"
        : "OpenAI Chat Completions API",

    apiKeyConfigured: Boolean(
      provider === "anthropic"
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY
    ),

    defaultModel: defaultModel(provider),
    models: [...MODEL_CATALOG[provider]],
  }));
}

/* =====================================================
   REQUEST BUILDERS
===================================================== */

function supportsTemperature(model: string): boolean {
  // Reasoning models only accept the default temperature.
  return !/^(gpt-[56]|o\d)/.test(model);
}

function mergeConsecutive(
  messages: ChatMessage[]
): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];

    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }

    merged.push({ ...message });
  }

  return merged;
}

function prepareMessages(
  provider: LLMProvider,
  messages: ChatMessage[],
  system?: string
): { systemText: string; messages: ChatMessage[] } {
  const systemParts: string[] = [];

  if (system?.trim()) {
    systemParts.push(system.trim());
  }

  const chat: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    chat.push({
      role: message.role,
      content: message.content,
    });
  }

  if (!chat.length) {
    throw new AppError(
      "At least one user or assistant message is required",
      400
    );
  }

  return {
    systemText: systemParts.join("\n\n"),
    messages:
      provider === "anthropic"
        ? mergeConsecutive(chat)
        : chat,
  };
}

function buildHeaders(
  config: ResolvedConfig
): Record<string, string> {
  if (config.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
}

function buildBody(
  config: ResolvedConfig,
  systemText: string,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream,
  };

  if (supportsTemperature(config.model)) {
    body.temperature = config.temperature;
  }

  if (config.provider === "anthropic") {
    body.max_tokens = config.maxTokens;

    if (systemText) {
      body.system = systemText;
    }

    body.messages = messages;

    return body;
  }

  body.max_completion_tokens = config.maxTokens;

  body.messages = systemText
    ? [{ role: "system", content: systemText }, ...messages]
    : messages;

  return body;
}

/* =====================================================
   HTTP + RETRY
===================================================== */

function isRetryable(error: unknown): boolean {
  return (
    error instanceof AppError &&
    RETRYABLE_STATUS.has(error.statusCode)
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  retries = RETRY_ATTEMPTS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === retries) {
        break;
      }

      const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;

      logger.warn("LLM request failed, retrying", {
        label,
        attempt: attempt + 1,
        delayMs,

        message:
          error instanceof Error
            ? error.message
            : String(error),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function send(
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    throw new AppError(
      `Could not reach LLM provider: ${message}`,
      502
    );
  }
}

async function providerError(
  response: Response
): Promise<AppError> {
  let detail = response.statusText || "Request failed";

  try {
    const text = await response.text();

    if (text) {
      try {
        const payload = asRecord(JSON.parse(text));
        const message = readErrorMessage(payload.error);

        detail = message || text.slice(0, 300);
      } catch {
        detail = text.slice(0, 300);
      }
    }
  } catch {
    // Keep the status text when the body cannot be read.
  }

  const statusCode =
    response.status >= 500 ? 502 : response.status;

  return new AppError(
    `LLM provider error (${response.status}): ${detail}`,
    statusCode
  );
}

async function postJson(
  url: string,
  init: RequestInit
): Promise<unknown> {
  const response = await send(url, init);

  if (!response.ok) {
    throw await providerError(response);
  }

  return response.json();
}

async function postStream(
  url: string,
  init: RequestInit
): Promise<Response> {
  const response = await send(url, init);

  if (!response.ok) {
    throw await providerError(response);
  }

  return response;
}

/* =====================================================
   RESPONSE PARSING
===================================================== */

function parseAnthropic(
  config: ResolvedConfig,
  payload: unknown,
  latencyMs: number
): LLMResponse {
  const record = asRecord(payload);
  const blocks = readArray(record, "content") || [];

  const content = blocks
    .filter((block) => typeof block === "object" && block !== null)
    .map((block) => {
      const entry = block as Record<string, unknown>;

      return readString(entry, "type") === "text"
        ? readString(entry, "text") || ""
        : "";
    })
    .join("")
    .trim();

  const usage = record.usage
    ? asRecord(record.usage)
    : {};

  return {
    provider: "anthropic",
    model: readString(record, "model") || config.model,
    content,
    stopReason: readString(record, "stop_reason"),

    usage: {
      inputTokens: readNumber(usage, "input_tokens"),
      outputTokens: readNumber(usage, "output_tokens"),
    },

    latencyMs,
  };
}

function parseOpenAI(
  config: ResolvedConfig,
  payload: unknown,
  latencyMs: number
): LLMResponse {
  const record = asRecord(payload);
  const choices = readArray(record, "choices") || [];

  const first =
    choices.length && choices[0]
      ? asRecord(choices[0])
      : null;

  const rawMessage = first ? first.message : null;

  const message =
    typeof rawMessage === "object" && rawMessage !== null
      ? (rawMessage as Record<string, unknown>)
      : {};

  const usage = record.usage
    ? asRecord(record.usage)
    : {};

  return {
    provider: "openai",
    model: readString(record, "model") || config.model,
    content: (readString(message, "content") || "").trim(),
    stopReason: first
      ? readString(first, "finish_reason")
      : null,

    usage: {
      inputTokens: readNumber(usage, "prompt_tokens"),
      outputTokens: readNumber(usage, "completion_tokens"),
    },

    latencyMs,
  };
}

/* =====================================================
   STREAMING
===================================================== */

async function* readSseEvents(
  response: Response
): AsyncGenerator<string, void, void> {
  const body = response.body;

  if (!body) {
    throw new AppError(
      "LLM provider returned an empty stream",
      502
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const event of events) {
        if (event.trim()) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function eventPayload(event: string): string | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  return data.trim() ? data : null;
}

interface StreamDelta {
  text: string | null;
  done: boolean;
  error: string | null;
}

function parseStreamEvent(
  provider: LLMProvider,
  event: string
): StreamDelta {
  const data = eventPayload(event);

  if (!data) {
    return { text: null, done: false, error: null };
  }

  if (data === "[DONE]") {
    return { text: null, done: true, error: null };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(data);
  } catch {
    return { text: null, done: false, error: null };
  }

  const record = asRecord(payload);

  if (record.error) {
    const message =
      readErrorMessage(record.error) || "Stream failed";

    return { text: null, done: true, error: message };
  }

  if (provider === "anthropic") {
    const type = readString(record, "type");

    if (type === "message_stop") {
      return { text: null, done: true, error: null };
    }

    if (type === "error") {
      return {
        text: null,
        done: true,
        error: "Anthropic stream reported an error",
      };
    }

    if (type === "content_block_delta" && record.delta) {
      const delta = asRecord(record.delta);

      if (readString(delta, "type") === "text_delta") {
        return {
          text: readString(delta, "text"),
          done: false,
          error: null,
        };
      }
    }

    return { text: null, done: false, error: null };
  }

  const choices = readArray(record, "choices") || [];

  const rawChoice = choices.length ? choices[0] : null;

  const choice =
    typeof rawChoice === "object" && rawChoice !== null
      ? (rawChoice as Record<string, unknown>)
      : null;

  const rawDelta = choice ? choice.delta : null;

  const delta =
    typeof rawDelta === "object" && rawDelta !== null
      ? (rawDelta as Record<string, unknown>)
      : {};

  return {
    text: readString(delta, "content"),
    done: false,
    error: null,
  };
}

/* =====================================================
   PUBLIC API
===================================================== */

export async function chat(
  messages: ChatMessage[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  const startedAt = Date.now();
  const config = resolveConfig(options);

  const { systemText, messages: prepared } = prepareMessages(
    config.provider,
    messages,
    options.system
  );

  const body = buildBody(
    config,
    systemText,
    prepared,
    false
  );

  const init: RequestInit = {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(body),
  };

  const payload = await withRetry(
    () => postJson(config.endpoint, init),
    "chat"
  );

  const response =
    config.provider === "anthropic"
      ? parseAnthropic(config, payload, Date.now() - startedAt)
      : parseOpenAI(config, payload, Date.now() - startedAt);

  logger.info("LLM completion", {
    provider: response.provider,
    model: response.model,
    latencyMs: response.latencyMs,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  });

  return response;
}

export async function* streamChat(
  messages: ChatMessage[],
  options: LLMOptions = {}
): AsyncGenerator<string, void, void> {
  const config = resolveConfig(options);

  const { systemText, messages: prepared } = prepareMessages(
    config.provider,
    messages,
    options.system
  );

  const body = buildBody(
    config,
    systemText,
    prepared,
    true
  );

  const init: RequestInit = {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(body),
  };

  const response = await withRetry(
    () => postStream(config.endpoint, init),
    "streamChat"
  );

  for await (const event of readSseEvents(response)) {
    const delta = parseStreamEvent(config.provider, event);

    if (delta.error) {
      throw new AppError(
        `LLM stream error: ${delta.error}`,
        502
      );
    }

    if (delta.text) {
      yield delta.text;
    }

    if (delta.done) {
      return;
    }
  }
}
