import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  AlreadyObfuscatedError,
  type ClientIdentity,
  CloudApiError,
  CoreVersionError,
  collectJsFiles,
  createTelemetryReporter,
  DIAG_ALREADY_OBFUSCATED,
  type EngineBatchResult,
  type EngineDiagnostic,
  type EngineFileResult,
  getPath,
  type ObfuscationEngine,
  type ObfuscationPassResult,
  type ResolvedPluginConfig,
  resolvePluginConfig,
  runObfuscationPass,
  UnreadableReceiptError,
} from "@afterpack/integration-utils";
import {
  type CliRunOptions,
  CONTACT_FOOTER,
  expandShortFlags,
  HELP,
  HELP_ALL,
  parseSubcommandArgs,
  toRunOptions,
} from "./args.js";
import { AUDIT_HELP, audit } from "./audit.js";
import {
  backupDir,
  backupManifestPath,
  captureOriginals,
  matchAlreadyObfuscated,
  type PendingBackup,
  projectRootFor,
  readBackupManifest,
  type WriteBackupsResult,
  writeBackups,
} from "./backup.js";
import { frameworkDocsUrl } from "./detect.js";
import { commandLine, commandRow, planBareRun } from "./dispatch.js";
import { EXIT, type ExitCode, failureExitCode, SIZE_CAP_CODE } from "./exit.js";
import { colorSupported, dim, green, isCiTruthy, red, setColorEnabled, yellow } from "./format.js";
import { printHeader } from "./header.js";
import {
  type CommandName,
  displayDir,
  documentPath,
  emitJson,
  emitJsonError,
  type JsonDiagnostic,
  type JsonDocument,
  type OutputMode,
  outputModeOf,
  parseEngineDiagnostics,
  reportingLogger,
  resolveOutputMode,
  sortDiagnostics,
  sortedRecord,
  toJsonDiagnostic,
} from "./output.js";
import { detectPackageManager } from "./package-manager.js";
import { withProgress } from "./progress.js";
import { RESTORE_HELP, restore } from "./restore.js";
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
  client?: ClientIdentity | null;
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
  "the commands are `verify`, `restore` and `audit`; obfuscation is `afterpack <path>`, " +
  "with no subcommand";

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

function alignRow(label: string, value: string): string {
  return `${label.padEnd(6)}${value}`;
}

function fileStatus(file: CapturedFile): string {
  if (file.status !== "success") return "failed";
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
      failed: files.filter((f) => f.status !== "success").length,
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

function dispatchGuidance(input: {
  logger: CliLogger;
  mode: OutputMode;
  version: string;
  code: string;
  message: string;
  fix: string;
  lines: readonly string[];
}): ExitCode {
  if (input.mode.format === "json") {
    emitJsonError(input.logger, {
      version: input.version,
      command: "obfuscate",
      exitCode: EXIT.failure,
      code: input.code,
      message: input.message,
      fix: input.fix,
    });
    return EXIT.failure;
  }
  for (const line of input.lines) input.logger.error(line);
  return EXIT.failure;
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
    emitJsonError(input.logger, {
      version: input.version,
      command: input.command,
      exitCode: input.exitCode,
      code: input.code,
      message: input.message,
      fix: input.fix,
    });
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

function resolveBareRun(input: {
  cwd: string;
  logger: CliLogger;
  mode: OutputMode;
  version: string;
  report: CliLogger;
}): { requested: string } | { exitCode: ExitCode } {
  const { cwd, logger, mode, version, report } = input;
  const plan = planBareRun(cwd);
  if (plan.kind === "integrationInstalled") {
    const pm = detectPackageManager(cwd);
    return {
      exitCode: dispatchGuidance({
        logger,
        mode,
        version,
        code: "INTEGRATION_INSTALLED",
        message: `${plan.framework.afterpackPackage} is installed; your build protects the output.`,
        fix: `Run ${pm.run("build")}.`,
        lines: [
          `${plan.framework.afterpackPackage} is installed.`,
          commandLine(pm.run("build")),
          dim(`docs ${frameworkDocsUrl(plan.framework)}`),
        ],
      }),
    };
  }
  if (plan.kind === "frameworkDetected") {
    const pm = detectPackageManager(cwd);
    const install = pm.install(plan.framework.afterpackPackage);
    return {
      exitCode: dispatchGuidance({
        logger,
        mode,
        version,
        code: "FRAMEWORK_DETECTED",
        message: `${plan.framework.name} detected; ${plan.framework.afterpackPackage} protects its build.`,
        fix: `Run ${install}.`,
        lines: [
          `${plan.framework.name} detected.`,
          commandLine(install),
          dim(`docs ${frameworkDocsUrl(plan.framework)}`),
        ],
      }),
    };
  }
  if (plan.kind === "nothing") {
    return {
      exitCode: dispatchGuidance({
        logger,
        mode,
        version,
        code: "NO_FRAMEWORK",
        message: "No framework detected in this directory.",
        fix: "Name the target yourself: afterpack <dir> or afterpack <file>.js",
        lines: [
          "No framework detected in this directory.",
          commandRow("afterpack dist/", "protect a built directory"),
          commandRow("afterpack app.js", "protect one file"),
          dim("docs https://www.afterpack.dev/docs/cli"),
        ],
      }),
    };
  }
  report.log(
    dim(
      `Using ${plan.detected.dir}/ (${plan.detected.reason}) · protected in place, rebuild before re-running`,
    ),
  );
  return { requested: plan.detected.dir };
}

async function runObfuscationAndBackup(input: {
  files: string[];
  engine: ObfuscationEngine;
  cwd: string;
  buildDir: string;
  startedAt: number;
  version: string;
  parsed: CliRunOptions;
  notice: CliLogger;
  report: CliLogger;
  stdout: CliStdout;
  mode: OutputMode;
  label: string;
  backupEnabled: boolean;
  projectRoot: string;
  pendingBackups: readonly PendingBackup[];
  client: ClientIdentity | null;
}): Promise<{
  captured: CapturedFile[];
  result: ObfuscationPassResult | null;
  failure: string | null;
  failureError: unknown;
  backupWritten: WriteBackupsResult | null;
}> {
  const captured: CapturedFile[] = [];
  let result: ObfuscationPassResult | null = null;
  let failure: string | null = null;
  let failureError: unknown = null;
  try {
    result = await withProgress({
      stdout: input.stdout,
      mode: input.mode,
      report: input.report,
      label: input.label,
      work: () =>
        runObfuscationPass({
          files: input.files,
          engine: observeEngine(input.engine, captured),
          label: "afterpack",
          gitignoreDir: input.cwd,
          startedAt: input.startedAt,
          combinedProtectionMap: {
            buildDir: input.buildDir,
            afterpackDir: join(input.cwd, ".afterpack"),
          },
          artifactOptions: { ...input.parsed.artifactOptions, build: { backup: false } },
          telemetry: createTelemetryReporter({ logger: input.notice }),
          clientVersion: input.version,
          client: input.client,
          seed: input.parsed.seed,
          preset: input.parsed.preset,
          complexity: input.parsed.complexity,
          diagnostics: input.parsed.diagnostics?.level,
          engineConfig: input.parsed.engineConfig,
          directives: false,
          receipt: { buildId: readBuildId(input.buildDir) },
          logger: input.report,
          summaryStyle: "cli",
          colorGlyph: green,
        }),
    });
  } catch (error) {
    failureError = error;
    failure = error instanceof Error ? error.message : String(error);
  }

  let backupWritten: WriteBackupsResult | null = null;
  if (failureError === null && failure === null && input.backupEnabled) {
    backupWritten = writeBackups({
      projectRoot: input.projectRoot,
      protectedRoot: input.buildDir,
      cliVersion: input.version,
      pending: input.pendingBackups,
      receiptPath: result?.receiptPath ?? null,
    });
  }

  return { captured, result, failure, failureError, backupWritten };
}

function renderNextSteps(input: {
  report: CliLogger;
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: CliStdout;
  projectRoot: string;
  receiptPath: string | null | undefined;
  backupWritten: WriteBackupsResult | null;
  hasConfiguredKey: boolean;
}): void {
  const { report, cwd, env, stdout, projectRoot, receiptPath, backupWritten, hasConfiguredKey } =
    input;
  if (receiptPath) {
    report.log(`  receipt  ${documentPath(cwd, receiptPath)}`);
  }
  if (backupWritten !== null && backupWritten.count > 0) {
    report.log(`  backup   ${documentPath(cwd, backupDir(projectRoot))}/`);
  }
  if (receiptPath || backupWritten !== null) {
    report.log("");
  }
  if (receiptPath) {
    report.log(alignRow("next", "afterpack verify   before you deploy"));
  }
  if (backupWritten !== null && backupWritten.count > 0) {
    report.log(alignRow("undo", "afterpack restore"));
  }
  if (stdout.isTTY && !hasConfiguredKey && !isCiTruthy(env.CI)) {
    report.log(dim(alignRow("pro", "10 MB/month free · https://www.afterpack.dev/login")));
  }
}

function refuseAlreadyObfuscated(
  logger: CliLogger,
  cwd: string,
  mode: OutputMode,
  version: string,
  error: AlreadyObfuscatedError,
): ExitCode {
  if (mode.format === "json") {
    emitJsonError(logger, {
      version,
      command: "obfuscate",
      exitCode: EXIT.failure,
      code: DIAG_ALREADY_OBFUSCATED,
      message: `${error.files.length} file(s) already carry AfterPack output from a previous run`,
      fix: "Rebuild from source (clean your bundler's output, or delete the directory) before running AfterPack again.",
    });
    return EXIT.failure;
  }
  renderAlreadyObfuscated(logger, cwd, error);
  return EXIT.failure;
}

function refusalFor(
  error: unknown,
): { exitCode: ExitCode; code: string; message: string; fix: string } | null {
  if (error instanceof CloudApiError) {
    const code = error.apiCode ?? error.code;
    return error.kind === "api"
      ? {
          exitCode: EXIT.failure,
          code,
          message: error.message,
          fix: "Nothing was written; your build output was left exactly as your bundler wrote it.",
        }
      : {
          exitCode: EXIT.updateRequired,
          code,
          message: error.message,
          fix: `Update, then build again: ${error.fix}`,
        };
  }
  if (error instanceof CoreVersionError) {
    return {
      exitCode: EXIT.updateRequired,
      code: error.code,
      message: error.message,
      fix: `Update, then build again: ${error.fix}`,
    };
  }
  if (error instanceof UnreadableReceiptError) {
    return {
      exitCode: EXIT.failure,
      code: error.code,
      message: error.message,
      fix: "Update afterpack, or rebuild from source and delete the receipt, then run it again.",
    };
  }
  return null;
}

export function defaultCliStdout(): CliStdout {
  return {
    isTTY: process.stdout.isTTY === true,
    write: (chunk: string) => {
      process.stdout.write(chunk);
    },
  };
}

export async function run(deps: CliDeps): Promise<number> {
  const startedAt = Date.now();
  const { cwd, engine, logger, version } = deps;
  const env = deps.env ?? process.env;
  const stdout: CliStdout = deps.stdout ?? defaultCliStdout();
  const argv = expandShortFlags(deps.argv);

  if (argv.includes("--version")) {
    logger.log(version);
    return EXIT.ok;
  }

  const command = argv[0];
  if (command === "verify" || command === "audit" || command === "restore") {
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
    return refuse({
      logger,
      mode: earlyMode,
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
    const mode = earlyMode;
    if (mode.format === "json") {
      emitJsonError(logger, {
        version,
        command: "obfuscate",
        exitCode: EXIT.usage,
        code: "INVALID_CONFIG",
        message,
        fix: "Fix or drop the key(s) named above; `afterpack --help` lists every spelling.",
      });
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
  const projectRoot = projectRootFor(cwd, resolved.configFile);
  const backupEnabled = parsed.artifactOptions.build?.backup ?? true;
  const configuredKey = getPath(resolved.config, "key");
  const hasConfiguredKey =
    (typeof configuredKey === "string" && configuredKey !== "") ||
    (typeof env.AFTERPACK_KEY === "string" && env.AFTERPACK_KEY !== "");
  if (resolved.configFile) {
    report.log(`afterpack: using ${documentPath(cwd, resolved.configFile)}`);
  }
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
    const bare = resolveBareRun({ cwd, logger, mode, version, report });
    if ("exitCode" in bare) return bare.exitCode;
    requested = bare.requested;
  } else {
    const explicitTarget = isAbsolute(requested) ? requested : resolve(cwd, requested);
    if (
      existsSync(explicitTarget) &&
      statSync(explicitTarget).isDirectory() &&
      existsSync(join(explicitTarget, "package.json"))
    ) {
      const bare = resolveBareRun({ cwd: explicitTarget, logger, mode, version, report });
      if ("exitCode" in bare) return bare.exitCode;
      requested = join(explicitTarget, bare.requested);
    }
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

  const nestedProjects: string[] = [];
  const files = collectJsFiles(target, {
    include: parsed.pathsInclude,
    onNestedProject: (dir) => nestedProjects.push(dir),
  });
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

  if (nestedProjects.length > 0) {
    const shown = nestedProjects.slice(0, 3).map((dir) => displayDir(cwd, dir));
    const more = nestedProjects.length > 3 ? `, +${nestedProjects.length - 3} more` : "";
    const plural = nestedProjects.length === 1 ? "" : "s";
    notice.warn(
      `${yellow("⚠")} Skipped ${shown.join(", ")}${more} — nested project${plural}, not build ` +
        `output. Protect ${nestedProjects.length === 1 ? "it" : "each"} from its own directory.`,
    );
  }

  const backupManifestResult = readBackupManifest(projectRoot);
  if (backupManifestResult.status === "corrupt") {
    notice.warn(
      `${yellow("⚠")} Backup manifest is unreadable: ${documentPath(cwd, backupManifestResult.path)} — ` +
        "the already-obfuscated check cannot use it.",
    );
  }
  const backupManifest =
    backupManifestResult.status === "ok" ? backupManifestResult.manifest : null;
  const pendingBackups: PendingBackup[] =
    backupEnabled || backupManifest ? captureOriginals(projectRoot, files) : [];
  if (backupManifest) {
    const matched = matchAlreadyObfuscated(backupManifest, pendingBackups);
    if (matched.length > 0) {
      return refuseAlreadyObfuscated(
        logger,
        cwd,
        mode,
        version,
        new AlreadyObfuscatedError(
          `${matched.length} file(s) already carry AfterPack output from a previous run`,
          matched,
          backupManifestPath(projectRoot),
          buildDir,
        ),
      );
    }
  }

  const progressLabel = `Protecting ${isDirectory ? displayDir(cwd, target) : documentPath(cwd, target)}…`;

  const { captured, result, failure, failureError, backupWritten } = await runObfuscationAndBackup({
    files,
    engine,
    cwd,
    buildDir,
    startedAt,
    version,
    parsed,
    notice,
    report,
    stdout,
    mode,
    label: progressLabel,
    backupEnabled,
    projectRoot,
    pendingBackups,
    client: deps.client ?? null,
  });

  if (failureError instanceof AlreadyObfuscatedError) {
    return refuseAlreadyObfuscated(logger, cwd, mode, version, failureError);
  }
  const refusal = refusalFor(failureError);
  if (refusal !== null) {
    return refuse({ logger, mode, version, command: "obfuscate", ...refusal });
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
      `${yellow("⚠")} ${unobfuscated.length} ${unobfuscated.length === 1 ? "file" : "files"} shipped UNOBFUSCATED — ` +
        "drop --allowUnobfuscated to fail closed instead.",
    );
    logger.error("");
    logger.error(dim(CONTACT_FOOTER));
    return exitCode;
  }

  renderNextSteps({
    report,
    cwd,
    env,
    stdout,
    projectRoot,
    receiptPath: result?.receiptPath,
    backupWritten,
    hasConfiguredKey,
  });
  return exitCode;
}

const SUBCOMMAND_HELP: Readonly<Record<"verify" | "audit" | "restore", string>> = {
  verify: VERIFY_HELP,
  restore: RESTORE_HELP,
  audit: AUDIT_HELP,
};

async function runSubcommand(
  command: "verify" | "audit" | "restore",
  rest: string[],
  deps: CliDeps & { env: Record<string, string | undefined>; stdout: CliStdout },
): Promise<number> {
  const { cwd, logger, version, env, stdout } = deps;
  const args = parseSubcommandArgs(rest, command);
  if (args.help) {
    logger.log(SUBCOMMAND_HELP[command]);
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
  if (command === "restore") {
    return restore({ cwd, logger, report, positionals: args.positionals, mode, version });
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
