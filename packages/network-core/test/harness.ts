import {
  createNetworkProtection,
  generateKeyPair,
  type NetworkProtectionOptions,
  type RequestInfo,
} from "../src/index.js";
import { type Encoding, Np1TestClient, type Pairs, type SealedRequest } from "./np1-client.js";

export const ORIGIN = "https://app.example";
export const TUNNEL = `${ORIGIN}/api/k7Zq`;

export function base64urlToBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function setup(options: Partial<NetworkProtectionOptions> = {}) {
  const keys = generateKeyPair();
  const serverPublic = base64urlToBytes(keys.publicKey);
  const seen: Request[] = [];
  const infos: { request: Request; info: RequestInfo }[] = [];
  const protection = createNetworkProtection({
    privateKeys: [keys.privateKey],
    routes: { include: ["/api/**"], exclude: ["/api/public/**"] },
    allowedOrigins: ["https://staging.app.example"],
    onRequest: (request, info) => infos.push({ request, info }),
    ...options,
  });
  const client = (ratio: number | null = 1.5) => new Np1TestClient({ serverPublic, ratio });
  return { keys, serverPublic, protection, seen, infos, client };
}

export function tunnelRequest(
  sealed: SealedRequest,
  headers: Record<string, string> = {},
  url = TUNNEL,
): Request {
  return new Request(url, {
    method: "POST",
    body: new Uint8Array(sealed.body),
    headers: {
      "content-type": sealed.contentType,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      origin: ORIGIN,
      cookie: "sid=outer",
      "user-agent": "outer-agent",
      accept: "*/*",
      ...headers,
    },
  });
}

export async function echo(request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  return Response.json({
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body: Buffer.from(body).toString("base64"),
  });
}

export async function roundTrip(
  ctx: ReturnType<typeof setup>,
  client: Np1TestClient,
  request: { method: string; target: string; headers?: Pairs; body?: Uint8Array | string },
  encoding: Encoding,
  next: (request: Request) => Response | Promise<Response> = echo,
  headers: Record<string, string> = {},
) {
  const sealed = client.sealRequest(request, encoding, "zk");
  const outer = await ctx.protection.handle(tunnelRequest(sealed, headers), async (inner) => {
    ctx.seen.push(inner);
    return next(inner);
  });
  const outerBody = new Uint8Array(await outer.arrayBuffer());
  let opened: ReturnType<Np1TestClient["openResponse"]> | null = null;
  try {
    opened = client.openResponse(outerBody, encoding);
  } catch {
    opened = null;
  }
  return { outer, outerBody, opened };
}

export function json(opened: { body: Uint8Array } | null): {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
} {
  if (opened === null) throw new Error("no response");
  return JSON.parse(Buffer.from(opened.body).toString("utf8"));
}
