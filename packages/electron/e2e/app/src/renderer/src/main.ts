class Counter {
  #value = 0;

  bump(): { value: number; parity: string } {
    this.#value += 1;
    const { value } = this;
    return { value, parity: value % 2 === 0 ? "even" : "odd" };
  }

  get value(): number {
    return this.#value;
  }
}

interface Bridge {
  total(entries: [string, number][]): Promise<{ total: number; largest: string }>;
  info(): Promise<{ channel: string; version: string }>;
  label(n: number): string;
}

const el = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!node) throw new Error(`missing [data-testid="${id}"]`);
  return node;
};

const counter = new Counter();

el("title").textContent = "AfterPack Electron fixture";
el("counter").addEventListener("click", () => {
  const { value, parity } = counter.bump();
  el("counter").textContent = `count is ${value} (${parity})`;
});

const bridge = (window as unknown as { afterpack?: Bridge }).afterpack;
if (bridge) {
  Promise.all([
    bridge.total([
      ["a", 2],
      ["b", 3],
      ["c", 4],
    ]),
    bridge.info(),
  ]).then(([summary, info]) => {
    el("bridge").textContent =
      `${info.channel}/${info.version} total ${summary.total} largest ${summary.largest} ${bridge.label(35)}`;
  });
}
