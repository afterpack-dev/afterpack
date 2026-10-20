import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import express from "express";

const port = Number(process.argv[2] || 8080);
const buildDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  process.env.AFTERPACK_E2E_DIST_DIR || "build",
);
const build = await import(pathToFileURL(join(buildDir, "server", "index.js")).href);

const app = express();
app.disable("x-powered-by");
app.use("/assets", express.static(join(buildDir, "client", "assets"), { immutable: true, maxAge: "1y" }));
app.use(express.static(join(buildDir, "client")));
app.use(createRequestHandler({ build }));
app.listen(port, () => console.log(`serving ${buildDir} on http://localhost:${port}`));
