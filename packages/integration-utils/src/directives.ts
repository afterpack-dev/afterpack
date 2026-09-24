import { splitAssignment } from "./config-parse.js";
import { PRESETS, presetTarget, type RegionConfig, type TransformKind } from "./policy.js";
import { TRANSFORM_KIND_VALUES } from "./registry.js";

type RegionDelta = Pick<RegionConfig, "target" | "max" | "floor" | "only" | "deny">;

const KIND_BY_LOWER = new Map<string, TransformKind>(
  TRANSFORM_KIND_VALUES.map((k) => [k.toLowerCase(), k]),
);

function parseKindList(value: string): { kinds?: TransformKind[]; error?: string } {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: "empty transform-kind list" };
  const kinds: TransformKind[] = [];
  for (const p of parts) {
    const k = KIND_BY_LOWER.get(p.toLowerCase());
    if (!k) return { error: `unknown transform kind \`${p}\`` };
    kinds.push(k);
  }
  return { kinds };
}

export interface CapturedDirective {
  keyword: string;
  form: "line" | "block";
  tier: "free" | "amplifying";
  line: number;
  column: number;
  region: RegionConfig;
  charStart: number;
  charEnd: number;
}

export interface DirectiveDiagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface DirectiveManifest {
  regions: RegionConfig[];
  directives: CapturedDirective[];
  diagnostics: DirectiveDiagnostic[];
  renameGlobals: boolean;
}

interface Marker {
  kind: "block" | "line";
  start: number;
  end: number;
  body: string;
}

interface Parsed {
  keyword: string;
  delta: RegionDelta;
  tier: "free" | "amplifying";
  notes: string[];
  noop: boolean;
  renameGlobals?: boolean;
  error?: string;
}

export const DIRECTIVE_MARKER = "@afterpack";

const UTF8 = new TextEncoder();

function byteOffset(source: string, charIndex: number): number {
  return UTF8.encode(source.slice(0, charIndex)).length;
}

function lineCol(source: string, charIndex: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < charIndex && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: charIndex - lineStart + 1 };
}

function scanComments(source: string): Marker[] {
  const out: Marker[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      i++;
      while (i < n && source[i] !== "`") i += source[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "/" && source[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      const body = source.slice(start + 2, i);
      if (body.includes(DIRECTIVE_MARKER)) out.push({ kind: "line", start, end: i, body });
    } else if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      out.push({ kind: "block", start, end: Math.min(i + 2, n), body: source.slice(start + 2, i) });
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

function afterpackPayload(body: string): string | null {
  const m = /^\s*@afterpack\b([\s\S]*)$/.exec(body);
  return m ? m[1].trim() : null;
}

const BLOCK_FORM_CTA =
  "open a block with `/* @afterpack <directive> */` alone on its own line and close it with " +
  "`/* @afterpack end */`, or put the marker inline to scope it to the rest of that line";

function unsupportedForm(kind: Marker["kind"], payload: string): string | undefined {
  if (payload.startsWith(":"))
    return `the \`@afterpack:begin … @afterpack:end\` span form is not implemented — ${BLOCK_FORM_CTA}`;
  if (kind === "line")
    return `\`// @afterpack …\` line comments are not scanned — ${BLOCK_FORM_CTA}`;
  return undefined;
}

function classifyTier(delta: RegionDelta): "free" | "amplifying" {
  const decreaseTarget = delta.target === undefined || delta.target === 0;
  const decreaseFloor = delta.floor === undefined || delta.floor === false;
  const noMask = delta.only === undefined && delta.deny === undefined;
  return decreaseTarget && decreaseFloor && delta.max === undefined && noMask
    ? "free"
    : "amplifying";
}

function boolValue(value: string): boolean | undefined {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return undefined;
}

function pushDeny(delta: RegionDelta, kinds: readonly TransformKind[]): void {
  const merged = new Set<TransformKind>(delta.deny ?? []);
  for (const k of kinds) merged.add(k);
  delta.deny = [...merged];
}

interface KeySpec {
  key: string;
  kind: "escapeHatch" | "amplifier";
  bool?: boolean;
  apply?: (delta: RegionDelta, value: string, notes: string[]) => string | undefined;
  fileScope?: "renameGlobals";
}

const NOT_IMPLEMENTED_REASON =
  "recognised but not implemented as a per-region directive — the engine's region wire carries " +
  "only complexity, inflation.max, strings.encode, transforms.only and transforms.deny; " +
  "set it in afterpack.json / a CLI flag / an env var instead";

const DIRECTIVE_KEYS: readonly KeySpec[] = [
  {
    key: "skip",
    kind: "escapeHatch",
    bool: true,
    apply: (delta, value, notes) => {
      const on = boolValue(value);
      if (on === undefined) return "`skip` must be `on` or `off`";
      if (!on) notes.push("`skip=off` has no effect — omit the directive instead");
      else {
        delta.target = 0;
        delta.floor = false;
      }
      return undefined;
    },
  },
  {
    key: "controlFlow.enabled",
    kind: "escapeHatch",
    bool: true,
    apply: (delta, value, notes) => {
      const on = boolValue(value);
      if (on === undefined) return "`controlFlow.enabled` must be `on` or `off`";
      if (on)
        notes.push(
          "`controlFlow.enabled=on` cannot be expressed per region — a region mask can only " +
            "forbid a transform, never re-enable one the global config disabled",
        );
      else pushDeny(delta, ["controlFlowFlatten"]);
      return undefined;
    },
  },
  {
    key: "preset",
    kind: "amplifier",
    apply: (delta, value) => {
      const preset = PRESETS.find((p) => p === value);
      if (!preset) return `unknown preset \`${value}\` (one of ${PRESETS.join(", ")})`;
      delta.target = presetTarget(preset);
      delta.floor = delta.target > 0;
      return undefined;
    },
  },
  {
    key: "complexity",
    kind: "amplifier",
    apply: (delta, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return "`complexity` needs a non-negative number";
      delta.target = n;
      return undefined;
    },
  },
  {
    key: "inflation.max",
    kind: "amplifier",
    apply: (delta, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return "`inflation.max` needs a non-negative number";
      delta.max = n;
      return undefined;
    },
  },
  {
    key: "strings.encode",
    kind: "amplifier",
    bool: true,
    apply: (delta, value) => {
      const on = boolValue(value);
      if (on === undefined) return "`strings.encode` must be `on` or `off`";
      delta.floor = on;
      return undefined;
    },
  },
  {
    key: "transforms.only",
    kind: "amplifier",
    apply: (delta, value) => {
      const { kinds, error } = parseKindList(value);
      if (error) return error;
      delta.only = kinds;
      return undefined;
    },
  },
  {
    key: "transforms.deny",
    kind: "amplifier",
    apply: (delta, value) => {
      const { kinds, error } = parseKindList(value);
      if (error || !kinds) return error;
      pushDeny(delta, kinds);
      return undefined;
    },
  },
  { key: "async.preserve", kind: "escapeHatch", bool: true },
  { key: "generators.preserve", kind: "escapeHatch", bool: true },
  { key: "identifiers.rename", kind: "escapeHatch", bool: true },
  {
    key: "identifiers.globals.rename",
    kind: "escapeHatch",
    bool: true,
    fileScope: "renameGlobals",
  },
  { key: "reflection.allow", kind: "escapeHatch" },
  { key: "strings.destructionRate", kind: "amplifier" },
  { key: "strings.materializationVariants", kind: "amplifier" },
  { key: "strings.hoistScopeBias", kind: "amplifier" },
  { key: "decoder.stateVarCount", kind: "amplifier" },
  { key: "controlFlow.deadEntries", kind: "amplifier" },
  { key: "codegen.useEval", kind: "amplifier", bool: true },
];

const SPEC_BY_LOWER = new Map<string, KeySpec>(DIRECTIVE_KEYS.map((s) => [s.key.toLowerCase(), s]));

function unknownKeyError(rawKey: string): string {
  if (rawKey.includes("-"))
    return `kebab-case is not a directive key (\`${rawKey}\`) — keys are dot-delimited camelCase`;
  return `unknown directive key \`${rawKey}\``;
}

export function parseDirectivePayload(payload: string): Parsed {
  const notes: string[] = [];
  const fail = (keyword: string, error: string): Parsed => ({
    keyword,
    delta: {},
    tier: "free",
    notes,
    noop: true,
    error,
  });

  const text = payload.trim();
  if (text === "") return fail("", "empty `@afterpack` directive");
  const tokens = text.split(/\s+/);
  const leadKey = splitAssignment(tokens[0]).key;
  if (leadKey.toLowerCase() === "end") {
    if (tokens.length > 1) return fail("end", "`@afterpack end` closes a block and takes no keys");
    return { keyword: "end", delta: {}, tier: "free", notes, noop: false };
  }

  const delta: RegionDelta = {};
  let allEscapeHatch = true;
  let keyword = leadKey;
  let renameGlobals = false;
  for (let i = 0; i < tokens.length; i++) {
    const { key: rawKey, value: rawValue } = splitAssignment(tokens[i]);
    const bare = rawValue === true;
    const spec = SPEC_BY_LOWER.get(rawKey.toLowerCase());
    if (!spec) return fail(keyword, unknownKeyError(rawKey));
    if (i === 0) keyword = spec.key;
    if (spec.kind !== "escapeHatch") allEscapeHatch = false;
    if (bare && !spec.bool) return fail(keyword, `\`${spec.key}\` needs a \`=<value>\``);
    if (spec.fileScope === "renameGlobals") {
      const on = bare ? true : boolValue(rawValue.toLowerCase());
      if (on === undefined)
        return fail(keyword, "`identifiers.globals.rename` must be `on` or `off`");
      if (on) renameGlobals = true;
      else
        notes.push(
          "`identifiers.globals.rename=off` is the default — omit the directive instead. To keep " +
            "SPECIFIC names while renaming other globals, set `identifiers.globals.rename` on and list " +
            "the names to keep in `identifiers.reserved`",
        );
      continue;
    }
    if (!spec.apply) {
      notes.push(`\`${spec.key}\` is ${NOT_IMPLEMENTED_REASON}`);
      continue;
    }
    const error = spec.apply(delta, bare ? "on" : rawValue.toLowerCase(), notes);
    if (error) return fail(keyword, error);
  }

  const noop = Object.keys(delta).length === 0;
  return {
    keyword,
    delta,
    tier: allEscapeHatch ? "free" : classifyTier(delta),
    notes,
    noop,
    renameGlobals,
  };
}

function eolOf(source: string, from: number): number {
  const nl = source.indexOf("\n", from);
  return nl < 0 ? source.length : nl;
}

function isInline(source: string, marker: Marker): boolean {
  return source.slice(marker.end, eolOf(source, marker.end)).trim() !== "";
}

function lineSpan(source: string, marker: Marker): { start: number; end: number } {
  const eol = eolOf(source, marker.end);
  if (isInline(source, marker)) return { start: marker.end, end: eol };
  const nextStart = eol + 1;
  return { start: nextStart, end: eolOf(source, nextStart) };
}

function record(
  source: string,
  parsed: Parsed,
  marker: Marker,
  form: "line" | "block",
  span: { start: number; end: number },
): CapturedDirective {
  const { line, column } = lineCol(source, marker.start);
  const region: RegionConfig = {
    start: byteOffset(source, span.start),
    end: byteOffset(source, span.end),
    ...parsed.delta,
    label: parsed.keyword,
  };
  return {
    keyword: parsed.keyword,
    form,
    tier: parsed.tier,
    line,
    column,
    region,
    charStart: span.start,
    charEnd: span.end,
  };
}

export function scanDirectives(source: string): DirectiveManifest {
  const directives: CapturedDirective[] = [];
  const diagnostics: DirectiveDiagnostic[] = [];
  const open: Array<{ parsed: Parsed; marker: Marker }> = [];
  let renameGlobals = false;
  if (!source.includes(DIRECTIVE_MARKER)) {
    return { regions: [], directives, diagnostics, renameGlobals };
  }

  for (const marker of scanComments(source)) {
    const payload = afterpackPayload(marker.body);
    if (payload === null) continue;
    const at = lineCol(source, marker.start);
    const unsupported = unsupportedForm(marker.kind, payload);
    if (unsupported) {
      diagnostics.push({ code: "DIAG_DIRECTIVE_UNSUPPORTED_FORM", message: unsupported, ...at });
      continue;
    }
    const parsed = parseDirectivePayload(payload);
    for (const note of parsed.notes) {
      diagnostics.push({ code: "DIAG_DIRECTIVE_NOT_IMPLEMENTED", message: note, ...at });
    }
    if (parsed.error) {
      diagnostics.push({ code: "DIAG_DIRECTIVE_UNKNOWN", message: parsed.error, ...at });
      continue;
    }
    if (parsed.renameGlobals) {
      renameGlobals = true;
      diagnostics.push({
        code: "DIAG_DIRECTIVE_REGION_TO_FILE",
        message:
          "`identifiers.globals.rename` cannot be scoped to a region — a global binding's references " +
          "span the whole file, so a rename is wholesale; applied to the ENTIRE file instead. To keep " +
          "SPECIFIC names while renaming the rest, use `identifiers.reserved`",
        ...at,
      });
    }
    if (parsed.keyword === "end") {
      const opened = open.pop();
      if (!opened) {
        diagnostics.push({
          code: "DIAG_DIRECTIVE_DANGLING_END",
          message: "`@afterpack end` has no open directive",
          ...at,
        });
        continue;
      }
      if (opened.parsed.noop) continue;
      directives.push(
        record(source, opened.parsed, opened.marker, "block", {
          start: opened.marker.end,
          end: marker.start,
        }),
      );
      continue;
    }
    if (isInline(source, marker)) {
      if (parsed.noop) continue;
      directives.push(
        record(source, parsed, marker, "line", {
          start: marker.end,
          end: eolOf(source, marker.end),
        }),
      );
    } else {
      open.push({ parsed, marker });
    }
  }
  for (const opened of open) {
    if (opened.parsed.noop) continue;
    directives.push(
      record(source, opened.parsed, opened.marker, "line", lineSpan(source, opened.marker)),
    );
  }
  directives.sort((a, b) => a.region.start - b.region.start || a.region.end - b.region.end);
  return { regions: directives.map((d) => d.region), directives, diagnostics, renameGlobals };
}

interface DirectiveCapture {
  regions?: RegionConfig[];
  applied: number;
  deferredFiles: number;
  diagnostics: DirectiveDiagnostic[];
  renameGlobals: boolean;
  renameGlobalsRefused: string[];
}

const REFUSAL_LIST_LIMIT = 3;

export function renameGlobalsRefusalMessage(refused: readonly string[], fileCount: number): string {
  const shown = refused.slice(0, REFUSAL_LIST_LIMIT).join(", ");
  const rest =
    refused.length > REFUSAL_LIST_LIMIT ? ` and ${refused.length - REFUSAL_LIST_LIMIT} more` : "";
  return (
    `REFUSED \`identifiers.globals.rename\` from ${shown}${rest} — the engine takes that flag ` +
    `BUILD-WIDE (one shared config), so honouring it here would rename top-level bindings in ` +
    `all ${fileCount} file(s) of this build, not only the file that asked. Nothing was renamed. ` +
    "Obfuscate that file on its own to apply it."
  );
}

interface DirectiveCaptureInput {
  source: string;
  path?: string;
}

function inputLabel(input: DirectiveCaptureInput, index: number): string {
  return input.path ?? `file #${index + 1}`;
}

export function captureDirectiveRegions(
  inputs: readonly DirectiveCaptureInput[],
  handAuthored?: RegionConfig[],
  enabled = true,
): DirectiveCapture {
  if (!enabled)
    return {
      regions: handAuthored,
      applied: 0,
      deferredFiles: 0,
      diagnostics: [],
      renameGlobals: false,
      renameGlobalsRefused: [],
    };
  if (inputs.length === 1) {
    const scan = scanDirectives(inputs[0].source);
    if (scan.regions.length === 0)
      return {
        regions: handAuthored,
        applied: 0,
        deferredFiles: 0,
        diagnostics: scan.diagnostics,
        renameGlobals: scan.renameGlobals,
        renameGlobalsRefused: [],
      };
    return {
      regions: [...(handAuthored ?? []), ...scan.regions],
      applied: scan.regions.length,
      deferredFiles: 0,
      diagnostics: scan.diagnostics,
      renameGlobals: scan.renameGlobals,
      renameGlobalsRefused: [],
    };
  }
  let deferredFiles = 0;
  const renameGlobalsRefused: string[] = [];
  const diagnostics: DirectiveDiagnostic[] = [];
  inputs.forEach((input, index) => {
    const scan = scanDirectives(input.source);
    if (scan.regions.length > 0) deferredFiles++;
    if (scan.renameGlobals) renameGlobalsRefused.push(inputLabel(input, index));
    diagnostics.push(...scan.diagnostics);
  });
  return {
    regions: handAuthored,
    applied: 0,
    deferredFiles,
    diagnostics,
    renameGlobals: false,
    renameGlobalsRefused,
  };
}
