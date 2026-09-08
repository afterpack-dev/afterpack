import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  collectJsFiles,
  createTelemetryReporter,
  type EngineBatchResult,
  type EngineDiagnostic,
  type EngineFileResult,
  type ObfuscationEngine,
  type ObfuscationPassResult,
  type ResolvedPluginConfig,
  resolvePluginConfig,
  runObfuscationPass,
} from "@afterpack/integration-utils";
import {
  expandShortFlags,
  HELP,
  parseSubcommandArgs,
  QUICKSTART,
  toRunOptions,
  USAGE,
} from "./args.js";
import { AUDIT_HELP, audit } from "./audit.js";
import { detectBuildOutput, detectBundler } from "./detect.js";
import { EXIT, type ExitCode, failureExitCode, SIZE_CAP_CODE } from "./exit.js";
import {
  type CommandName,
  emitJson,
  type JsonDiagnostic,
  type JsonDocument,
  jsonError,
  type OutputMode,
  outputModeOf,
  parseEngineDiagnostics,
  reportingLogger,
  resolveOutputMode,
  sortDiagnostics,
  sortedRecord,
  toJsonDiagnostic,
} from "./output.js";
import { readBuildId, VERIFY_HELP, verify } from "./verify.js";

export interface CliLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export interface CliStdout {
  isTTY: boolean;
  write(chunk: string): void;
}

export interface CliDeps {
  argv: string[];
  cwd: string;
  engine: ObfuscationEngine;
  logger: CliLogger;
  version: string;
  env?: Record<string, string | undefined>;
  stdout?: CliStdout;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

const DIRECTIVES_UNSUPPORTED =
  "the CLI obfuscates already-built output, where the `/* @afterpack */` comments are gone " +
  "and no source map places them. Use a bundler plugin, which captures them before minification.";

const NOT_A_COMMAND: Readonly<Record<string, string>> = {
  obfuscate:
    "obfuscation IS the bare command — write `afterpack <path>`, or `afterpack` with no path " +
    "to obfuscate the build output it detects",
};

const COMMAND_HINT =
  "the commands are `verify` and `audit`; obfuscation is `afterpack <path>`, with no subcommand";

function unknownCommand(
  argv: readonly string[],
  cwd: string,
): { name: string; fix: string } | null {
  const positionals = argv.filter((token) => !token.startsWith("-"));
  const first = positionals[0];
  if (first === undefined) return null;
  const expected = NOT_A_COMMAND[first];
  if (expected) return { name: first, fix: expected };
  const looksLikePath = /[\\/.]/.test(first) || existsSync(resolve(cwd, first));
  if (positionals.length > 1 && !looksLikePath) return { name: first, fix: COMMAND_HINT };
  return null;
}

interface CapturedFile {
  filePath: string;
  bytesIn: number;
  bytesOut: number;
  status: string;
  unobfuscated: boolean;
  diagnostics: EngineDiagnostic[];
}

function observeEngine(engine: ObfuscationEngine, into: CapturedFile[]): ObfuscationEngine {
  return {
    processBatch: async (inputs, configJson, buildContextJson) => {
      const bytesIn = new Map(inputs.map((i) => [i.filePath, Buffer.byteLength(i.source)]));
      const batch: EngineBatchResult = await engine.processBatch(
        inputs,
        configJson,
        buildContextJson,
      );
      for (const file of batch.files) into.push(captureFile(file, bytesIn.get(file.filePath) ?? 0));
      return batch;
    },
    ...(engine.version ? { version: () => (engine.version as () => Promise<string>)() } : {}),
  };
}

function captureFile(file: EngineFileResult, bytesIn: number): CapturedFile {
  return {
    filePath: file.filePath,
    bytesIn,
    bytesOut: Buffer.byteLength(file.code),
    status: file.status,
    unobfuscated: file.unobfuscated === true,
    diagnostics: parseEngineDiagnostics(file.diagnostics).map((d) => ({
      ...d,
      file: d.file ?? file.filePath,
    })),
  };
}

function documentPath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel === "" || rel.startsWith("..") ? filePath : rel.split(sep).join("/");
}

function fileStatus(file: CapturedFile): string {
  if (file.status === "failure") return "failed";
  if (file.unobfuscated) return "unobfuscated";
  return file.bytesOut === file.bytesIn && file.diagnostics.length === 0
    ? "unchanged"
    : "obfuscated";
}

function buildDocument(input: {
  version: string;
  cwd: string;
  exitCode: ExitCode;
  files: CapturedFile[];
  result: ObfuscationPassResult | null;
  transformed: ReadonlySet<string>;
}): JsonDocument {
  const { cwd, files, result } = input;
  const asJson = (d: EngineDiagnostic): JsonDiagnostic => {
    const rendered = toJsonDiagnostic(d);
    return d.file ? { ...rendered, file: documentPath(cwd, d.file) } : rendered;
  };
  const all = files.flatMap((f) => f.diagnostics);
  const byCode: Record<string, number> = {};
  for (const d of all) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
  return {
    afterpack: input.version,
    command: "obfuscate",
    exitCode: input.exitCode,
    ok: input.exitCode === EXIT.ok,
    files: [...files]
      .map((f) => ({
        path: documentPath(cwd, f.filePath),
        status: input.transformed.has(f.filePath) ? "obfuscated" : fileStatus(f),
        bytesIn: f.bytesIn,
        bytesOut: f.bytesOut,
        diagnostics: sortDiagnostics(f.diagnostics.map(asJson)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    diagnostics: sortDiagnostics(all.map(asJson)),
    summary: {
      files: files.length,
      transformed: input.transformed.size,
      unobfuscated: files.filter((f) => f.unobfuscated).length,
      failed: files.filter((f) => f.status === "failure").length,
      bytesIn: files.reduce((n, f) => n + f.bytesIn, 0),
      bytesOut: files.reduce((n, f) => n + f.bytesOut, 0),
      ...(result ? { seed: result.seed, seedOrigin: result.seedOrigin } : {}),
      engine: result?.timing.engineSource ?? null,
      diagnostics: {
        total: all.length,
        info: all.filter((d) => d.severity === "info").length,
        error: all.filter((d) => d.severity === "error").length,
        critical: all.filter((d) => d.severity === "critical").length,
        byCode: sortedRecord(byCode),
      },
    },
    artifacts: result?.protectionMapPath
      ? { protectionMap: documentPath(cwd, result.protectionMapPath) }
      : {},
  };
}

function refuse(input: {
  logger: CliLogger;
  mode: OutputMode;
  version: string;
  command: CommandName;
  exitCode: ExitCode;
  code: string;
  message: string;
  fix: string;
  detail?: string[];
}): ExitCode {
  if (input.mode.format === "json") {
    emitJson(
      input.logger,
      jsonError({
        version: input.version,
        command: input.command,
        exitCode: input.exitCode,
        code: input.code,
        message: input.message,
        fix: input.fix,
      }),
    );
    return input.exitCode;
  }
  input.logger.error(`afterpack: ${input.message}`);
  for (const line of input.detail ?? []) input.logger.error(line);
  input.logger.error(`afterpack: ${input.fix}`);
  return input.exitCode;
}

export async function run(deps: CliDeps): Promise<number> {
  const startedAt = Date.now();
  const { cwd, engine, logger, version } = deps;
  const env = deps.env ?? process.env;
  const stdout: CliStdout = deps.stdout ?? {
    isTTY: process.stdout.isTTY === true,
    write: (chunk: string) => {
      process.stdout.write(chunk);
    },
  };
  const argv = expandShortFlags(deps.argv);

  if (argv.includes("--version")) {
    logger.log(version);
    return EXIT.ok;
  }

  const command = argv[0];
  if (command === "verify" || command === "audit") {
    return runSubcommand(command, argv.slice(1), { ...deps, env, stdout, argv });
  }

  const unknown = unknownCommand(argv, cwd);
  if (unknown) {
    const mode = resolveOutputMode({ argv, env, cwd }).mode;
    return refuse({
      logger,
      mode,
      version,
      command: "obfuscate",
      exitCode: EXIT.usage,
      code: "UNKNOWN_COMMAND",
      message: `\`${unknown.name}\` is not an afterpack command`,
      fix: unknown.fix,
    });
  }

  let resolved: ResolvedPluginConfig;
  try {
    resolved = resolvePluginConfig({
      label: "afterpack",
      cwd,
      argv,
      env,
      unsupported: { directives: DIRECTIVES_UNSUPPORTED },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mode = resolveOutputMode({ argv, env, cwd }).mode;
    if (mode.format === "json") {
      emitJson(
        logger,
        jsonError({
          version,
          command: "obfuscate",
          exitCode: EXIT.usage,
          code: "INVALID_CONFIG",
          message,
          fix: "Fix or drop the key(s) named above; `afterpack --help` lists every spelling.",
        }),
      );
      return EXIT.usage;
    }
    logger.error(message);
    logger.error(USAGE);
    return EXIT.usage;
  }

  if (resolved.help) {
    logger.log(HELP);
    return EXIT.ok;
  }
  if (resolved.version) {
    logger.log(version);
    return EXIT.ok;
  }

  const mode = outputModeOf(resolved.config);
  const report = reportingLogger(logger, mode);
  const notice: CliLogger = {
    log: mode.format === "json" ? (m) => logger.error(m) : (m) => logger.log(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  };
  const refuseHere = (
    exitCode: ExitCode,
    code: string,
    message: string,
    fix: string,
    detail?: string[],
  ): ExitCode =>
    refuse({
      logger,
      mode,
      version,
      command: "obfuscate",
      exitCode,
      code,
      message,
      fix,
      detail,
    });

  if (resolved.positionals.length > 1) {
    return refuseHere(
      EXIT.usage,
      "TOO_MANY_PATHS",
      `expected a single [path], got ${resolved.positionals.length}`,
      "Name one directory or one .js file; run it again for the second target.",
    );
  }

  const parsed = toRunOptions(resolved.config);
  if (resolved.configFile) report.log(`afterpack: using ${resolved.configFile}`);
  if (parsed.build?.autorun === false) {
    if (mode.format === "json") {
      emitJson(logger, {
        afterpack: version,
        command: "obfuscate",
        exitCode: EXIT.ok,
        ok: true,
        files: [],
        diagnostics: [],
        summary: { files: 0, skipped: "build.autorun=false" },
        artifacts: {},
      });
      return EXIT.ok;
    }
    report.log("afterpack: build.autorun is false, skipping obfuscation");
    return EXIT.ok;
  }

  let requested = resolved.positionals[0];
  if (requested === undefined) {
    const detected = detectBuildOutput(cwd);
    if (!detected) {
      if (mode.format === "json") {
        return refuseHere(
          EXIT.failure,
          "NO_BUILD_OUTPUT",
          "no build output found in the working directory",
          "Build the project first, or name the directory: `afterpack <path>`.",
        );
      }
      logger.error(QUICKSTART);
      return EXIT.failure;
    }
    requested = detected.dir;
    report.log(
      `afterpack: no path given — using ${detected.dir}/ (${detected.reason}); ` +
        "obfuscating it IN PLACE, so build again before re-running",
    );
  }

  const target = isAbsolute(requested) ? requested : resolve(cwd, requested);
  if (!existsSync(target)) {
    return refuseHere(
      EXIT.failure,
      "PATH_NOT_FOUND",
      `path not found: ${requested}`,
      "Name an existing directory or .js file, or run `afterpack` with no path to detect the build output.",
    );
  }
  const isDirectory = statSync(target).isDirectory();
  const buildDir = isDirectory ? target : dirname(target);

  const files = collectJsFiles(target, { include: parsed.pathsInclude });
  if (files.length === 0) {
    return refuseHere(
      EXIT.failure,
      isDirectory ? "NO_JS_FOUND" : "NOT_OBFUSCATABLE",
      isDirectory
        ? `no .js/.mjs/.cjs files found under ${requested}`
        : `not an obfuscatable .js/.mjs/.cjs file: ${requested}`,
      isDirectory
        ? "Point it at the directory your build wrote, or add --paths.include='**/node_modules/**' to walk vendor code too."
        : "Pass a .js, .mjs or .cjs file — not a map, a backup copy, or another asset.",
    );
  }

  const captured: CapturedFile[] = [];
  let result: ObfuscationPassResult | null = null;
  let failure: string | null = null;
  try {
    result = await runObfuscationPass({
      files,
      engine: observeEngine(engine, captured),
      label: "afterpack",
      gitignoreDir: cwd,
      startedAt,
      combinedProtectionMap: { buildDir, afterpackDir: join(cwd, ".afterpack") },
      artifactOptions: parsed.artifactOptions,
      telemetry: createTelemetryReporter({ logger: notice }),
      clientVersion: version,
      seed: parsed.seed,
      preset: parsed.preset,
      complexity: parsed.complexity,
      diagnostics: parsed.diagnostics?.level,
      engineConfig: parsed.engineConfig,
      directives: false,
      receipt: { buildId: readBuildId(buildDir) },
      logger: report,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const diagnostics = captured.flatMap((f) => f.diagnostics);
  if (failure !== null) {
    const exitCode = failureExitCode(diagnostics);
    return refuseHere(
      exitCode,
      exitCode === EXIT.sizeCap ? SIZE_CAP_CODE : "BUILD_FAILED",
      failure,
      exitCode === EXIT.sizeCap
        ? "Raise --inflation.max, or lower --complexity, so the target fits the size budget."
        : "Fix the diagnostic(s) above, or carve the file out with --paths.exclude=<glob>. " +
            "Your build output was left exactly as your bundler wrote it.",
    );
  }

  const unobfuscated = captured.filter((f) => f.unobfuscated);
  const exitCode: ExitCode = unobfuscated.length > 0 ? EXIT.partial : EXIT.ok;

  if (mode.format === "json") {
    emitJson(
      logger,
      buildDocument({
        version,
        cwd,
        exitCode,
        files: captured,
        result,
        transformed: new Set(result?.transformedFiles ?? []),
      }),
    );
    return exitCode;
  }

  if (exitCode === EXIT.partial) {
    logger.error(
      `afterpack: ${unobfuscated.length} file(s) shipped UNOBFUSCATED (allowUnobfuscated) — ` +
        "drop --allowUnobfuscated and report the engine bug at " +
        "https://github.com/afterpack-dev/afterpack/issues so the build can fail closed again.",
    );
  }
  const bundler = detectBundler(cwd);
  if (bundler) report.log(`afterpack: ${bundler.hint}`);
  return exitCode;
}

async function runSubcommand(
  command: "verify" | "audit",
  rest: string[],
  deps: CliDeps & { env: Record<string, string | undefined>; stdout: CliStdout },
): Promise<number> {
  const { cwd, logger, version, env, stdout } = deps;
  const args = parseSubcommandArgs(rest, command);
  if (args.help) {
    logger.log(command === "verify" ? VERIFY_HELP : AUDIT_HELP);
    return EXIT.ok;
  }

  const { mode, issues } = resolveOutputMode({ argv: rest, env, cwd });
  const allIssues = [...args.issues, ...issues];
  if (allIssues.length > 0) {
    return refuse({
      logger,
      mode,
      version,
      command,
      exitCode: EXIT.usage,
      code: "INVALID_OPTION",
      message: allIssues.join("; "),
      fix: `Run \`afterpack ${command} --help\` for the options this command takes.`,
    });
  }

  const report = reportingLogger(logger, mode);
  if (command === "verify") {
    return verify({ cwd, logger, report, positionals: args.positionals, mode, version });
  }
  return audit({
    positionals: args.positionals,
    logger,
    report,
    env,
    mode,
    version,
    stdout,
    fetchImpl: deps.fetchImpl,
  });
}
