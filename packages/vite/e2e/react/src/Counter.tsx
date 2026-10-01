import { useCounter } from "./counter-store";

/* @afterpack preset=hard */
function computeLabel(count: number): string {
  const parity = count % 2 === 0 ? "even" : "odd";
  return `count is ${count} (${parity})`;
}
/* @afterpack end */

export function Counter() {
  const { count, increment } = useCounter();

  return (
    <button type="button" data-testid="counter" onClick={increment}>
      {computeLabel(count)}
    </button>
  );
}
