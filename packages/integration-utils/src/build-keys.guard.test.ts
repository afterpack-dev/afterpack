import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unforwardedBuildKeys } from "./config-probe.js";

const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

function frontDoors(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    let entries: string[];
    try {
      if (!statSync(src).isDirectory()) continue;
      entries = readdirSync(src);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      if (pkg === "integration-utils") continue;
      const text = readFileSync(join(src, file), "utf8");
      if (text.includes("runObfuscationPass({")) out.push({ rel: `${pkg}/src/${file}`, text });
    }
  }
  return out;
}

const FORWARDS: Record<string, RegExp> = {
  "paths.include": /paths\?\.include|pathsInclude/,
  "build.autorun": /build\?\.autorun/,
  directives: /directives:\s*[A-Za-z]/,
  "diagnostics.level": /diagnostics\?\.level/,
  key: /resolvePluginConfig\(|applyResolvedKey\(/,
};

function refuses(text: string, path: string): boolean {
  const declared = text.slice(text.indexOf("unsupported:"), text.indexOf("unsupported:") + 200);
  const named = text.includes("unsupported:") && declared.includes(path);
  return named || text.includes(`\`${path}\` is not supported here`);
}

const DOORS = frontDoors();
const KEYS = unforwardedBuildKeys();

describe("every front door accounts for every build key that does not ride artifactOptions", () => {
  it("found the front doors to check", () => {
    expect(DOORS.length).toBeGreaterThanOrEqual(8);
  });

  it.each(
    DOORS.flatMap((door) => KEYS.map((key) => [door.rel, key.path, door.text] as const)),
  )("%s forwards or refuses %s", (rel, path, text) => {
    const pattern = FORWARDS[path];
    expect(
      pattern,
      `\`${path}\` is a build-surface key that does not ride artifactOptions and this guard has ` +
        "no idea what forwarding it looks like. Add it to FORWARDS",
    ).toBeDefined();
    expect(
      pattern.test(text) || refuses(text, path),
      `${rel} accepts \`${path}\` and neither forwards nor refuses it — accepted-and-dropped is ` +
        "the defect this guards. Forward it to the pass, or list it in this door's " +
        "`unsupported` map with the reason a user gets",
    ).toBe(true);
  });
});
