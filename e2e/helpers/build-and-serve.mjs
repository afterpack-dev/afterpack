import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [logPath, buildCommand, serveCommand] = process.argv.slice(2);

if (!logPath || !buildCommand || !serveCommand) {
  console.error("usage: build-and-serve.mjs <logPath> <buildCommand> <serveCommand>");
  process.exit(2);
}

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(buildCommand, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let captured = "";
    child.stdout.on("data", (chunk) => {
      captured += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      captured += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({ code: 1, captured: `${captured}\n${error}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, captured }));
  });
}

const { code, captured } = await runBuild();
mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(logPath, captured);
if (code !== 0) {
  console.error(`build failed with exit code ${code}: ${buildCommand}`);
  process.exit(code);
}

const server = spawn(serveCommand, { shell: true, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
    process.exit(0);
  });
}
server.on("close", (serverCode) => process.exit(serverCode ?? 0));
