export interface LedgerEntry {
  label: string;
  amount: number;
}

export interface LedgerSummary {
  owner: string;
  entries: LedgerEntry[];
  total: number;
  largest: string;
}

export class Ledger {
  #entries: LedgerEntry[] = [];
  readonly #owner: string;

  constructor(owner: string) {
    this.#owner = owner;
  }

  add(label: string, amount: number): this {
    if (!Number.isFinite(amount)) throw new TypeError(`not a number: ${label}`);
    this.#entries.push({ label, amount });
    return this;
  }

  get total(): number {
    return this.#entries.reduce((sum, { amount }) => sum + amount, 0);
  }

  summary(): LedgerSummary {
    const [first, ...rest] = [...this.#entries].sort((a, b) => b.amount - a.amount);
    return {
      owner: this.#owner,
      entries: this.#entries,
      total: this.total,
      largest: first ? first.label : "none",
    };
  }
}
