import { generateKeyPairSync } from "node:crypto";
import { CONTACT_FOOTER } from "./args.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim } from "./format.js";
import { commandFailure, emitJson, JSON_SCHEMA_VERSION, type OutputMode } from "./output.js";
import type { CliLogger } from "./run.js";

const NETWORK_USAGE = "usage: afterpack network keygen [--diagnostics.format=text|json]";

export const NETWORK_HELP = `${NETWORK_USAGE}

Prepares network protection, which arrives in a later release: a Pro build will
seal the app's own API and socket traffic to your server's public key.

Commands:
  keygen                   print a new key pair (X25519, base64url, 32 bytes
                           each) from the OS random source. Writes nothing.

The private key belongs only in your server's secret store, never in git.

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout
  --help, -h               this help

Exit codes: 0 on success, 64 on a usage error.

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

function keygen(deps: NetworkDeps): ExitCode {
  const pair = generateNetworkKeyPair();
  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
      schemaVersion: JSON_SCHEMA_VERSION,
      afterpack: deps.version,
      command: "network",
      exitCode: EXIT.ok,
      ok: true,
      files: [],
      diagnostics: [],
      summary: { publicKey: pair.publicKey, privateKey: pair.privateKey },
      artifacts: {},
    });
    return EXIT.ok;
  }
  deps.logger.log(`publicKey   ${pair.publicKey}`);
  deps.logger.log(`privateKey  ${pair.privateKey}`);
  deps.logger.log("");
  deps.logger.log(dim("the private key goes ONLY in your server's secret store, never in git"));
  return EXIT.ok;
}

export function network(deps: NetworkDeps): ExitCode {
  const [command, ...rest] = deps.positionals;
  if (command !== "keygen") {
    return commandFailure(
      deps,
      "network",
      EXIT.usage,
      "UNKNOWN_COMMAND",
      command === undefined
        ? "`afterpack network` takes a command"
        : `\`${command}\` is not an \`afterpack network\` command`,
      NETWORK_USAGE,
    );
  }
  if (rest.length > 0) {
    return commandFailure(
      deps,
      "network",
      EXIT.usage,
      "TOO_MANY_ARGUMENTS",
      `\`afterpack network ${command}\` takes no arguments, got ${rest.join(" ")}`,
      NETWORK_USAGE,
    );
  }
  return keygen(deps);
}
