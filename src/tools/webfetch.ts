/** WebFetch: retrieve a URL and convert HTML into readable text. */

import { style } from "../util/color.js";
import type { Tool, ToolResult } from "./types.js";
import { asObject, optionalNumber, optionalString, requireString, ToolInputError } from "./types.js";

const MAX_CHARS = 60_000;
const USER_AGENT = `aet/1.0 (+https://github.com/faizcasm/ai-engineering-team)`;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "\u2014",
  ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d",
  ldquo: "\u201c", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isNaN(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-6])[^>]*>/gi, "\n## ")
    .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, " [$1] ")
    .replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ");

  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: Tool = {
  spec: {
    name: "WebFetch",
    description:
      "Fetch an http/https URL and return its content as readable text (HTML is converted to plain text). " +
      "Use for documentation, issues, RFCs and API references.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        prompt: { type: "string", description: "What to extract from the page (recorded for context)" },
        max_chars: { type: "number", description: `Truncate after N characters (default ${MAX_CHARS})` },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const url = requireString(input, "url");
    const prompt = optionalString(input, "prompt");
    const maxChars = optionalNumber(input, "max_chars") ?? MAX_CHARS;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolInputError(`invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ToolInputError(`only http/https URLs are allowed (got ${parsed.protocol})`);
    }

    ctx.emit({ type: "progress", text: url });

    const response = await fetch(parsed, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: ctx.signal,
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    if (!response.ok) {
      return { output: `HTTP ${response.status} ${response.statusText} for ${url}\n${raw.slice(0, 2000)}`, isError: true };
    }

    const body = contentType.includes("html") ? htmlToText(raw) : raw;
    const truncated = body.length > maxChars;
    const content = truncated ? `${body.slice(0, maxChars)}\n\u2026 [truncated ${body.length - maxChars} chars]` : body;
    const header = `# ${parsed.href}\nStatus: ${response.status} | Type: ${contentType || "unknown"} | ${body.length} chars${prompt ? `\nRequested: ${prompt}` : ""}`;
    return {
      output: `${header}\n\n${content}`,
      display: `${style.muted(parsed.hostname)} \u00b7 ${response.status} \u00b7 ${body.length} chars`,
      meta: { url: parsed.href, status: response.status, chars: body.length },
    };
  },
};
