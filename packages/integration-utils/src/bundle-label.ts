import { basename, isAbsolute, relative, sep } from "node:path";

const MAX_BUNDLE_LABEL_LENGTH = 120;

const PRINTABLE = /^[^\p{C}]+$/u;

export function sanitizeBundleLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  const length = [...label].length;
  if (length === 0 || length > MAX_BUNDLE_LABEL_LENGTH) return null;
  return PRINTABLE.test(label) ? label : null;
}

export function pathBundleLabel(path: string, root: string): string | undefined {
  const rel = relative(root, path);
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const label = inside ? rel.split(sep).join("/") : basename(path);
  return label === "" ? undefined : label;
}

export function qualifiedBundleLabel(
  base: string | undefined,
  qualifier: string | undefined,
): string | undefined {
  if (!base) return undefined;
  return qualifier ? `${base} (${qualifier})` : base;
}
