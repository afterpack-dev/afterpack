import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AlreadyObfuscatedError,
  collectJsFiles,
  createTelemetryReporter,
  DIAG_ALREADY_OBFUSCATED,
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
  CONTACT_FOOTER,
  expandShortFlags,
  HELP,
  HELP_ALL,
  OUTPUT_DIR_LIST,
  parseSubcommandArgs,
  toRunOptions,
} from "./args.js";
import { AUDIT_HELP, audit } from "./audit.js";
import { detectBuildOutput } from "./detect.js";
import { EXIT, type ExitCode, failureExitCode, SIZE_CAP_CODE } from "./exit.js";
import { colorSupported, dim, green, isCiTruthy, red, setColorEnabled, yellow } from "./format.js";
import { printHeader } from "./header.js";
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
import { withProgress } from "./progress.js";
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

function displayDir(cwd: string, dir: string): string {
  return `${documentPath(cwd, dir)}/`;
}

function alignRow(label: string, value: string): string {
  return `${label.padEnd(6)}${value}`;
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
  input.logger.error(`${red("✗")} ${input.message}`);
  if (input.detail && input.detail.length > 0) {
    input.logger.error("");
    for (const line of input.detail) input.logger.error(line);
  }
  input.logger.error("");
  input.logger.error(input.fix);
  input.logger.error("");
  input.logger.error(dim(CONTACT_FOOTER));
  return input.exitCode;
}

const UNKNOWN_OPTION_LINE =
  /^\s*command line:\s*unknown configuration key `([^`]+)` \(command line\) — (?:did you mean `([^`]+)`\?|see \S+)$/;

function unknownOptionFromMessage(
  message: string,
): { path: string; suggestion: string | null } | null {
  const lines = message.split("\n");
  if (lines.length !== 2) return null;
  const match = UNKNOWN_OPTION_LINE.exec(lines[1]);
  if (!match) return null;
  return { path: match[1], suggestion: match[2] ?? null };
}

function renderUnknownOption(logger: CliLogger, path: string, suggestion: string | null): void {
  logger.error(`${red("✗")} Unknown option \`--${path}\``);
  logger.error("");
  if (suggestion) {
    logger.error(`Did you mean \`--${suggestion}\`?`);
  }
  logger.error("See afterpack --help for every option.");
  logger.error("");
  logger.error(dim(CONTACT_FOOTER));
}

function renderInvalidConfig(logger: CliLogger, message: string): void {
  logger.error(`${red("✗")} Invalid configuration`);
  logger.error("");
  for (const line of message.split("\n").slice(1)) logger.error(line.trim());
  logger.error("");
  logger.error("See afterpack --help for every option.");
  logger.error("");
  logger.error(dim(CONTACT_FOOTER));
}

const ALREADY_OBFUSCATED_LIST_CAP = 10;

function renderAlreadyObfuscated(
  logger: CliLogger,
  cwd: string,
  error: AlreadyObfuscatedError,
): void {
  const relFiles = error.files.map((f) => documentPath(cwd, f));
  const relDir = displayDir(cwd, error.dir);
  logger.error(`${red("✗")} Already obfuscated`);
  logger.error("");
  if (relFiles.length === 1) {
    logger.error(`${relFiles[0]} already carries AfterPack output from a previous run.`);
  } else {
    logger.error(`${relFiles.length} files already carry AfterPack output from a previous run:`);
    const shown = relFiles.slice(0, ALREADY_OBFUSCATED_LIST_CAP);
    for (const f of shown) logger.error(`  ${f}`);
    const hidden = relFiles.length - shown.length;
    if (hidden > 0) logger.error(`  and ${hidden} more`);
  }
  logger.error("Output is not idempotent, so rebuild from source before running AfterPack again.");
  logger.error("");
  logger.error(alignRow("fix", `run your bundler's clean, or delete ${relDir}, then build again`));
  logger.error(
    relFiles.length === 1
      ? alignRow("skip", `afterpack --paths.exclude='**/${basename(relFiles[0])}'`)
      : alignRow("skip", "carve them out with --paths.exclude=<glob>"),
  );
  logger.error("");
  logger.error("Your build output was left unchanged.");
  logger.error("");
  logger.error(dim(CONTACT_FOOTER));
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

  const earlyMode = resolveOutputMode({ argv, env, cwd }).mode;
  setColorEnabled(earlyMode.format !== "json" && colorSupported(env, stdout.isTTY));
  await printHeader({
    stdout,
    env,
    version,
    mode: earlyMode,
    report: reportingLogger(logger, earlyMode),
  });

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
    const unknownOption = unknownOptionFromMessage(message);
    if (unknownOption) {
      renderUnknownOption(logger, unknownOption.path, unknownOption.suggestion);
    } else {
      renderInvalidConfig(logger, message);
    }
    return EXIT.usage;
  }

  if (resolved.help) {
    logger.log(argv.includes("--all") ? HELP_ALL : HELP);
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
      logger.error(`${red("✗")} No build output found`);
      logger.error("");
      logger.error(`None of ${OUTPUT_DIR_LIST} exists in the working directory.`);
      logger.error("");
      logger.error(alignRow("fix", "build your project first, then run afterpack again"));
      logger.error(alignRow("skip", "name the directory yourself: afterpack <path>"));
      logger.error("");
      logger.error(dim(CONTACT_FOOTER));
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

  const progressLabel = `Protecting ${isDirectory ? displayDir(cwd, target) : documentPath(cwd, target)}…`;

  const captured: CapturedFile[] = [];
  let result: ObfuscationPassResult | null = null;
  let failure: string | null = null;
  let failureError: unknown = null;
  try {
    result = await withProgress({
      stdout,
      mode,
      report,
      label: progressLabel,
      work: () =>
        runObfuscationPass({
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
          summaryStyle: "cli",
          colorGlyph: green,
        }),
    });
  } catch (error) {
    failureError = error;
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failureError instanceof AlreadyObfuscatedError) {
    if (mode.format === "json") {
      emitJson(
        logger,
        jsonError({
          version,
          command: "obfuscate",
          exitCode: EXIT.failure,
          code: DIAG_ALREADY_OBFUSCATED,
          message: `${failureError.files.length} file(s) already carry AfterPack output from a previous run`,
          fix: "Rebuild from source (clean your bundler's output, or delete the directory) before running AfterPack again.",
        }),
      );
      return EXIT.failure;
    }
    renderAlreadyObfuscated(logger, cwd, failureError);
    return EXIT.failure;
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
      `${yellow("⚠")} ${unobfuscated.length} file(s) shipped UNOBFUSCATED — ` +
        "drop --allowUnobfuscated to fail closed instead.",
    );
    logger.error("");
    logger.error(dim(CONTACT_FOOTER));
    return exitCode;
  }

  if (result?.receiptPath) {
    report.log(`  receipt  ${documentPath(cwd, result.receiptPath)}`);
    report.log("");
    report.log(alignRow("next", "afterpack verify   before you deploy"));
  }
  if (stdout.isTTY && !env.AFTERPACK_KEY && !isCiTruthy(env.CI)) {
    report.log(dim(alignRow("pro", "10 MB/month free · https://www.afterpack.dev/login")));
  }
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
