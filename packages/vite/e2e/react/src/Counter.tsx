import { useState } from "react";

// A canonical AfterPack directive span. The bundler's minifier strips this
// comment before AfterPack runs (framework-integration.md §1.2); the directive
// flow recovers it post-build via the manifest / source maps. Keeping it here
// so the directive-capture path has a real anchor to exercise.
// @afterpack:begin preset=hard
function computeLabel(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `count is ${count} (${parity})`;
}
// @afterpack:end

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {computeLabel(count)}
    </button>
  );
}
