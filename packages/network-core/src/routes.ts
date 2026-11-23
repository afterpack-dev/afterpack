export interface Routes {
  include: readonly string[];
  exclude?: readonly string[];
}

const UNRESERVED_ESCAPE = /%(?:[46][1-9A-Fa-f]|[57][0-9Aa]|3[0-9]|2[DEde]|5[Ff]|7[Ee])/g;

function decodeUnreserved(path: string): string {
  return path.replace(UNRESERVED_ESCAPE, (match) =>
    String.fromCharCode(Number.parseInt(match.slice(1), 16)),
  );
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === segment;
  let pi = 0;
  let si = 0;
  let star = -1;
  let starSi = 0;
  while (si < segment.length) {
    if (pi < pattern.length && pattern[pi] === "*") {
      star = pi;
      starSi = si;
      pi += 1;
    } else if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === segment[si])) {
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
  for (; pi < pattern.length; pi++) if (pattern[pi] !== "*") return false;
  return true;
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
  return pattern.slice(pi).every((part) => part === "**");
}

export function routePatternMatches(pattern: string, pathname: string): boolean {
  return segmentsMatch(segments(pattern), segments(pathname));
}

export function compileRoutes(routes: Routes): (pathname: string) => boolean {
  if (routes === null || typeof routes !== "object" || !Array.isArray(routes.include)) {
    throw new TypeError("routes must be { include: string[], exclude?: string[] }");
  }
  const exclude = routes.exclude ?? [];
  if (!Array.isArray(exclude)) throw new TypeError("routes.exclude must be a string array");
  const check = (list: readonly string[], name: string) => {
    for (const pattern of list) {
      if (typeof pattern !== "string" || !pattern.startsWith("/")) {
        throw new TypeError(`${name} holds path globs that start with "/", such as "/api/**"`);
      }
    }
  };
  check(routes.include, "routes.include");
  check(exclude, "routes.exclude");
  if (routes.include.length === 0)
    throw new TypeError("routes.include must name at least one path");
  const include = routes.include.map(segments);
  const excluded = exclude.map(segments);
  return (pathname) => {
    const path = segments(decodeUnreserved(pathname));
    return (
      include.some((pattern) => segmentsMatch(pattern, path)) &&
      !excluded.some((pattern) => segmentsMatch(pattern, path))
    );
  };
}
