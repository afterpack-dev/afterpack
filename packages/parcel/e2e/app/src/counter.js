// Lives in its own LAZY chunk (main.js reaches it through `await import()`), so
// the built app depends on Parcel's content-hashed chunk URL resolving at
// runtime -- the thing AfterPack's string obfuscation can silently destroy.
// The #private field exercises class/#private lowering.
export class Counter {
  #count = 0;

  increment() {
    this.#count += 1;
    return this.#count;
  }
}
