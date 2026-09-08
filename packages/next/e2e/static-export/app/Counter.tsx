"use client";

import { useState } from "react";

// A canonical AfterPack directive span (same pattern as next-16/app/
// Counter.tsx). Next.js's SWC transpile + bundler minifier strips this
// comment before AfterPack runs (framework-integration.md §9.2, Next.js
// row); the directive-capture flow recovers it post-build. Kept here so the
// directive path has a real anchor in the static-export fixture too.
// @afterpack:begin preset=hard
function describe(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `clicked ${count} times (${parity})`;
}
// @afterpack:end

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {describe(count)}
    </button>
  );
}
