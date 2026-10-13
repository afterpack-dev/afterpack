const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const under = process.env.AFTERPACK_E2E_KILL_UNDER;
const limits = {
  write: Number(process.env.AFTERPACK_E2E_KILL_AFTER_WRITES || 0),
  remove: Number(process.env.AFTERPACK_E2E_KILL_AFTER_REMOVES || 0),
};
const counts = { write: 0, remove: 0 };

function counted(kind, original) {
  return function (path, ...rest) {
    const result = original.call(this, path, ...rest);
    if (limits[kind] > 0 && typeof path === "string" && under && path.startsWith(under)) {
      counts[kind] += 1;
      if (counts[kind] >= limits[kind]) process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
}

fs.writeFileSync = counted("write", fs.writeFileSync);
fs.rmSync = counted("remove", fs.rmSync);
fs.unlinkSync = counted("remove", fs.unlinkSync);
syncBuiltinESMExports();
