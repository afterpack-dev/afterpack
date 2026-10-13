import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterpackVite } from "@afterpack/vite";
import { defineConfig } from "vite";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// Writes a service worker the way precache generators do: content-hashed URLs
// carry no revision, because their name is supposed to change whenever their
// bytes do. A name that kept its value across a change would be served from
// the cache forever.
function precacheServiceWorker() {
  let outDir = "";
  return {
    name: "fixture-precache-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        const urls = filesUnder(join(outDir, "assets"))
          .filter((file) => !file.endsWith(".map"))
          .map((file) => `/${relative(outDir, file).split("\\").join("/")}`)
          .sort();
        writeFileSync(join(outDir, "precache-manifest.json"), `${JSON.stringify(urls, null, 2)}\n`);
        writeFileSync(
          join(outDir, "sw.js"),
          [
            `const PRECACHE = ${JSON.stringify(urls)};`,
            'const CACHE = "precache";',
            'self.addEventListener("install", (event) => {',
            "  event.waitUntil(",
            "    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),",
            "  );",
            "});",
            'self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));',
            'self.addEventListener("fetch", (event) => {',
            "  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));",
            "});",
            "",
          ].join("\n"),
        );
      },
    },
  };
}

export default defineConfig({
  worker: { format: "es" },
  plugins: [
    afterpackVite({ seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed) }),
    precacheServiceWorker(),
  ],
});
