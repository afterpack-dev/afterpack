import { decodeUtf8, fromBase64url, toBase64url, toBytes, toHex } from "./bytes.js";
import { contentCodings, decodeContent } from "./content-coding.js";
import { NONCE_BYTES, publicKeyOf, SESSION_KEY_BYTES } from "./crypto.js";
import { responseHeaderPairs, setCookiesOf, unwrapHeaders } from "./headers.js";
import { type PrivateKeysInput, parsePrivateKeys } from "./keys.js";
import {
  type BodyEncoding,
  buildInner,
  detectBody,
  encodeBody,
  type FrameType,
  frameToWire,
  type HeaderPairs,
  type InnerMessage,
  MIN_PREFIXED_WIRE,
  type Np1Error,
  openRecord,
  SERVER_LADDER_RATIO,
  sealRecord,
  wireToFrame,
} from "./np1.js";
import { compileRoutes, type Routes } from "./routes.js";
import {
  deriveAll,
  isCachedSession,
  type SessionDeriver,
  sessionKeysFor,
} from "./session-cache.js";

export type RefusalReason =
  | Np1Error
  | "unsealed"
  | "cross-site"
  | "rate-limited"
  | "outside-routes"
  | "bad-request"
  | "too-large";

export type SocketRefusal = Np1Error | "rate-limited";

export interface RequestInfo {
  method: string;
  path: string;
  status: number;
  sealed: boolean;
  durationMs: number;
  refusal?: RefusalReason;
}

export interface NetworkProtectionOptions {
  privateKeys: PrivateKeysInput;
  routes: Routes;
  allowedOrigins?: readonly string[];
  requireSealed?: boolean;
  freshSessionsPerMinute?: number;
  maxSealedBodyBytes?: number;
  clientAddress?: (request: Request) => string | null | undefined;
  onRequest?: (request: Request, info: RequestInfo) => void;
}

export interface Counters {
  sealed: number;
  plaintext: number;
  openFailures: number;
  refusals: number;
}

export interface SocketState {
  key: string;
  frameType: FrameType;
}

export type SocketData = string | ArrayBuffer | ArrayBufferView;

export type SocketOpened =
  | { ok: true; state: SocketState; message: string | Uint8Array | null }
  | { ok: false; error: SocketRefusal; state: SocketState | null };

export type Next = (request: Request) => Response | Promise<Response>;

export interface NetworkProtection {
  handle(request: Request, next: Next): Promise<Response>;
  openSocket(
    state: SocketState | null | undefined,
    frame: SocketData,
    address?: string | null,
  ): SocketOpened;
  sealSocket(state: SocketState, message: SocketData): string | Uint8Array;
  clientAddress(request: Request): string | null;
  readonly counters: Readonly<Counters>;
}

export const REFUSAL_STATUS = 400;
export const DEFAULT_MAX_SEALED_BODY_BYTES = 1 << 20;
const INTERNAL_ERROR_STATUS = 500;
const BAD_GATEWAY_STATUS = 502;

type Attempt =
  | { kind: "plaintext" }
  | { kind: "failed"; error: Np1Error }
  | { kind: "rate-limited" }
  | { kind: "too-large" }
  | {
      kind: "opened";
      message: Extract<InnerMessage, { kind: 1 }>;
      key: Uint8Array;
      encoding: BodyEncoding;
      jsonKey?: string;
    };

function randomNonce(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    throw new TypeError(
      `allowedOrigins holds origins such as "https://example.com", not ${origin}`,
    );
  }
}

const WINDOW_MS = 60_000;
const LIMITER_ENTRIES = 10_000;

function freshSessionLimiter(cap: number | undefined): (address: string, now: number) => boolean {
  if (cap === undefined) return () => true;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new TypeError("freshSessionsPerMinute must be a non-negative integer");
  }
  const windows = new Map<string, { start: number; count: number }>();
  return (address, now) => {
    let entry = windows.get(address);
    if (entry === undefined || now - entry.start >= WINDOW_MS) {
      if (entry === undefined && windows.size >= LIMITER_ENTRIES) {
        for (const [key, value] of windows) {
          if (now - value.start >= WINDOW_MS) windows.delete(key);
        }
        if (windows.size >= LIMITER_ENTRIES) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      entry = { start: now, count: 0 };
      windows.delete(address);
      windows.set(address, entry);
    }
    if (entry.count >= cap) return false;
    entry.count += 1;
    return true;
  };
}

function bodyLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SEALED_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value < MIN_PREFIXED_WIRE) {
    throw new TypeError(`maxSealedBodyBytes must be an integer of at least ${MIN_PREFIXED_WIRE}`);
  }
  return value;
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null || !/^[0-9]{1,15}$/.test(value)) return null;
  return Number(value);
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return joinChunks(chunks, length);
    length += value.byteLength;
    if (length > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function looksSealed(encoding: BodyEncoding, wire: Uint8Array): boolean {
  if (wire.length < MIN_PREFIXED_WIRE) return false;
  return encoding !== "raw" || decodeUtf8(wire) === null;
}

function refusalResponse(): Response {
  return new Response("Bad Request", {
    status: REFUSAL_STATUS,
    headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" },
  });
}

function socketKey(state: SocketState): Uint8Array | null {
  const key = typeof state?.key === "string" ? fromBase64url(state.key) : null;
  if (key === null || key.length !== SESSION_KEY_BYTES) return null;
  if (state.frameType !== "binary" && state.frameType !== "text") return null;
  return key;
}

function parseSocketState(state: SocketState): Uint8Array {
  const key = socketKey(state);
  if (key === null) throw new TypeError("socket state holds no session key and frame type");
  return key;
}

function socketMessage(message: InnerMessage): string | Uint8Array | null {
  if (message.kind === 3) return message.text;
  if (message.kind === 4) return message.payload;
  return null;
}

export function createNetworkProtection(options: NetworkProtectionOptions): NetworkProtection {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createNetworkProtection takes an options object");
  }
  const secrets = parsePrivateKeys(options.privateKeys);
  const deriver: SessionDeriver = {
    id: secrets.map((secret) => toHex(publicKeyOf(secret))).join(""),
    secrets,
  };
  const inRoutes = compileRoutes(options.routes);
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normaliseOrigin));
  const requireSealed = options.requireSealed === true;
  const maxBody = bodyLimit(options.maxSealedBodyBytes);
  const takeFreshSession = freshSessionLimiter(options.freshSessionsPerMinute);
  const takeForeignSession = freshSessionLimiter(options.freshSessionsPerMinute);
  const clientAddress =
    options.freshSessionsPerMinute === undefined ? undefined : options.clientAddress;
  if (options.freshSessionsPerMinute !== undefined && typeof clientAddress !== "function") {
    throw new TypeError(
      "freshSessionsPerMinute needs clientAddress(request), the address your platform vouches " +
        "for: a header a client can set itself is no limit",
    );
  }
  let warnedNoAddress = false;
  let warnedNoSocketAddress = false;
  const onRequest = options.onRequest;
  const counters: Counters = { sealed: 0, plaintext: 0, openFailures: 0, refusals: 0 };

  const report = (request: Request, info: RequestInfo) => {
    if (onRequest === undefined) return;
    try {
      onRequest(request, info);
    } catch (error) {
      console.error(error);
    }
  };

  const isSameOrigin = (request: Request, outerOrigin: string): boolean => {
    if (request.headers.get("sec-fetch-site") === "same-origin") return true;
    const origin = request.headers.get("origin");
    return origin !== null && (origin === outerOrigin || allowedOrigins.has(origin));
  };

  const addressOf = (request: Request): string | null => {
    if (clientAddress === undefined) return null;
    const address = clientAddress(request);
    return typeof address === "string" && address !== "" ? address : null;
  };

  const attemptOpen = async (request: Request, sameOrigin: boolean): Promise<Attempt> => {
    if (request.method !== "POST" || request.body === null) return { kind: "plaintext" };
    const length = declaredLength(request);
    if (length === null || length < MIN_PREFIXED_WIRE) return { kind: "plaintext" };
    if (length > maxBody) return { kind: "too-large" };
    const clone = request.clone().body;
    if (clone === null) return { kind: "plaintext" };
    const body = await readBounded(clone, maxBody);
    if (body === null) return { kind: "too-large" };
    const detected = detectBody(body);
    if (!detected.ok || !looksSealed(detected.encoding, detected.wire)) {
      return { kind: "plaintext" };
    }
    const ephPublic = detected.wire.subarray(0, 32);
    if (clientAddress !== undefined && !isCachedSession(deriver, ephPublic)) {
      const address = addressOf(request);
      if (address !== null) {
        const take = sameOrigin ? takeFreshSession : takeForeignSession;
        if (!take(address, Date.now())) return { kind: "rate-limited" };
      } else if (!warnedNoAddress) {
        warnedNoAddress = true;
        console.warn(
          "network protection: clientAddress gave no address, so freshSessionsPerMinute does " +
            "not limit such requests",
        );
      }
    }
    const opened = openRecord(
      detected.wire,
      { prefixed: (eph) => sessionKeysFor(deriver, eph) },
      "server",
      "http",
      true,
    );
    if (!opened.ok) return { kind: "failed", error: opened.error };
    if (opened.message.kind !== 1) return { kind: "failed", error: "wrong-transport" };
    return {
      kind: "opened",
      message: opened.message,
      key: opened.key,
      encoding: detected.encoding,
      jsonKey: detected.jsonKey,
    };
  };

  const refuse = (
    request: Request,
    started: number,
    refusal: RefusalReason,
    sealed: boolean,
    method = request.method,
    path = new URL(request.url).pathname,
  ): Response => {
    counters.refusals += 1;
    report(request, {
      method,
      path,
      status: REFUSAL_STATUS,
      sealed,
      durationMs: Date.now() - started,
      refusal,
    });
    return refusalResponse();
  };

  const passPlaintext = async (request: Request, next: Next, started: number) => {
    counters.plaintext += 1;
    const response = await next(request);
    report(request, {
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      sealed: false,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const handle = async (request: Request, next: Next): Promise<Response> => {
    const started = Date.now();
    const outerUrl = new URL(request.url);
    if (!inRoutes(outerUrl.pathname)) return next(request);

    const sameOrigin = isSameOrigin(request, outerUrl.origin);
    const attempt = await attemptOpen(request, sameOrigin);
    if (attempt.kind === "rate-limited") return refuse(request, started, "rate-limited", false);
    if (attempt.kind === "too-large") {
      if (requireSealed) return refuse(request, started, "too-large", false);
      return passPlaintext(request, next, started);
    }
    if (attempt.kind === "failed") {
      counters.openFailures += 1;
      if (requireSealed) return refuse(request, started, attempt.error, false);
      return passPlaintext(request, next, started);
    }
    if (attempt.kind === "plaintext") {
      if (requireSealed) return refuse(request, started, "unsealed", false);
      return passPlaintext(request, next, started);
    }

    const { message } = attempt;
    if (!sameOrigin) return refuse(request, started, "cross-site", true);
    const innerUrl = new URL(message.target, outerUrl);
    if (innerUrl.origin !== outerUrl.origin || !inRoutes(innerUrl.pathname)) {
      return refuse(request, started, "outside-routes", true, message.method, innerUrl.pathname);
    }

    let inner: Request;
    try {
      const init: RequestInit & { cf?: unknown } = {
        method: message.method,
        headers: unwrapHeaders(request.headers, message.headers),
        body: message.body.length > 0 ? new Uint8Array(message.body) : null,
      };
      if (request.signal) init.signal = request.signal;
      const cf = (request as { cf?: unknown }).cf;
      if (cf !== undefined) init.cf = cf;
      inner = new Request(innerUrl, init);
    } catch {
      return refuse(request, started, "bad-request", true, message.method, innerUrl.pathname);
    }

    let status = INTERNAL_ERROR_STATUS;
    let innerHeaders: HeaderPairs = [];
    let innerBody: Uint8Array = new Uint8Array(0);
    let setCookies: string[] = [];
    try {
      const response = await next(inner);
      if (response.status >= 200 && response.status <= 599) {
        const raw = new Uint8Array(await response.arrayBuffer());
        const codings = response.url ? [] : contentCodings(response.headers);
        const decoded = codings.length === 0 ? raw : await decodeContent(raw, codings);
        if (decoded === null) {
          console.error(
            `network protection: cannot decode a response in Content-Encoding ` +
              `"${codings.join(", ")}" to seal it; answer the unwrapped request uncompressed`,
          );
          status = BAD_GATEWAY_STATUS;
        } else {
          innerBody = decoded;
          status = response.status;
          innerHeaders = responseHeaderPairs(response.headers);
          setCookies = setCookiesOf(response.headers);
        }
      } else {
        status = BAD_GATEWAY_STATUS;
      }
    } catch (error) {
      console.error(error);
    }
    const sealedInner = buildInner(
      { kind: 2, status, headers: innerHeaders, body: innerBody },
      SERVER_LADDER_RATIO,
    );
    const record = sealRecord(attempt.key, randomNonce(), sealedInner);
    const outerHeaders = new Headers({ "cache-control": "no-store" });
    const contentType = request.headers.get("content-type");
    if (contentType !== null) outerHeaders.set("content-type", contentType);
    for (const cookie of setCookies) outerHeaders.append("set-cookie", cookie);

    counters.sealed += 1;
    report(inner, {
      method: inner.method,
      path: innerUrl.pathname,
      status,
      sealed: true,
      durationMs: Date.now() - started,
    });
    return new Response(encodeBody(record, attempt.encoding, attempt.jsonKey), {
      status: 200,
      headers: outerHeaders,
    });
  };

  const admitSocket = (address: string | null | undefined): boolean => {
    if (clientAddress === undefined) return true;
    if (typeof address === "string" && address !== "") {
      return takeFreshSession(address, Date.now());
    }
    if (!warnedNoSocketAddress) {
      warnedNoSocketAddress = true;
      console.warn(
        "network protection: openSocket got no client address, so freshSessionsPerMinute does " +
          "not limit such sockets",
      );
    }
    return true;
  };

  const openSocket = (
    state: SocketState | null | undefined,
    frame: SocketData,
    address?: string | null,
  ): SocketOpened => {
    const frameType: FrameType = typeof frame === "string" ? "text" : "binary";
    const data = typeof frame === "string" ? frame : toBytes(frame);
    const fail = (error: Np1Error): SocketOpened => {
      counters.openFailures += 1;
      return { ok: false, error, state: state ?? null };
    };
    if (state === null || state === undefined) {
      const wire = frameToWire(data, frameType);
      if (wire === null) return fail("bad-encoding");
      if (wire.length >= MIN_PREFIXED_WIRE && !admitSocket(address)) {
        counters.refusals += 1;
        return { ok: false, error: "rate-limited", state: null };
      }
      const opened = openRecord(
        wire,
        { prefixed: (eph) => deriveAllKeys(secrets, eph) },
        "server",
        "socket",
        true,
      );
      if (!opened.ok) return fail(opened.error);
      return {
        ok: true,
        state: { key: toBase64url(opened.key), frameType },
        message: socketMessage(opened.message),
      };
    }
    const key = socketKey(state);
    if (key === null) return fail("malformed");
    if (frameType !== state.frameType) return fail("bad-encoding");
    const wire = frameToWire(data, frameType);
    if (wire === null) return fail("bad-encoding");
    const opened = openRecord(wire, { key }, "server", "socket", false);
    if (!opened.ok) return fail(opened.error);
    return { ok: true, state, message: socketMessage(opened.message) };
  };

  const sealSocket = (state: SocketState, message: SocketData): string | Uint8Array => {
    const key = parseSocketState(state);
    const inner = buildInner(
      typeof message === "string"
        ? { kind: 5, text: message }
        : { kind: 6, payload: toBytes(message) },
      SERVER_LADDER_RATIO,
    );
    return wireToFrame(sealRecord(key, randomNonce(), inner), state.frameType);
  };

  return {
    handle,
    openSocket,
    sealSocket,
    clientAddress: addressOf,
    get counters() {
      return { ...counters };
    },
  };
}

function deriveAllKeys(secrets: Uint8Array[], ephPublic: Uint8Array) {
  const keys = deriveAll(secrets, ephPublic);
  return keys === "zero-shared" ? keys : { keys };
}
