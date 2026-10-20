import { increment, useNotebook } from "../lib/notebook";

// A canonical AfterPack directive span. Astro's compiler + Vite islands
// pipeline strips this comment before AfterPack runs
// (framework-integration.md §9.2, Astro row); the directive-capture flow
// recovers it post-build. Kept here so the directive path has a real anchor.
// @afterpack:begin preset=hard
function describe(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `count is ${count} (${parity})`;
}
// @afterpack:end

export default function Counter() {
  const { count } = useNotebook();

  return (
    <button type="button" data-testid="counter" onClick={increment}>
      {describe(count)}
    </button>
  );
}
