/** Dependency-free argv parser with a spec that also drives --help. */

export interface OptionSpec {
  /** Long name, without leading dashes. */
  name: string;
  /** Optional single-character alias. */
  short?: string;
  type: "string" | "boolean" | "number";
  description: string;
  /** Allowed values for string options. */
  values?: string[];
  /** Placeholder shown in help, e.g. `<model>`. */
  placeholder?: string;
  /** Option may be given without a value (stores an empty string). */
  optional?: boolean;
  default?: string | number | boolean;
}

export interface ParsedArgs {
  options: Record<string, string | number | boolean>;
  positionals: string[];
  /** Unrecognised flags (reported to the user). */
  unknown: string[];
  /** Everything after a literal `--`. */
  passthrough: string[];
}

export interface ParseOptions {
  /**
   * Keep unrecognised flags in `positionals` instead of `unknown`.
   * Used when parsing the arguments *after* a subcommand, where flags such as
   * `aet mcp add fs npx -y <pkg>` belong to the inner command, not to aet.
   */
  keepUnknown?: boolean;
}

/**
 * Split argv at the first token naming a subcommand, so the head (global
 * options) and the tail (subcommand arguments) can be parsed independently.
 */
export function splitAtCommand(
  argv: string[],
  specs: OptionSpec[],
  commandNames: ReadonlyArray<string>,
): { head: string[]; command?: string; tail: string[] } {
  const byLong = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byLong.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const spec = byLong.get(name);
      if (spec && spec.type !== "boolean" && eq === -1) {
        const next = argv[index + 1];
        if (next !== undefined && !(spec.optional && next.startsWith("-"))) index += 1;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      const spec = byShort.get(eq === -1 ? body : body.slice(0, eq));
      if (spec && spec.type !== "boolean" && eq === -1 && argv[index + 1] !== undefined) index += 1;
      continue;
    }

    // First bare word: a subcommand or just a prompt.
    if (commandNames.includes(token)) {
      return { head: argv.slice(0, index), command: token, tail: argv.slice(index + 1) };
    }
    break;
  }
  return { head: argv, tail: [] };
}

export function parseArgs(argv: string[], specs: OptionSpec[], parseOptions: ParseOptions = {}): ParsedArgs {
  const options: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];
  const passthrough: string[] = [];

  const byLong = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byLong.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  const coerce = (spec: OptionSpec, raw: string): string | number | boolean => {
    if (spec.type === "number") {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`--${spec.name} expects a number, got "${raw}"`);
      return value;
    }
    if (spec.type === "boolean") return raw !== "false" && raw !== "0";
    if (spec.values && !spec.values.includes(raw)) {
      throw new Error(`--${spec.name} must be one of: ${spec.values.join(", ")} (got "${raw}")`);
    }
    return raw;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const spec = byLong.get(rawName);
      if (!spec) {
        if (parseOptions.keepUnknown) positionals.push(token);
        else unknown.push(token);
        continue;
      }
      if (spec.type === "boolean" && eq === -1) {
        options[spec.name] = true;
        continue;
      }
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const next = argv[index + 1];
      if (inlineValue === undefined && (next === undefined || (spec.optional && next.startsWith("-")))) {
        if (!spec.optional) throw new Error(`--${spec.name} requires a value`);
        options[spec.name] = "";
        continue;
      }
      const value = inlineValue ?? argv[++index];
      if (value === undefined) throw new Error(`--${spec.name} requires a value`);
      options[spec.name] = coerce(spec, value);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const spec = byShort.get(rawName);
      if (!spec) {
        if (parseOptions.keepUnknown) positionals.push(token);
        else unknown.push(token);
        continue;
      }
      if (spec.type === "boolean" && eq === -1) {
        options[spec.name] = true;
        continue;
      }
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      const value = inlineValue ?? argv[++index];
      if (value === undefined) throw new Error(`-${rawName} requires a value`);
      options[spec.name] = coerce(spec, value);
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals, unknown, passthrough };
}

export function optionString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

export function optionNumber(args: ParsedArgs, name: string): number | undefined {
  const value = args.options[name];
  return typeof value === "number" ? value : undefined;
}

export function optionBool(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}
