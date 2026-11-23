import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_NAME, findUpward } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import { commandLine } from "./dispatch.js";
import { EXIT, type ExitCode } from "./exit.js";
import { bold, dim, green, yellow } from "./format.js";
import {
  commandFailure,
  documentPath,
  emitJson,
  JSON_SCHEMA_VERSION,
  type OutputMode,
} from "./output.js";
import { detectPackageManager } from "./package-manager.js";
import type { CliLogger } from "./run.js";

const NETWORK_USAGE =
  "usage: afterpack network keygen [--diagnostics.format=text|json]\n" +
  "       afterpack network init [--diagnostics.format=text|json]";

export const SECRET_NAME = "NETWORK_PRIVATE_KEYS";
export const DEFAULT_ROUTES = ["/api/**"];
const WRANGLER_FILES = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"];

export const NETWORK_HELP = `${NETWORK_USAGE}

Sets up network protection: an AfterPack Pro build seals the app's own API and
socket traffic to your server's public key, and the server package opens it.

Commands:
  keygen                   print a new key pair (X25519, base64url, 32 bytes
                           each) from the OS random source. Writes nothing.
  init                     make a key pair, write the public key and the
                           protected routes into afterpack.json (network.publicKey,
                           network.routes.include, default ${DEFAULT_ROUTES.join(", ")}),
                           and print the server snippet and the secret command
                           for the platform it detects (Cloudflare when a
                           wrangler.toml or wrangler.jsonc is in the working
                           directory). It never runs that command and refuses to
                           replace a public key afterpack.json already holds.

The private key belongs only in your server's secret store. To rotate, run
keygen, add the new private key to the server's list ahead of the old one,
switch network.publicKey to the new public key, and drop the old private key
once no cached build uses it.

Behind the tunnel, edge WAF rules and rate limits keyed on an API path see only
POST to the tunnel path. Move them into your handler, keyed on the unwrapped
request's method and path.

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout
  --help, -h               this help

Exit codes: 0 on success, 1 when afterpack.json can't be read or already holds a
public key, 64 on a usage error.

${dim(CONTACT_FOOTER)}`;

interface NetworkDeps {
  cwd: string;
  logger: CliLogger;
  report: CliLogger;
  positionals: string[];
  mode: OutputMode;
  version: string;
}

export interface NetworkKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateNetworkKeyPair(): NetworkKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
    throw new Error("the X25519 key pair did not export");
  }
  return { publicKey: publicJwk.x, privateKey: privateJwk.d };
}

function fail(
  deps: NetworkDeps,
  exitCode: ExitCode,
  code: string,
  message: string,
  fix: string,
): ExitCode {
  return commandFailure(deps, "network", exitCode, code, message, fix);
}

function emitDocument(
  deps: NetworkDeps,
  summary: Record<string, unknown>,
  artifacts: Record<string, string>,
) {
  emitJson(deps.logger, {
    schemaVersion: JSON_SCHEMA_VERSION,
    afterpack: deps.version,
    command: "network",
    exitCode: EXIT.ok,
    ok: true,
    files: [],
    diagnostics: [],
    summary,
    artifacts,
  });
}

function keygen(deps: NetworkDeps): ExitCode {
  const pair = generateNetworkKeyPair();
  if (deps.mode.format === "json") {
    emitDocument(deps, { publicKey: pair.publicKey, privateKey: pair.privateKey }, {});
    return EXIT.ok;
  }
  deps.logger.log(`publicKey   ${pair.publicKey}`);
  deps.logger.log(`privateKey  ${pair.privateKey}`);
  deps.logger.log("");
  deps.logger.log(dim("the public key goes in afterpack.json as network.publicKey;"));
  deps.logger.log(dim("the private key goes ONLY in your server's secret store, never in git"));
  return EXIT.ok;
}

type Platform = "cloudflare" | "fetch";

function detectPlatform(cwd: string): { platform: Platform; file: string | null } {
  const file = WRANGLER_FILES.find((name) => existsSync(join(cwd, name))) ?? null;
  return { platform: file === null ? "fetch" : "cloudflare", file };
}

function usesHono(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return ["dependencies", "devDependencies"].some((field) => {
      const deps = pkg[field];
      return typeof deps === "object" && deps !== null && "hono" in deps;
    });
  } catch {
    return false;
  }
}

function honoMountPath(include: readonly string[]): string {
  const first = include[0] ?? "/**";
  return first.endsWith("/**") ? `${first.slice(0, -3)}/*` : "*";
}

function routesLiteral(include: readonly string[]): string {
  return `{ include: [${include.map((route) => JSON.stringify(route)).join(", ")}] }`;
}

export function serverSnippet(
  platform: Platform,
  hono: boolean,
  include: readonly string[],
): string {
  const routes = routesLiteral(include);
  if (platform === "cloudflare" && hono) {
    return [
      'import { networkProtection } from "@afterpack/network-cloudflare";',
      "",
      "app.use(",
      `  ${JSON.stringify(honoMountPath(include))},`,
      "  networkProtection(app, (env) => ({",
      `    privateKeys: env.${SECRET_NAME},`,
      `    routes: ${routes},`,
      "  })),",
      ");",
    ].join("\n");
  }
  if (platform === "cloudflare") {
    return [
      'import { withNetworkProtection } from "@afterpack/network-cloudflare";',
      "",
      "export default withNetworkProtection(worker, (env) => ({",
      `  privateKeys: env.${SECRET_NAME},`,
      `  routes: ${routes},`,
      "}));",
    ].join("\n");
  }
  return [
    'import { createNetworkProtection } from "@afterpack/network-core";',
    "",
    "const protection = createNetworkProtection({",
    `  privateKeys: process.env.${SECRET_NAME},`,
    `  routes: ${routes},`,
    "});",
    "",
    "export default { fetch: (request) => protection.handle(request, app.fetch) };",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function init(deps: NetworkDeps): ExitCode {
  const { cwd } = deps;
  const configPath = findUpward(cwd, CONFIG_FILE_NAME) ?? join(cwd, CONFIG_FILE_NAME);
  const shown = documentPath(cwd, configPath);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      return fail(
        deps,
        EXIT.failure,
        "CONFIG_UNREADABLE",
        `${shown} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "Fix the file, then run `afterpack network init` again.",
      );
    }
    if (!isRecord(parsed)) {
      return fail(
        deps,
        EXIT.failure,
        "CONFIG_UNREADABLE",
        `${shown} does not hold a JSON object`,
        "Fix the file, then run `afterpack network init` again.",
      );
    }
    config = parsed;
  }

  const network = isRecord(config.network) ? config.network : {};
  if (network.publicKey !== undefined) {
    return fail(
      deps,
      EXIT.failure,
      "PUBLIC_KEY_EXISTS",
      `${shown} already holds network.publicKey`,
      "init never replaces a key a deployed build may use. To rotate: run `afterpack network " +
        "keygen`, add the new private key to the server's list ahead of the old one, then set " +
        "network.publicKey to the new public key.",
    );
  }
  const routes = isRecord(network.routes) ? network.routes : {};
  const include =
    Array.isArray(routes.include) && routes.include.every((route) => typeof route === "string")
      ? (routes.include as string[])
      : DEFAULT_ROUTES;

  const pair = generateNetworkKeyPair();
  const next = {
    ...config,
    network: { ...network, publicKey: pair.publicKey, routes: { ...routes, include } },
  };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);

  const { platform, file } = detectPlatform(cwd);
  const hono = platform === "cloudflare" && usesHono(cwd);
  const pkg =
    platform === "cloudflare" ? "@afterpack/network-cloudflare" : "@afterpack/network-core";
  const install = detectPackageManager(cwd).add(pkg);
  const secretCommand = platform === "cloudflare" ? `npx wrangler secret put ${SECRET_NAME}` : null;
  const snippet = serverSnippet(platform, hono, include);

  if (deps.mode.format === "json") {
    emitDocument(
      deps,
      {
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        routes: include,
        platform,
        detectedFrom: file,
        install,
        secretName: SECRET_NAME,
        secretCommand,
        snippet,
      },
      { config: shown },
    );
    return EXIT.ok;
  }

  const log = (line = "") => deps.logger.log(line);
  log(`${green("✓")} wrote network.publicKey and network.routes.include to ${shown}`);
  log(
    dim(
      `  protected routes: ${include.join(", ")} — edit network.routes in ${shown} to match your API`,
    ),
  );
  log("");
  log(bold("Private key") + dim(" — your server's secret store only, never in git:"));
  log(`  ${pair.privateKey}`);
  log("");
  if (platform === "cloudflare") {
    log(`${bold("Cloudflare")} ${dim(`(${file})`)}`);
    log("1. Install the server package:");
    log(commandLine(install));
    log(`2. Store the private key as a Worker secret (paste it when wrangler asks):`);
    log(commandLine(secretCommand ?? ""));
    log(`3. Wrap your ${hono ? "Hono app" : "Worker"}:`);
  } else {
    log(bold("Fetch-style server") + dim(" (Deno, Bun, Node 18+)"));
    log("1. Install the server package:");
    log(commandLine(install));
    log(`2. Store the private key in your secret store as ${SECRET_NAME}.`);
    log("3. Wrap your fetch handler:");
  }
  log("");
  for (const line of snippet.split("\n")) log(`   ${line}`);
  log("");
  log(
    yellow("!") +
      " Edge WAF rules and rate limits keyed on an API path now see only POST to the tunnel path." +
      " Move them into the handler, keyed on the unwrapped request.",
  );
  return EXIT.ok;
}

export function network(deps: NetworkDeps): ExitCode {
  const [command, ...rest] = deps.positionals;
  if (command !== "keygen" && command !== "init") {
    return fail(
      deps,
      EXIT.usage,
      "UNKNOWN_COMMAND",
      command === undefined
        ? "`afterpack network` takes a command"
        : `\`${command}\` is not an \`afterpack network\` command`,
      NETWORK_USAGE,
    );
  }
  if (rest.length > 0) {
    return fail(
      deps,
      EXIT.usage,
      "TOO_MANY_ARGUMENTS",
      `\`afterpack network ${command}\` takes no arguments, got ${rest.join(" ")}`,
      NETWORK_USAGE,
    );
  }
  return command === "keygen" ? keygen(deps) : init(deps);
}
