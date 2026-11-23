import type { HeaderPairs } from "./np1.js";

const OUTER_ONLY = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "cdn-loop",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "forwarded",
  "host",
  "origin",
  "referer",
  "set-cookie",
  "true-client-ip",
  "via",
  "x-real-ip",
]);

const OUTER_ONLY_PREFIXES = ["sec-", "proxy-", "cf-", "x-forwarded-"];

const FRAMING = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const TUNNEL_BODY = new Set(["content-type", "content-encoding"]);

const METHOD_OVERRIDES = new Set(["x-http-method", "x-http-method-override", "x-method-override"]);

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

const RESPONSE_DROPPED = new Set([...FRAMING, "content-encoding", "set-cookie"]);

export function isOuterOnly(name: string): boolean {
  return OUTER_ONLY.has(name) || OUTER_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function overridesForbiddenMethod(value: string): boolean {
  return value
    .replace(/["\\]/g, "")
    .split(",")
    .some((method) => FORBIDDEN_METHODS.has(method.trim().toUpperCase()));
}

function forbiddenOverrides(inner: HeaderPairs): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of inner) {
    if (METHOD_OVERRIDES.has(name) && overridesForbiddenMethod(value)) names.add(name);
  }
  return names;
}

export function unwrapHeaders(outer: Headers, inner: HeaderPairs): Headers {
  const out = new Headers();
  const fromInner = new Set<string>();
  const forbidden = forbiddenOverrides(inner);
  for (const [name, value] of inner) {
    if (isOuterOnly(name) || FRAMING.has(name) || forbidden.has(name)) continue;
    out.append(name, value);
    fromInner.add(name);
  }
  for (const [name, value] of outer) {
    if (FRAMING.has(name) || TUNNEL_BODY.has(name) || fromInner.has(name)) continue;
    if (name === "set-cookie" || name === "accept-encoding") continue;
    out.append(name, value);
  }
  out.set("accept-encoding", "identity");
  return out;
}

export function responseHeaderPairs(headers: Headers): HeaderPairs {
  const pairs: HeaderPairs = [];
  for (const [name, value] of headers) {
    if (RESPONSE_DROPPED.has(name)) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

export function setCookiesOf(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single === null ? [] : [single];
}
