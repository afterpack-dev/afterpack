function normalize(value: string): string {
  return value.includes("\\") ? value.replaceAll("\\", "/") : value;
}

function segments(value: string): string[] {
  return value.split("/").filter((part) => part !== "");
}

function isAnchored(pattern: string): boolean {
  if (pattern.startsWith("/")) return true;
  return pattern.length >= 2 && pattern[1] === ":" && /^[A-Za-z]$/.test(pattern[0]);
}

function segmentMatches(pattern: string, seg: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === seg;
  const p = [...pattern];
  const s = [...seg];
  let pi = 0;
  let si = 0;
  let star = -1;
  let starSi = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi;
      starSi = si;
      pi += 1;
    } else if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (star >= 0) {
      pi = star + 1;
      starSi += 1;
      si = starSi;
    } else {
      return false;
    }
  }
  return p.slice(pi).every((c) => c === "*");
}

function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let starSi = 0;
  while (si < path.length) {
    if (pi < pattern.length && pattern[pi] === "**") {
      star = pi;
      starSi = si;
      pi += 1;
    } else if (pi < pattern.length && segmentMatches(pattern[pi], path[si])) {
      pi += 1;
      si += 1;
    } else if (star >= 0) {
      pi = star + 1;
      starSi += 1;
      si = starSi;
    } else {
      return false;
    }
  }
  return pattern.slice(pi).every((s) => s === "**");
}

export function matchesPath(pattern: string, path: string): boolean {
  const pat = normalize(pattern);
  const parts = segments(pat);
  if (parts.length === 0) return false;
  const segs = segments(normalize(path));
  if (isAnchored(pat)) return segmentsMatch(parts, segs);
  for (let i = 0; i <= segs.length; i++) {
    if (segmentsMatch(parts, segs.slice(i))) return true;
  }
  return false;
}

export function reachesInto(pattern: string, dir: string): boolean {
  const pat = normalize(pattern);
  const parts = segments(pat);
  if (parts.length === 0) return false;
  if (!isAnchored(pat)) return true;
  for (let k = 1; k <= parts.length; k++) {
    if (matchesPath(`/${parts.slice(0, k).join("/")}`, dir)) return true;
  }
  return false;
}
