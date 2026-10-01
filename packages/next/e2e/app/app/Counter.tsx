"use client";

import { useState } from "react";

/* @afterpack preset=hard */
function describe(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `clicked ${count} times (${parity})`;
}
/* @afterpack end */

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {describe(count)}
    </button>
  );
}
