import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type Fixture, REPO_ROOT, selectedFixtures } from "./helpers/registry.js";

export interface BuildJob {
  label: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
  clean: string[];
  log: string;
  exitCodeFile: string;
}

export function buildJobsOf(fixture: Fixture): BuildJob[] {
  const jobs: BuildJob[] = [
    {
      label: fixture.name,
      cwd: fixture.dir,
      command: fixture.buildCommand,
      env: fixture.env,
      clean: fixture.clean,
      log: fixture.buildLog,
      exitCodeFile: `${fixture.buildLog}.exit`,
    },
  ];
  if (fixture.baseline) {
    jobs.push({
      label: `${fixture.name} (baseline)`,
      cwd: fixture.dir,
      command: fixture.baseline.buildCommand,
      env: fixture.baseline.env,
      clean: [],
      log: fixture.baseline.buildLog,
      exitCodeFile: `${fixture.baseline.buildLog}.exit`,
    });
  }
  return jobs;
}

interface JobResult {
  job: BuildJob;
  code: number;
  seconds: number;
  tail: string;
}

function runJob(job: BuildJob): Promise<JobResult> {
  rmSync(job.exitCodeFile, { force: true });
  for (const path of job.clean) rmSync(path, { recursive: true, force: true });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(job.command, {
      cwd: job.cwd,
      shell: true,
      env: { ...process.env, ...job.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let captured = "";
    child.stdout.on("data", (chunk) => {
      captured += chunk;
    });
    child.stderr.on("data", (chunk) => {
      captured += chunk;
    });
    const finish = (code: number, extra = "") => {
      const log = `${captured}${extra}`;
      mkdirSync(dirname(job.log), { recursive: true });
      writeFileSync(job.log, log);
      writeFileSync(job.exitCodeFile, `${code}\n`);
      resolve({ job, code, seconds: (Date.now() - started) / 1000, tail: log.slice(-4000) });
    };
    child.on("error", (error) => finish(1, `\n${String(error)}`));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function defaultConcurrency(): number {
  const requested = Number(process.env.AFTERPACK_E2E_BUILD_CONCURRENCY);
  if (Number.isInteger(requested) && requested >= 1) return requested;
  return Math.max(1, Math.min(3, availableParallelism() - 1));
}

export async function buildFixtures(
  fixtures: Fixture[],
  concurrency = defaultConcurrency(),
): Promise<boolean> {
  const queue = [...fixtures].sort((a, b) => b.weight - a.weight).flatMap(buildJobsOf);
  const results: JobResult[] = [];
  const started = Date.now();
  console.log(`building ${queue.length} e2e fixture build(s), ${concurrency} at a time`);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const result = await runJob(job);
        results.push(result);
        const status = result.code === 0 ? "built " : "FAILED";
        console.log(`${status}  ${job.label}  ${result.seconds.toFixed(1)}s`);
      }
    }),
  );
  const failed = results.filter((result) => result.code !== 0);
  for (const { job, code, tail } of failed) {
    console.error(
      `\n${job.label}: \`${job.command}\` exited ${code} in ${relative(REPO_ROOT, job.cwd)}\n${tail}`,
    );
  }
  const wall = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${results.length - failed.length}/${results.length} build(s) passed in ${wall}s`);
  return failed.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ok = await buildFixtures(selectedFixtures());
  process.exit(ok ? 0 : 1);
}
