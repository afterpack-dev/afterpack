import { useState } from "react";

// A canonical AfterPack directive span. Astro's compiler + Vite islands
// pipeline strips this comment before AfterPack runs
// (framework-integration.md §9.2, Astro row); the directive-capture flow
// recovers it post-build. Kept here so the directive path has a real anchor.
// @afterpack:begin preset=hard
function describe(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `island count is ${count} (${parity})`;
}
// @afterpack:end

export default function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {describe(count)}
    </button>
  );
}
