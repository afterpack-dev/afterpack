import { parityOf } from "./parity.js";

export function labelFor(count) {
  return `an ${parityOf(count)} count`;
}
