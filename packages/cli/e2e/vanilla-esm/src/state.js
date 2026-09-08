// Depends on ./math.js -- proves a cross-module named import still links after
// each module is obfuscated independently by the afterpack CLI.
import { add } from "./math.js";

let count = 0;

export function increment() {
  count = add(count, 1);
  return count;
}
