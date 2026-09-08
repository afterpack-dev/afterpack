// The library under test. A few pure exports plus a class with a #private field
// (exercises the engine's class/#private lowering), so a working obfuscated
// build must preserve BOTH the ESM export names and the runtime behavior.

export function greet(name) {
  return `Hello, ${name}!`;
}

export function add(a, b) {
  return a + b;
}

export class Counter {
  #count = 0;

  increment() {
    this.#count += 1;
    return this.#count;
  }

  get value() {
    return this.#count;
  }
}
