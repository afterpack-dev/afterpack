import {
  type Browser,
  expect,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
  test,
} from "@playwright/test";
import { currentFixture } from "./current.js";
import { stripHashes } from "./normalize.js";
import type { Fixture } from "./registry.js";

export type BuildKind = "baseline" | "protected";

export interface ScenarioRun {
  page: Page;
  build: BuildKind;
  checkpoint(label: string, scope?: Locator): Promise<void>;
  inPlace(label: string, action: () => Promise<unknown>): Promise<void>;
}

export type ScenarioSteps = (run: ScenarioRun) => Promise<void>;

export interface Recording {
  build: BuildKind;
  problems: string[];
  requests: string[];
  documents: number;
  snapshots: [string, string][];
  milliseconds: number;
}

export interface Corruption {
  url: RegExp;
  transform: (body: string) => string;
}

const BROWSER_INITIATED = /^\/favicon\.[a-z]+(?:\?.*)?$/;
const TIMING_DEPENDENT_WARNINGS = [/was preloaded using link preload but not used/];
const CLIENT_ABORT = /aborted|cancel/i;
const ABORTED = "aborted";
const SETTLE_QUIET_MS = 300;
const SETTLE_TIMEOUT_MS = 10_000;
const IN_PLACE_MARKER = "__afterpackInPlace";

export function normalizeUrl(url: string, origin: string): string {
  const parsed = new URL(url);
  const where = parsed.origin === origin ? "" : parsed.origin;
  return `${where}${stripHashes(`${parsed.pathname}${parsed.search}`)}`;
}

export function normalizeMessage(text: string, origin: string): string {
  return stripHashes(text.replaceAll(origin, "").replace(/:\d+:\d+/g, ""));
}

function serverOf(app: Fixture, build: BuildKind): string {
  if (build === "protected") {
    if (!app.baseURL) throw new Error(`${app.name} serves no browser surface`);
    return app.baseURL;
  }
  if (!app.baseline) throw new Error(`${app.name} declares no baseline build for scenarios`);
  return app.baseline.baseURL;
}

function failureOf(build: BuildKind, recording: Recording, message: string): string {
  const blame =
    build === "baseline"
      ? "the unprotected baseline failed the scenario, so the fixture or the scenario is wrong"
      : "the protected build failed a scenario the baseline passed";
  const seen = recording.problems.length
    ? `\n\nconsole and page errors in the ${build} build:\n  ${recording.problems.join("\n  ")}`
    : "";
  return `${blame}: ${message}${seen}`;
}

export async function recordScenario(
  browser: Browser,
  app: Fixture,
  build: BuildKind,
  steps: ScenarioSteps,
  corruption?: Corruption,
): Promise<Recording> {
  const baseURL = serverOf(app, build);
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const recording: Recording = {
    build,
    problems: [],
    requests: [],
    documents: 0,
    snapshots: [],
    milliseconds: 0,
  };
  const pending = new Set<Request>();
  const settled: Promise<void>[] = [];

  if (corruption) {
    await context.route(corruption.url, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: corruption.transform(await response.text()) });
    });
  }

  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const text = message.text();
    if (TIMING_DEPENDENT_WARNINGS.some((pattern) => pattern.test(text))) return;
    recording.problems.push(`console.${type}: ${normalizeMessage(text, origin)}`);
  });
  page.on("pageerror", (error) => {
    recording.problems.push(`pageerror: ${normalizeMessage(error.message, origin)}`);
  });
  page.on("request", (request) => {
    pending.add(request);
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      recording.documents += 1;
    }
  });
  const finish = (request: Request, outcome: Promise<string>) => {
    settled.push(
      outcome.then((status) => {
        pending.delete(request);
        const path = normalizeUrl(request.url(), origin);
        if (!BROWSER_INITIATED.test(path)) {
          recording.requests.push(`${request.method()} ${path} ${status}`);
        }
      }),
    );
  };
  page.on("requestfinished", (request) =>
    finish(
      request,
      request.response().then((response) => String(response?.status() ?? "no-response")),
    ),
  );
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown";
    finish(request, Promise.resolve(CLIENT_ABORT.test(reason) ? ABORTED : `failed (${reason})`));
  });

  const settle = async () => {
    await expect
      .poll(
        async () => {
          const before = pending.size;
          await page.waitForTimeout(SETTLE_QUIET_MS);
          return before === 0 && pending.size === 0;
        },
        { timeout: SETTLE_TIMEOUT_MS, message: `${build}: requests never settled` },
      )
      .toBe(true);
  };

  const run: ScenarioRun = {
    page,
    build,
    async checkpoint(label, scope) {
      await settle();
      recording.snapshots.push([label, await (scope ?? page.locator("body")).ariaSnapshot()]);
    },
    async inPlace(label, action) {
      const token = `${build}-${Date.now()}`;
      await page.evaluate(
        ([key, value]) => {
          (window as unknown as Record<string, string>)[key] = value;
        },
        [IN_PLACE_MARKER, token],
      );
      await action();
      const survived = await page.evaluate(
        (key) => (window as unknown as Record<string, string | undefined>)[key] ?? null,
        IN_PLACE_MARKER,
      );
      expect(
        survived,
        `${build}: "${label}" reloaded the page instead of navigating in place`,
      ).toBe(token);
    },
  };

  const started = Date.now();
  try {
    await test.step(`${build} build`, () => steps(run));
    await settle();
    await Promise.all(settled);
  } catch (error) {
    if (error instanceof Error) error.message = failureOf(build, recording, error.message);
    throw error;
  } finally {
    recording.milliseconds = Date.now() - started;
    await context.close();
  }
  return recording;
}

function multisetMinus(from: string[], remove: string[]): string[] {
  const left = [...remove];
  return from.filter((item) => {
    const index = left.indexOf(item);
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

function withoutOutcome(request: string): string {
  return request.slice(0, request.lastIndexOf(" "));
}

function isAborted(request: string): boolean {
  return request.endsWith(` ${ABORTED}`);
}

function pairAborted(from: string[], against: string[]): void {
  for (let index = from.length - 1; index >= 0; index--) {
    if (!isAborted(from[index])) continue;
    const partner = against.findIndex(
      (request) => withoutOutcome(request) === withoutOutcome(from[index]),
    );
    if (partner < 0) continue;
    against.splice(partner, 1);
    from.splice(index, 1);
  }
}

export function unmatchedRequests(candidate: string[], baseline: string[]): [string[], string[]] {
  const extra = multisetMinus(candidate, baseline);
  const missing = multisetMinus(baseline, candidate);
  pairAborted(extra, missing);
  pairAborted(missing, extra);
  return [extra, missing];
}

export function parityProblems(baseline: Recording, candidate: Recording): string[] {
  const problems: string[] = [];
  for (const added of multisetMinus(candidate.problems, baseline.problems)) {
    problems.push(`new ${added}`);
  }
  const [extra, missing] = unmatchedRequests(candidate.requests, baseline.requests);
  for (const request of extra) problems.push(`request only the protected build made: ${request}`);
  for (const request of missing) problems.push(`request only the baseline made: ${request}`);
  if (candidate.documents !== baseline.documents) {
    problems.push(
      `document loads: protected ${candidate.documents}, baseline ${baseline.documents}`,
    );
  }
  const checkpoints = Math.max(baseline.snapshots.length, candidate.snapshots.length);
  for (let index = 0; index < checkpoints; index++) {
    const [label, want] = baseline.snapshots[index] ?? [candidate.snapshots[index][0], undefined];
    const got = candidate.snapshots[index]?.[1];
    if (want === undefined) problems.push(`checkpoint "${label}" never reached by the baseline`);
    else if (got === undefined) problems.push(`checkpoint "${label}" never reached`);
    else if (want !== got) {
      problems.push(`checkpoint "${label}" differs:\n--- baseline\n${want}\n--- protected\n${got}`);
    }
  }
  return problems;
}

export function scenario(steps: ScenarioSteps) {
  return async ({ browser }: { browser: Browser }, testInfo: TestInfo): Promise<void> => {
    const app = currentFixture();
    const baseline = await recordScenario(browser, app, "baseline", steps);
    const candidate = await recordScenario(browser, app, "protected", steps);
    for (const recording of [baseline, candidate]) {
      await testInfo.attach(`${recording.build}.json`, {
        body: JSON.stringify(recording, null, 2),
        contentType: "application/json",
      });
    }
    testInfo.annotations.push({
      type: "timing",
      description: `protected ${candidate.milliseconds} ms, baseline ${baseline.milliseconds} ms`,
    });
    expect(
      parityProblems(baseline, candidate),
      "protected build diverged from the baseline",
    ).toEqual([]);
  };
}
