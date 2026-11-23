import { type ProtectionSource, protectionResolver } from "./resolve.js";

export interface HonoLikeApp<Env> {
  fetch(request: Request, env?: Env, executionCtx?: never): Response | Promise<Response>;
}

export interface HonoLikeContext<Env> {
  req: { raw: Request };
  env: Env;
  res: Response;
  readonly executionCtx: unknown;
}

export type HonoLikeMiddleware<Env> = (
  c: HonoLikeContext<Env>,
  next: () => Promise<void>,
) => Promise<Response | undefined>;

const REDISPATCHED = new WeakSet<Request>();

function executionCtxOf(c: { readonly executionCtx: unknown }): unknown {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function networkProtection<Env = unknown>(
  app: HonoLikeApp<Env>,
  source: ProtectionSource<Env>,
): HonoLikeMiddleware<Env> {
  if (app === null || typeof app !== "object" || typeof app.fetch !== "function") {
    throw new TypeError("networkProtection(app, options) takes the Hono app it is mounted on");
  }
  const resolve = protectionResolver(source);
  return async (c, next) => {
    const raw = c.req.raw;
    if (REDISPATCHED.has(raw)) {
      await next();
      return undefined;
    }
    return resolve(c.env).handle(raw, async (request) => {
      if (request === raw) {
        await next();
        return c.res;
      }
      REDISPATCHED.add(request);
      return app.fetch(request, c.env, executionCtxOf(c) as never);
    });
  };
}

export type FetchHandler<Env, Ctx> = (
  request: Request,
  env: Env,
  ctx: Ctx,
) => Response | Promise<Response>;

export function withNetworkProtection<
  Env,
  F extends (request: Request, env: Env, ctx: never) => Response | Promise<Response>,
>(
  handler: F,
  source: ProtectionSource<Env>,
): (request: Request, env: Env, ctx?: unknown) => Promise<Response>;
export function withNetworkProtection<
  Env,
  H extends { fetch(request: Request, env: Env, ctx: never): Response | Promise<Response> },
>(handler: H, source: ProtectionSource<Env>): H;
export function withNetworkProtection<Env>(
  handler: FetchHandler<Env, unknown> | { fetch: FetchHandler<Env, unknown> },
  source: ProtectionSource<Env>,
): FetchHandler<Env, unknown> | { fetch: FetchHandler<Env, unknown> } {
  const resolve = protectionResolver(source);
  if (typeof handler === "function") {
    return (request, env, ctx) => resolve(env).handle(request, (inner) => handler(inner, env, ctx));
  }
  if (handler === null || typeof handler !== "object" || typeof handler.fetch !== "function") {
    throw new TypeError("withNetworkProtection takes a fetch handler or an object with fetch()");
  }
  const original = handler.fetch;
  return {
    ...handler,
    fetch: (request: Request, env: Env, ctx: unknown) =>
      resolve(env).handle(request, (inner) => original.call(handler, inner, env, ctx)),
  };
}
