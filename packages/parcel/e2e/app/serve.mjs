// Minimal, dependency-free static server rooted at the BUILT dist/ dir: Parcel
// emits its own index.html there and references every bundle by an ABSOLUTE
// url (`/app.<hash>.js`, and an importmap for lazy chunks), so the dist dir has
// to be the server root. Correct JS MIME so <script type="module"> loads.
// `node serve.mjs <port>`. Hermetic (no npm deps).
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || 8080);
const root = fileURLToPath(new URL("./dist/", import.meta.url));

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
