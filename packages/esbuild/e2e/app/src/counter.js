// A second module so esbuild actually BUNDLES (proves the multi-module bundle
// survives obfuscation). The #private field exercises class/#private lowering.
export class Counter {
  #count = 0;

  increment() {
    this.#count += 1;
    return this.#count;
  }
}
