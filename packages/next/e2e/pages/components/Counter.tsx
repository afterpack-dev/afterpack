import { useState } from "react";

// No "use client" anywhere in this fixture: the Pages Router has no Server
// Components, so EVERY component here is client code that must survive
// obfuscation and then hydrate against the server-rendered HTML.
function describe(count: number): string {
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
