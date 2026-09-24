import type { AfterpackArtifactOptions, Preset, RegionConfig, TransformKind } from "./policy.js";

export type ConfigScope = "program" | "region";
export type ConfigTier = "free" | "pro";

export type ConfigSurface = "engine" | "build" | "cli";

export type ValueShape = "scalar" | "list" | "mixedList" | "structured";

export type ValueType =
  | { readonly kind: "boolean" }
  | { readonly kind: "number"; readonly min: number; readonly integer?: true }
  | { readonly kind: "unbounded"; readonly min: number; readonly unlimited: string }
  | { readonly kind: "string" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "seed" }
  | { readonly kind: "reserved" }
  | { readonly kind: "region" };

export interface GlobReserved {
  glob: string;
  names: string[];
}

export interface ConfigKeyDef {
  readonly path: string;
  readonly shape: ValueShape;
  readonly scope: ConfigScope;
  readonly tier: ConfigTier;
  readonly surface: ConfigSurface;
  readonly item: ValueType;
  readonly default: string;
  readonly configFileForm?: string;
  readonly namedValuesOf?: string;
}

export const PRESET_VALUES = ["minify", "light", "medium", "hard", "extreme"] as const;

export const TRANSFORM_KIND_VALUES = [
  "stringEncoding",
  "controlFlowFlatten",
  "opaquePredicate",
  "mixedBooleanArithmetic",
  "integerBytecode",
  "crossDependency",
  "scopeDeepen",
  "comparisonHardening",
  "selfIntegrity",
  "objectConstruction",
] as const;

const REFLECTION_ALLOW_VALUES = [
  "functionToString",
  "nameIntrospection",
  "argumentsCallee",
  "prototypeChain",
  "decoratorMetadata",
  "constructorIntrospection",
  "angular",
  "nestjs",
] as const;

export const BUILD_MODE_VALUES = ["production", "development"] as const;

export type BuildMode = (typeof BUILD_MODE_VALUES)[number];

const UNLIMITED = "unlimited";

export const DIRECTIVES_ENABLED_DEFAULT = true;

const RESERVED_FILE_FORM = '{ "identifiers": { "reserved": [{ "glob": "…", "names": ["…"] }] } }';
const REGIONS_FILE_FORM = '{ "regions": [{ "start": 0, "end": 100, "complexity": 40 }] }';

export const CONFIG_KEYS = [
  {
    path: "seed",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "seed" },
    default: "a new random seed per build",
  },
  {
    path: "preset",
    shape: "scalar",
    scope: "region",
    tier: "free",
    surface: "engine",
    item: { kind: "enum", values: PRESET_VALUES },
    default: "light",
  },
  {
    path: "complexity",
    shape: "scalar",
    scope: "region",
    tier: "free",
    surface: "engine",
    item: { kind: "number", min: 0 },
    default: "the preset's value; light is 2",
    namedValuesOf: "preset",
  },
  {
    path: "inflation.max",
    shape: "scalar",
    scope: "region",
    tier: "free",
    surface: "engine",
    item: { kind: "unbounded", min: 0, unlimited: UNLIMITED },
    default: "the preset's output-size ladder: 1.2 / 2 / 2.5 / 4 / 7",
  },
  {
    path: "strings.encode",
    shape: "scalar",
    scope: "region",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true at any positive complexity; false at 0",
  },
  {
    path: "strings.minLength",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "number", min: 0, integer: true },
    default: "0",
  },
  {
    path: "strings.leaks.max",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "number", min: 0, integer: true },
    default: "unset; the count is reported but never fails a build",
  },
  {
    path: "strings.preserveLiterals",
    shape: "list",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "string" },
    default: "[]",
  },
  {
    path: "paths.include",
    shape: "list",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "string" },
    default: "[]",
  },
  {
    path: "paths.exclude",
    shape: "list",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "string" },
    default: "[]",
  },
  {
    path: "identifiers.rename",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "identifiers.globals.rename",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "false",
  },
  {
    path: "identifiers.reserved",
    shape: "mixedList",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "reserved" },
    default: "[]",
    configFileForm: RESERVED_FILE_FORM,
  },
  {
    path: "identifiers.methods.rename",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "reflection.allow",
    shape: "list",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "enum", values: REFLECTION_ALLOW_VALUES },
    default: "[]",
  },
  {
    path: "sourceMap.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true in development when an input map exists; false in production",
  },
  {
    path: "sourceMap.sourcesContent",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true in development; false in production",
  },
  {
    path: "sourceMap.emitUrl",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "true in development; false in production",
  },
  {
    path: "protectionMap.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true when the bundler emitted a source map",
  },
  {
    path: "protectionMap.detailed",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "regions",
    shape: "structured",
    scope: "program",
    tier: "pro",
    surface: "engine",
    item: { kind: "region" },
    default: "[]",
    configFileForm: REGIONS_FILE_FORM,
  },
  {
    path: "transforms.controlFlowFlatten.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.opaquePredicate.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.mixedBooleanArithmetic.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.integerBytecode.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.crossDependency.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.scopeDeepen.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.objectConstruction.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "engine",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "transforms.comparisonHardening.enabled",
    shape: "scalar",
    scope: "program",
    tier: "pro",
    surface: "engine",
    item: { kind: "boolean" },
    default: "false",
  },
  {
    path: "transforms.selfIntegrity.enabled",
    shape: "scalar",
    scope: "program",
    tier: "pro",
    surface: "engine",
    item: { kind: "boolean" },
    default: "false",
  },
  {
    path: "build.backup",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "false for an in-place pass; true standalone",
  },
  {
    path: "build.autorun",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "build.mode",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "enum", values: BUILD_MODE_VALUES },
    default: "detected from the environment",
  },
  {
    path: "directives.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "diagnostics.level",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "enum", values: ["summary", "all", "none"] },
    default: "summary",
  },
  {
    path: "diagnostics.format",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "cli",
    item: { kind: "enum", values: ["text", "json"] },
    default: "text",
  },
  {
    path: "telemetry.enabled",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "true",
  },
  {
    path: "allowUnobfuscated",
    shape: "scalar",
    scope: "program",
    tier: "free",
    surface: "build",
    item: { kind: "boolean" },
    default: "false",
  },
  {
    path: "key",
    shape: "scalar",
    scope: "program",
    tier: "pro",
    surface: "build",
    item: { kind: "string" },
    default: "unset; builds run locally with basic protection",
  },
] as const satisfies readonly ConfigKeyDef[];

type Registry = (typeof CONFIG_KEYS)[number];

type ItemTs<I> = I extends { kind: "boolean" }
  ? boolean
  : I extends { kind: "number" }
    ? number
    : I extends { kind: "unbounded"; unlimited: infer U }
      ? number | U
      : I extends { kind: "enum"; values: readonly (infer V)[] }
        ? V
        : I extends { kind: "seed" }
          ? number | string
          : I extends { kind: "reserved" }
            ? string | GlobReserved
            : I extends { kind: "region" }
              ? RegionConfig
              : I extends { kind: "string" }
                ? string
                : never;

type KeyTs<K extends ConfigKeyDef> = K["shape"] extends "scalar"
  ? ItemTs<K["item"]>
  : ItemTs<K["item"]>[];

type Nest<P extends string, V> = P extends `${infer Head}.${infer Rest}`
  ? { [X in Head]?: Nest<Rest, V> }
  : { [X in P]?: V };

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type Collapse<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]: Collapse<T[K]> } | ("enabled" extends keyof T ? boolean : never)
    : T;

type NestOf<K> = K extends ConfigKeyDef ? Nest<K["path"], KeyTs<K>> : never;

export type AfterpackConfig = Collapse<UnionToIntersection<NestOf<Registry>>>;

export const EMPTY_CONFIG = {} as AfterpackConfig;

export const CONFIG_BY_PATH: ReadonlyMap<string, ConfigKeyDef> = new Map(
  CONFIG_KEYS.map((k) => [k.path, k as ConfigKeyDef]),
);

export const CONFIG_PREFIXES: ReadonlySet<string> = new Set(
  CONFIG_KEYS.flatMap((k) => {
    const parts = k.path.split(".");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
  }),
);

const CONFIG_CHILDREN: ReadonlyMap<string, readonly string[]> = new Map(
  [...CONFIG_PREFIXES].map((prefix) => [
    prefix,
    CONFIG_KEYS.filter((k) => k.path.startsWith(`${prefix}.`)).map((k) => k.path),
  ]),
);

const BY_NORMALIZED: ReadonlyMap<string, ConfigKeyDef> = new Map(
  CONFIG_KEYS.map((k) => [normalizeKey(k.path), k as ConfigKeyDef]),
);

const CHILDREN_BY_NORMALIZED: ReadonlyMap<string, readonly string[]> = new Map(
  [...CONFIG_CHILDREN].map(([prefix, children]) => [normalizeKey(prefix), children]),
);

const PREFIX_BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  [...CONFIG_PREFIXES].map((prefix) => [normalizeKey(prefix), prefix]),
);

function normalizeKey(key: string): string {
  return key.replace(/[-_.]/g, "").toLowerCase();
}

export function groupBooleanKey(path: string): ConfigKeyDef | undefined {
  if (!CONFIG_PREFIXES.has(path)) return undefined;
  return CONFIG_BY_PATH.get(`${path}.enabled`);
}

function nearestName(name: string, candidates: readonly string[]): string | undefined {
  const target = normalizeKey(name);
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(target, normalizeKey(candidate));
    if (distance > Math.max(2, Math.floor(target.length / 4))) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best?.name;
}

export function suggestKey(key: string): string | undefined {
  const exact = BY_NORMALIZED.get(normalizeKey(key));
  if (exact) return exact.path;
  const near = nearestName(
    key,
    CONFIG_KEYS.map((k) => k.path),
  );
  if (near) return near;
  const tail = normalizeKey(key);
  const owners = CONFIG_KEYS.filter(
    (k) => normalizeKey(k.path.slice(k.path.lastIndexOf(".") + 1)) === tail,
  );
  return owners.length === 1 ? owners[0].path : undefined;
}

export function canonicalSpelling(
  name: string,
): { key: string } | { group: readonly string[] } | undefined {
  const norm = normalizeKey(name);
  const key = BY_NORMALIZED.get(norm);
  if (key) return { key: key.path };
  const group = CHILDREN_BY_NORMALIZED.get(norm);
  return group && group.length > 0 ? { group } : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export const DOCS_URL = "https://www.afterpack.dev/docs/config";

export function unknownKeyMessage(path: string, surface: string): string {
  const group = CHILDREN_BY_NORMALIZED.get(normalizeKey(path));
  if (group && group.length > 0) {
    const list = group.map((child) => `\`${child}\``).join(", ");
    const tail = group.length === 1 ? `did you mean ${list}?` : `its keys are ${list}`;
    const canonical = PREFIX_BY_NORMALIZED.get(normalizeKey(path));
    const enabled = canonical ? groupBooleanKey(canonical) : undefined;
    const rule = enabled ? `; a boolean here means \`${enabled.path}\`` : "";
    return `\`${path}\` is a group of configuration keys, not a key itself (${surface}) — ${tail}${rule}`;
  }
  const suggestion = suggestKey(path);
  const tail = suggestion ? ` — did you mean \`${suggestion}\`?` : ` — see ${DOCS_URL}`;
  return `unknown configuration key \`${path}\` (${surface})${tail}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(item: ValueType): string {
  switch (item.kind) {
    case "boolean":
      return "true or false";
    case "number":
      return item.integer ? `an integer >= ${item.min}` : `a number >= ${item.min}`;
    case "unbounded":
      return `a number >= ${item.min}, or the string "${item.unlimited}"`;
    case "string":
      return "a string";
    case "enum":
      return `one of: ${item.values.join(", ")}`;
    case "seed":
      return 'a number, any string, or "git"';
    case "reserved":
      return 'a name, or { "glob": "…", "names": ["…"] }';
    case "region":
      return "an object with numeric `start` and `end`";
  }
}

export function misdirectedHint(
  key: ConfigKeyDef,
  value: unknown,
  spell: (path: string, value: string) => string,
): string {
  const other = misdirectedTo(key, value);
  if (!other) return "";
  const written = spell(other.path, String(value));
  return ` — \`${String(value)}\` is a \`${other.path}\` value; write \`${written}\` instead`;
}

interface FieldSpec {
  readonly required?: true;
  readonly is: (value: unknown) => boolean;
  readonly want: string;
  readonly fields?: Readonly<Record<string, FieldSpec>>;
}

const isFiniteNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isTransformKinds = (v: unknown): boolean =>
  Array.isArray(v) && v.every((k) => (TRANSFORM_KIND_VALUES as readonly string[]).includes(k));

const KINDS = `a list of: ${TRANSFORM_KIND_VALUES.join(", ")}`;

const isNonNegative = (v: unknown): boolean => isFiniteNumber(v) && (v as number) >= 0;

function group(fields: Readonly<Record<string, FieldSpec>>): FieldSpec {
  return { is: isPlainObject, want: "an object", fields };
}

const REGION_FIELDS: Readonly<Record<string, FieldSpec>> = {
  start: { required: true, is: isFiniteNumber, want: "a number" },
  end: { required: true, is: isFiniteNumber, want: "a number" },
  complexity: { is: isNonNegative, want: "a number >= 0" },
  inflation: group({ max: { is: isNonNegative, want: "a number >= 0" } }),
  strings: group({ encode: { is: (v) => typeof v === "boolean", want: "true or false" } }),
  transforms: group({
    only: { is: isTransformKinds, want: KINDS },
    deny: { is: isTransformKinds, want: KINDS },
  }),
  label: { is: (v) => typeof v === "string", want: "a string" },
};

const RESERVED_FIELDS: Readonly<Record<string, FieldSpec>> = {
  glob: { required: true, is: (v) => typeof v === "string", want: "a string" },
  names: {
    required: true,
    is: (v) => Array.isArray(v) && v.every((n) => typeof n === "string"),
    want: "a list of names",
  },
};

function leafNames(spec: Readonly<Record<string, FieldSpec>>, prefix: string): string[] {
  return Object.entries(spec).flatMap(([name, field]) =>
    field.fields ? leafNames(field.fields, `${prefix}${name}.`) : [prefix + name],
  );
}

function checkFields(
  spec: Readonly<Record<string, FieldSpec>>,
  value: Record<string, unknown>,
  prefix = "",
): string | undefined {
  for (const name of Object.keys(value)) {
    if (name in spec) continue;
    const near = nearestName(
      prefix + name,
      Object.keys(spec).map((n) => prefix + n),
    );
    return (
      `item has an unknown field \`${prefix}${name}\`` +
      (near ? ` — did you mean \`${near}\`?` : "") +
      ` (allowed: ${leafNames(spec, prefix).join(", ")})`
    );
  }
  for (const [name, field] of Object.entries(spec)) {
    const present = value[name];
    if (present === undefined) {
      if (field.required) return `item is missing \`${prefix}${name}\` (${field.want})`;
      continue;
    }
    if (!field.is(present)) {
      return `item's \`${prefix}${name}\` must be ${field.want}, got ${JSON.stringify(present)}`;
    }
    if (field.fields) {
      const nested = checkFields(
        field.fields,
        present as Record<string, unknown>,
        `${prefix}${name}.`,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

function expected(item: ValueType, value: unknown): string {
  return `expected ${describe(item)}, got ${JSON.stringify(value)}`;
}

export function checkItem(item: ValueType, value: unknown): string | undefined {
  switch (item.kind) {
    case "boolean":
      return typeof value === "boolean" ? undefined : expected(item, value);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return expected(item, value);
      if (value < item.min) return expected(item, value);
      if (item.integer && !Number.isInteger(value)) return expected(item, value);
      return undefined;
    }
    case "unbounded": {
      if (value === item.unlimited) return undefined;
      if (typeof value === "number" && Number.isFinite(value) && value >= item.min)
        return undefined;
      return `${expected(item, value)} — there is no \`Infinity\` in JSON; write "${item.unlimited}"`;
    }
    case "string":
      return typeof value === "string" ? undefined : expected(item, value);
    case "enum":
      return typeof value === "string" && (item.values as readonly string[]).includes(value)
        ? undefined
        : expected(item, value);
    case "seed":
      return typeof value === "number" || typeof value === "string"
        ? undefined
        : expected(item, value);
    case "reserved": {
      if (typeof value === "string") return undefined;
      if (!isPlainObject(value)) return expected(item, value);
      return checkFields(RESERVED_FIELDS, value);
    }
    case "region": {
      if (!isPlainObject(value)) return expected(item, value);
      return checkFields(REGION_FIELDS, value);
    }
  }
}

export function checkValue(key: ConfigKeyDef, value: unknown): string | undefined {
  if (key.shape === "scalar") {
    const failure = checkItem(key.item, value);
    return failure ? `\`${key.path}\`: ${failure}` : undefined;
  }
  if (!Array.isArray(value)) {
    return `\`${key.path}\`: expected a list of values, got ${JSON.stringify(value)}`;
  }
  for (const entry of value) {
    const failure = checkItem(key.item, entry);
    if (failure) return `\`${key.path}\`: ${failure}`;
  }
  return undefined;
}

export function misdirectedTo(key: ConfigKeyDef, value: unknown): ConfigKeyDef | undefined {
  if (key.namedValuesOf === undefined || typeof value !== "string") return undefined;
  const other = CONFIG_BY_PATH.get(key.namedValuesOf);
  if (!other || other.shape !== "scalar") return undefined;
  return checkItem(other.item, value) === undefined ? other : undefined;
}

export interface ValidationResult {
  config: AfterpackConfig;
  issues: ConfigIssue[];
}

export function validateConfig(input: unknown, surface: string): ValidationResult {
  const issues: ConfigIssue[] = [];
  const config: Record<string, unknown> = {};
  if (input === undefined || input === null) return { config: config as AfterpackConfig, issues };
  if (!isPlainObject(input)) {
    issues.push({ path: "", message: `configuration (${surface}) must be an object` });
    return { config: config as AfterpackConfig, issues };
  }
  walk(input, "", config, issues, surface);
  return { config: config as AfterpackConfig, issues };
}

function walk(
  source: Record<string, unknown>,
  prefix: string,
  target: Record<string, unknown>,
  issues: ConfigIssue[],
  surface: string,
): void {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const key = CONFIG_BY_PATH.get(path);
    if (key) {
      const failure = checkValue(key, value);
      if (failure) {
        const hint = misdirectedHint(key, value, (p, v) => `"${p}": ${JSON.stringify(v)}`);
        issues.push({ path, message: `${failure} (${surface})${hint}` });
      } else target[name] = value;
      continue;
    }
    if (CONFIG_PREFIXES.has(path)) {
      if (isPlainObject(value)) {
        const nested: Record<string, unknown> = {};
        walk(value, path, nested, issues, surface);
        if (Object.keys(nested).length > 0) target[name] = nested;
        continue;
      }
      const enabled = groupBooleanKey(path);
      if (enabled && typeof value === "boolean") {
        target[name] = { enabled: value };
        continue;
      }
    }
    issues.push({ path, message: unknownKeyMessage(path, surface) });
  }
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [name, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[name];
    out[name] =
      isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : value;
  }
  return out;
}

export function mergeInto<T>(base: Record<string, unknown>, override: Record<string, unknown>): T {
  return deepMerge(base, override) as unknown as T;
}

export function mergeConfig(base: AfterpackConfig, override: AfterpackConfig): AfterpackConfig {
  return deepMerge(
    base as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as AfterpackConfig;
}

export function getPath(config: AfterpackConfig, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function nest(path: string, value: unknown): Record<string, unknown> {
  return path
    .split(".")
    .reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), value) as Record<
    string,
    unknown
  >;
}

export type ReflectionAllow = (typeof REFLECTION_ALLOW_VALUES)[number];

export interface CoreConfigSubset {
  seed?: number | string;
  preset?: Preset;
  complexity?: number;
  inflation?: { max?: number | "unlimited" };
  strings?: {
    encode?: boolean;
    minLength?: number;
    leaks?: { max?: number };
    preserveLiterals?: string[];
  };
  paths?: { exclude?: string[] };
  identifiers?: {
    rename?: boolean;
    reserved?: (string | GlobReserved)[];
    globals?: { rename?: boolean };
    methods?: { rename?: boolean };
  };
  reflection?: { allow?: ReflectionAllow[] };
  sourceMap?: { enabled?: boolean; sourcesContent?: boolean };
  protectionMap?: { enabled?: boolean; detailed?: boolean };
  regions?: RegionConfig[];
  transforms?: Partial<Record<TransformKind, { enabled?: boolean }>>;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

export function toEngineConfig(config: AfterpackConfig): CoreConfigSubset {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (key.surface !== "engine") continue;
    const value = getPath(config, key.path);
    if (value === undefined) continue;
    setPath(out, key.path, value);
  }
  return out as CoreConfigSubset;
}

export interface PluginOptionsView {
  artifactOptions: AfterpackArtifactOptions;
  seed?: number | string;
  preset?: Preset;
  complexity?: number;
  regions?: RegionConfig[];
  directives: { enabled: boolean; explicit: boolean };
  build?: { autorun?: boolean };
  diagnostics?: { level?: "summary" | "all" | "none"; format?: "text" | "json" };
  paths?: { include?: string[] };
  key?: string;
}

export function toPluginOptions(config: AfterpackConfig): PluginOptionsView {
  const read = <T>(path: string): T | undefined => getPath(config, path) as T | undefined;
  const set = <T extends object>(container: T): T | undefined =>
    Object.values(container).some((v) => v !== undefined) ? container : undefined;
  return {
    artifactOptions: {
      protectionMap: set({ enabled: read<boolean>("protectionMap.enabled") }),
      sourceMap: set({
        enabled: read<boolean>("sourceMap.enabled"),
        emitUrl: read<boolean>("sourceMap.emitUrl"),
      }),
      build: set({ backup: read<boolean>("build.backup"), mode: read<BuildMode>("build.mode") }),
      allowUnobfuscated: read<boolean>("allowUnobfuscated"),
      telemetry: set({ enabled: read<boolean>("telemetry.enabled") }),
    },
    seed: read<number | string>("seed"),
    preset: read<Preset>("preset"),
    complexity: read<number>("complexity"),
    regions: read<RegionConfig[]>("regions"),
    directives: {
      enabled: read<boolean>("directives.enabled") ?? DIRECTIVES_ENABLED_DEFAULT,
      explicit: read<boolean>("directives.enabled") !== undefined,
    },
    build: set({ autorun: read<boolean>("build.autorun") }),
    diagnostics: set({
      level: read<"summary" | "all" | "none">("diagnostics.level"),
      format: read<"text" | "json">("diagnostics.format"),
    }),
    paths: set({ include: read<string[]>("paths.include") }),
    key: read<string>("key"),
  };
}
