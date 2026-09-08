// Minimal, dependency-free static server for the adapter-static output (build/).
// `/` serves build/index.html; hashed client chunks under /_app/ resolve
// relative to build/. Correct JS MIME so the obfuscated modules load and the
// page hydrates. `node serve.mjs <port>`. Hermetic (no npm deps).
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || 8080);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "build");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const rel = decodeURIComponent(pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    const filePath = normalize(join(root, rel));
    if (filePath !== root && !filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, "index.html") : filePath;
    const body = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
