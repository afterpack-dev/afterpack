// The app entry: renders the UI, then loads the counter from a SEPARATE chunk
// on first click so the smoke test's interaction proves a code-split, obfuscated
// Parcel bundle can still resolve and execute its lazy chunk.
function render() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <h1 data-testid="title">parcel app fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button type="button" data-testid="counter">count is 0 (even)</button>
  `;

  const button = app.querySelector('[data-testid="counter"]');
  let counter;
  button.addEventListener("click", async () => {
    if (!counter) {
      const { Counter } = await import("./counter.js");
      counter = new Counter();
    }
    const n = counter.increment();
    button.textContent = `count is ${n} (${n % 2 === 0 ? "even" : "odd"})`;
  });
}

render();
