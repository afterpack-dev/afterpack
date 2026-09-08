// A second sibling module -- its string literals are the obfuscation target the
// smoke test checks for (they must not survive verbatim in the emitted bundle).
export function label(n) {
  const parity = n % 2 === 0 ? "even" : "odd";
  return `count is ${n} (${parity})`;
}
