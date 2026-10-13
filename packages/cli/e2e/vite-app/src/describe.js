import { parityOf } from "./parity.js";

export function describeCount(count) {
  return `count is ${count} (${parityOf(count)})`;
}
