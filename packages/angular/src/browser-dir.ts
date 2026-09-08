import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function findAngularBrowserDir(distRoot: string): string {
  if (!existsSync(distRoot)) {
    throw new Error(`@afterpack/angular: dist root not found: ${distRoot}`);
  }
  const nested = readdirSync(distRoot)
    .map((name) => join(distRoot, name, "browser"))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
  if (nested.length === 1) return nested[0];
  if (nested.length > 1) {
    throw new Error(
      `@afterpack/angular: multiple dist/<app>/browser dirs found (${nested.join(", ")}); pass browserDir explicitly`,
    );
  }
  const directBrowser = join(distRoot, "browser");
  if (existsSync(directBrowser) && statSync(directBrowser).isDirectory()) return directBrowser;
  if (existsSync(join(distRoot, "index.html"))) return distRoot;
  throw new Error(
    `@afterpack/angular: could not locate an Angular browser output under ${distRoot}; pass browserDir explicitly`,
  );
}
