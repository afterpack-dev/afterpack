export function formatCount(n) {
  return `count is ${n} (${n % 2 === 0 ? "even" : "odd"})`;
}
