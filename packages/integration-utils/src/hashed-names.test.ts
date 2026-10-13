import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterpackHashSalt, prepareHashSalt, saltSettings } from "./hash-salt.js";
import { deriveHashToken, type HashTokenOf, planHashedNames } from "./hashed-names.js";
import { resetBuildSessions } from "./seed.js";

let root: string;

beforeEach(() => {
  resetBuildSessions();
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-hashed-names-")));
});
afterEach(() => {
  resetBuildSessions();
  rmSync(root, { recursive: true, force: true });
});

const DASH_TOKEN: HashTokenOf = (path) => /-([0-9a-f]{16})\.(?:js|css)$/.exec(path)?.[1] ?? null;

function write(rel: string, text: string | Buffer): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("deriveHashToken", () => {
  it.each([
    ["0123456789abcdef", /^[0-9a-f]{16}$/],
    ["M4BIKID7", /^[A-Z2-7]{8}$/],
    ["0SSSKEO7TTKZ", /^[0-9A-Z]{12}$/],
    ["0o4l8u3~tr0.~", /^[0-9a-z]{13}$/],
    ["C70DcHUG", /^[0-9A-Za-z]{8}$/],
    ["-cbo_u3q", /^[0-9A-Za-z]{8}$/],
  ])("keeps the length of %s and draws from an alphabet it already uses", (token, shape) => {
    const derived = deriveHashToken(token, "salt");
    expect(derived).toMatch(shape);
    expect(derived).not.toBe(token);
  });

  it("is a function of the token and the salt alone", () => {
    expect(deriveHashToken("0123456789abcdef", "a")).toBe(deriveHashToken("0123456789abcdef", "a"));
    expect(deriveHashToken("0123456789abcdef", "a")).not.toBe(
      deriveHashToken("0123456789abcdef", "b"),
    );
  });
});

describe("planHashedNames", () => {
  it("renames hashed inputs and rewrites every plain-text reference, leaving unrelated text", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    const lazy = write("static/chunks/lazy-fedcba9876543210.js", "y");
    const plain = write("static/chunks/plain.js", "z");
    write(
      "build-manifest.json",
      '{"pages":["static/chunks/main-0123456789abcdef.js"],"other":"10123456789abcdef0"}',
    );
    write("server/app/index.html", '<script src="/static/chunks/lazy-fedcba9876543210.js">');
    write("static/media/logo-0123456789abcdef.png", Buffer.from([0, 1, 2, 0x30, 0x31]));
    write("static/chunks/main-0123456789abcdef.js.map", '{"file":"main-0123456789abcdef.js"}');
    write("cache/webpack/pack-0123456789abcdef.txt", "main-0123456789abcdef.js");

    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN, skip: (rel) => rel === "cache" },
      inputs: new Map([
        [main, 'import("./lazy-fedcba9876543210.js");const m={1:"fedcba9876543210"};'],
        [lazy, "export const y=1;"],
        [plain, "export const z=1;"],
      ]),
      salt: "s",
    });

    const mainToken = deriveHashToken("0123456789abcdef", "s");
    const lazyToken = deriveHashToken("fedcba9876543210", "s");
    expect([...plan.renamed]).toEqual([
      [main, join(root, `static/chunks/main-${mainToken}.js`)],
      [lazy, join(root, `static/chunks/lazy-${lazyToken}.js`)],
    ]);
    expect(
      plan.rewrite('import("./lazy-fedcba9876543210.js");const m={1:"fedcba9876543210"};'),
    ).toBe(`import("./lazy-${lazyToken}.js");const m={1:"${lazyToken}"};`);

    plan.apply();
    expect(readFileSync(join(root, "build-manifest.json"), "utf8")).toBe(
      `{"pages":["static/chunks/main-${mainToken}.js"],"other":"10123456789abcdef0"}`,
    );
    expect(readFileSync(join(root, "server/app/index.html"), "utf8")).toBe(
      `<script src="/static/chunks/lazy-${lazyToken}.js">`,
    );
    expect(readFileSync(join(root, "static/chunks/main-0123456789abcdef.js.map"), "utf8")).toBe(
      '{"file":"main-0123456789abcdef.js"}',
    );
    expect(readFileSync(join(root, "cache/webpack/pack-0123456789abcdef.txt"), "utf8")).toBe(
      "main-0123456789abcdef.js",
    );
    expect(existsSync(join(root, "static/media/logo-0123456789abcdef.png"))).toBe(true);
  });

  it("renames a hashed non-input file whose text changed, and follows references to it", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("static/chunks/list-1111111111111111.css", "/* main-0123456789abcdef.js */");
    write("static/chunks/runtime.txt", "list-1111111111111111.css");
    write("static/chunks/stable-2222222222222222.css", "a{}");

    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, "x"]]),
      salt: "s",
    });
    plan.apply();

    const listToken = deriveHashToken("1111111111111111", "s");
    const names = readdirSync(join(root, "static/chunks")).sort();
    expect(names).toContain(`list-${listToken}.css`);
    expect(names).toContain("stable-2222222222222222.css");
    expect(names).not.toContain("list-1111111111111111.css");
    expect(readFileSync(join(root, "static/chunks/runtime.txt"), "utf8")).toBe(
      `list-${listToken}.css`,
    );
    expect(plan.renamed.get(join(root, "static/chunks/list-1111111111111111.css"))).toBe(
      join(root, `static/chunks/list-${listToken}.css`),
    );
  });

  it("changes nothing when no input carries a hash token", () => {
    const plain = write("app.js", "x");
    write("index.html", '<script src="app.js">');
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[plain, "x"]]),
      salt: "s",
    });
    expect(plan.renamed.size).toBe(0);
    expect(plan.rewrite("app.js")).toBe("app.js");
  });

  it("only takes a token the file's own name carries", () => {
    const main = write("static/chunks/main.js", "x");
    const plan = planHashedNames({
      options: { root, tokenOf: () => "0123456789abcdef" },
      inputs: new Map([[main, "x"]]),
      salt: "s",
    });
    expect(plan.renamed.size).toBe(0);
    expect(basename(main)).toBe("main.js");
  });
});

describe("afterpackHashSalt", () => {
  const base = { seed: 1, engineVersion: "0.2.4", settings: { preset: "light" }, cloud: false };

  it("changes with every input that changes the obfuscated bytes", () => {
    const salt = afterpackHashSalt(base);
    expect(afterpackHashSalt({ ...base })).toBe(salt);
    expect(afterpackHashSalt({ ...base, seed: 2 })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, engineVersion: "0.2.5" })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, settings: { preset: "hard" } })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, cloud: true })).not.toBe(salt);
  });

  it("ignores the order settings were written in", () => {
    expect(afterpackHashSalt({ ...base, settings: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      afterpackHashSalt({ ...base, settings: { b: { d: 3, c: 2 }, a: 1 } }),
    );
  });

  it("leaves out the seed option, diagnostics, git and telemetry from the settings", () => {
    expect(
      saltSettings({
        seed: 5,
        preset: "medium",
        diagnostics: "all",
        artifactOptions: {
          git: false,
          telemetry: { enabled: false },
          sourceMap: { enabled: true },
        },
      }),
    ).toEqual({
      preset: "medium",
      engineConfig: {},
      artifactOptions: { sourceMap: { enabled: true } },
    });
  });
});

describe("prepareHashSalt", () => {
  it("resolves one seed per build and salts with it", () => {
    const env: Record<string, string | undefined> = {};
    const first = prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      engineVersion: "0.2.4",
      settings: {},
      env,
    });
    expect(first.resolvedSeed.seed).toBe(7);
    expect(first.resolvedSeed.origin).toBe("option");
    resetBuildSessions();
    const again = prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      engineVersion: "0.2.4",
      settings: {},
      env,
    });
    expect(again.salt).toBe(first.salt);
  });

  it("draws a fresh salt for every unpinned build", () => {
    const env: Record<string, string | undefined> = {};
    const input = { seed: undefined, root, leg: "dist", engineVersion: "0.2.4", settings: {}, env };
    const first = prepareHashSalt(input);
    const second = prepareHashSalt(input);
    expect(first.resolvedSeed.origin).toBe("fresh");
    expect(second.salt).not.toBe(first.salt);
  });

  it("marks a build that will run on the cloud engine", () => {
    const local = prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      engineVersion: "0.2.4",
      settings: {},
      env: {},
    });
    const cloud = prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      engineVersion: "0.2.4",
      settings: {},
      env: { AFTERPACK_KEY: "k" },
    });
    expect(cloud.salt).not.toBe(local.salt);
  });
});
