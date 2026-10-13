const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const limit = Number(process.env.AFTERPACK_E2E_KILL_AFTER_WRITES);
const under = process.env.AFTERPACK_E2E_KILL_UNDER;
const original = fs.writeFileSync;
let writes = 0;

fs.writeFileSync = function writeFileSync(path, ...rest) {
  const result = original.call(this, path, ...rest);
  if (typeof path === "string" && under && path.startsWith(under) && ++writes >= limit) {
    process.kill(process.pid, "SIGKILL");
  }
  return result;
};
syncBuiltinESMExports();
