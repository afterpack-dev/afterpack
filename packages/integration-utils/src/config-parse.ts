import {
  type AfterpackConfig,
  CONFIG_BY_PATH,
  type ConfigIssue,
  type ConfigKeyDef,
  canonicalSpelling,
  checkValue,
  DOCS_URL,
  EMPTY_CONFIG,
  groupBooleanKey,
  mergeConfig,
  misdirectedHint,
  nest,
  suggestKey,
  unknownKeyMessage,
} from "./registry.js";

export const ENV_PREFIX = "AFTERPACK_";

type ParseSurface = "cli" | "env" | "directive";

export function splitAssignment(token: string): { key: string; value: string | true } {
  const eq = token.indexOf("=");
  if (eq < 0) return { key: token, value: true };
  return { key: token.slice(0, eq), value: token.slice(eq + 1) };
}

function parseScalarLiteral(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseListLiteral(
  raw: string,
): { items: unknown[] } | { empty: true } | { json: unknown[] } {
  const whole = parseScalarLiteral(raw);
  if (Array.isArray(whole)) return { json: whole };
  if (raw.trim() === "") return { items: [] };
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) return { empty: true };
  return { items: parts.map(parseScalarLiteral) };
}

function spellKey(path: string, surface: ParseSurface): string {
  if (surface === "cli") return `--${path}`;
  if (surface === "env") return `${ENV_PREFIX}${path.replace(/\./g, "_")}`;
  return path;
}

function surfaceLabel(surface: ParseSurface): string {
  if (surface === "cli") return "command line";
  if (surface === "env") return "environment";
  return "directive";
}

function fileFormCta(key: ConfigKeyDef): string {
  return key.configFileForm ?? `{ "${key.path.split(".").join('": { "')}": … }`;
}

function structuredIssue(key: ConfigKeyDef, surface: ParseSurface): ConfigIssue {
  return {
    path: key.path,
    message:
      `\`${key.path}\` is an object and cannot be written on the ${surfaceLabel(surface)}. ` +
      `Move it to afterpack.json: ${fileFormCta(key)}`,
  };
}

function objectItemIssue(key: ConfigKeyDef, surface: ParseSurface): ConfigIssue {
  return {
    path: key.path,
    message:
      `\`${key.path}\` takes plain comma-separated values on the ${surfaceLabel(surface)}; ` +
      `an object item must move to afterpack.json: ${fileFormCta(key)}`,
  };
}

function jsonArrayIssue(key: ConfigKeyDef, items: unknown[], surface: ParseSurface): ConfigIssue {
  const flat = items.every((v) => v !== null && typeof v !== "object");
  const spelled = spellKey(key.path, surface);
  const how = flat
    ? `write \`${spelled}=${items.map(String).join(",")}\`${items.length === 0 ? " for an empty list" : ""}`
    : key.shape === "mixedList"
      ? `an object item must move to afterpack.json: ${fileFormCta(key)}`
      : `write \`${spelled}=<value>,<value>\``;
  return {
    path: key.path,
    message:
      `\`${key.path}\` takes comma-separated values on the ${surfaceLabel(surface)}, ` +
      `not a JSON array — ${how}`,
  };
}

function spaceFormIssue(path: string, raw: string, surface: ParseSurface): ConfigIssue {
  const spelled = spellKey(path, surface);
  return {
    path,
    message:
      `\`${spelled} ${raw}\` is not a flag — the space-separated form was removed; ` +
      `write \`${spelled}=${raw}\``,
  };
}

function kebabIssue(key: string, surface: ParseSurface): ConfigIssue {
  const suggestion = suggestKey(key);
  const canonical = suggestion
    ? ` — the canonical form is \`${spellKey(suggestion, surface)}\``
    : " — keys are dot-delimited camelCase";
  return {
    path: key,
    message: `kebab-case is not a configuration key (\`${spellKey(key, surface)}\`)${canonical}`,
  };
}

interface Assignment {
  path: string;
  value: unknown;
}

function parseAssignment(
  key: string,
  raw: string | true,
  surface: ParseSurface,
): { assignment: Assignment } | { issue: ConfigIssue } {
  const spaced = raw === true ? /^(\S+)[ \t]+(.+)$/.exec(key) : null;
  const head = spaced ? CONFIG_BY_PATH.get(spaced[1]) : undefined;
  if (spaced && head) {
    return {
      issue:
        head.shape === "structured"
          ? structuredIssue(head, surface)
          : spaceFormIssue(head.path, spaced[2], surface),
    };
  }
  if (key.includes("-")) return { issue: kebabIssue(key, surface) };
  const grouped = CONFIG_BY_PATH.has(key) ? undefined : groupBooleanKey(key);
  const boolish = raw === true || typeof parseScalarLiteral(raw) === "boolean";
  const path = grouped && boolish ? grouped.path : key;
  const def = CONFIG_BY_PATH.get(path);
  if (!def) {
    return { issue: { path: key, message: unknownKeyMessage(key, surfaceLabel(surface)) } };
  }
  if (def.shape === "structured") return { issue: structuredIssue(def, surface) };
  if (raw === true) {
    const failure = checkValue(def, true);
    return failure
      ? { issue: { path: key, message: `${failure} (${surfaceLabel(surface)})` } }
      : { assignment: { path, value: true } };
  }
  if (def.shape === "mixedList" && raw.includes("{")) {
    return { issue: objectItemIssue(def, surface) };
  }
  let value: unknown;
  if (def.shape === "scalar") {
    value = parseScalarLiteral(raw);
  } else {
    const parsed = parseListLiteral(raw);
    if ("json" in parsed) return { issue: jsonArrayIssue(def, parsed.json, surface) };
    if ("empty" in parsed) {
      return {
        issue: {
          path: key,
          message:
            `\`${key}\` has an empty item in its comma-separated value (${surfaceLabel(surface)}) — ` +
            "write the items with no stray comma, or omit the key entirely",
        },
      };
    }
    value = parsed.items;
  }
  const failure = checkValue(def, value);
  if (failure) {
    const hint = misdirectedHint(def, value, (p, v) => `${spellKey(p, surface)}=${v}`);
    return { issue: { path: key, message: `${failure} (${surfaceLabel(surface)})${hint}` } };
  }
  return { assignment: { path, value } };
}

function collect(assignments: Assignment[]): AfterpackConfig {
  let config = EMPTY_CONFIG;
  for (const a of assignments) {
    config = mergeConfig(config, nest(a.path, a.value) as AfterpackConfig);
  }
  return config;
}

export interface CliParseResult {
  config: AfterpackConfig;
  positionals: string[];
  help: boolean;
  version: boolean;
  issues: ConfigIssue[];
}

export function parseCliOptions(argv: string[]): CliParseResult {
  const assignments: Assignment[] = [];
  const issues: ConfigIssue[] = [];
  const positionals: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--help") {
      help = true;
      continue;
    }
    if (token === "--version") {
      version = true;
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      issues.push({
        path: token,
        message: `\`${token}\` is not a flag — every option is written \`--key=value\` (no short flags)`,
      });
      continue;
    }
    const { key, value } = splitAssignment(token.slice(2));

    const def = value === true ? CONFIG_BY_PATH.get(key) : undefined;
    const next = argv[i + 1];
    if (
      def !== undefined &&
      def.shape !== "structured" &&
      next !== undefined &&
      !next.startsWith("-") &&
      checkValue(def, true) !== undefined
    ) {
      issues.push(spaceFormIssue(key, next, "cli"));
      const retry = parseAssignment(key, next, "cli");
      if ("issue" in retry) issues.push(retry.issue);
      i++;
      continue;
    }

    const parsed = parseAssignment(key, value, "cli");
    if ("issue" in parsed) issues.push(parsed.issue);
    else assignments.push(parsed.assignment);
  }

  return { config: collect(assignments), positionals, help, version, issues };
}

export const LIVE_SCREAMING_ENV: ReadonlySet<string> = new Set(["SEED", "KEY"]);

function screamingIssue(name: string, suffix: string): ConfigIssue {
  const dotted = suffix.replace(/_/g, ".");
  const envForm = (path: string): string => `${ENV_PREFIX}${path.replace(/\./g, "_")}`;
  const spelling = canonicalSpelling(dotted);
  let tail = `see ${DOCS_URL}`;
  if (spelling && "key" in spelling) tail = `write \`${envForm(spelling.key)}\``;
  else if (spelling && spelling.group.length === 1)
    tail = `write \`${envForm(spelling.group[0])}\``;
  else if (spelling) {
    tail = `its keys are ${spelling.group.map((k) => `\`${envForm(k)}\``).join(", ")}`;
  }
  return {
    path: suffix,
    message:
      `\`${name}\` is not a configuration variable — an AfterPack variable spells its key ` +
      `exactly, dots as underscores and case preserved: ${tail}`,
  };
}

function isReservedEnvSuffix(suffix: string): boolean {
  if (/[a-z]/.test(suffix)) return false;
  const dotted = suffix.replace(/_/g, ".");
  return LIVE_SCREAMING_ENV.has(suffix) || canonicalSpelling(dotted) === undefined;
}

export interface EnvParseResult {
  config: AfterpackConfig;
  issues: ConfigIssue[];
}

export function parseEnvOptions(env: Record<string, string | undefined>): EnvParseResult {
  const assignments: Assignment[] = [];
  const issues: ConfigIssue[] = [];

  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const suffix = name.slice(ENV_PREFIX.length);
    if (suffix === "" || isReservedEnvSuffix(suffix)) continue;
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/[a-z]/.test(suffix)) {
      issues.push(screamingIssue(name, suffix));
      continue;
    }
    const parsed = parseAssignment(suffix.replace(/_/g, "."), raw, "env");
    if ("issue" in parsed) issues.push(parsed.issue);
    else assignments.push(parsed.assignment);
  }

  return { config: collect(assignments), issues };
}
