import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

function frontDoorSources(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    let entries: string[];
    try {
      if (!statSync(src).isDirectory()) continue;
      entries = readdirSync(src);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".ts") || f.includes(".test.")) continue;
      if (pkg === "integration-utils" && (f === "registry.ts" || f === "plugin-config.ts"))
        continue;
      out.push(join(src, f));
    }
  }
  return out;
}

const FORCED_OFF_AND_REFUSING = new Set([
  "angular/src/index.ts",
  "cli/src/run.ts",
  "integration-utils/src/pass.ts",
]);

describe("no front door carries its own `directives` default", () => {
  it.each(frontDoorSources().map((f) => [f.slice(PACKAGES.length), f]))("%s", (rel, file) => {
    if (FORCED_OFF_AND_REFUSING.has(rel)) return;
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(text, "re-defaults `directives`; the registry owns it").not.toMatch(
      /directives\s*\?\?\s*(true|false)|directives:\s*(true|false)\s*[,}]/,
    );
  });
});
