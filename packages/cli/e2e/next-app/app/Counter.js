"use client";

import { useState } from "react";

function describe(count) {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `clicked ${count} times (${parity})`;
}

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {describe(count)}
    </button>
  );
}
