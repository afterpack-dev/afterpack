// The app entry: renders the UI and wires the counter interaction. Loads the
// counter module with a dynamic import, so esbuild splits it into a chunk with
// a content-hashed name that the entry imports.
const { Counter } = await import("./counter.js");

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <h1 data-testid="title">esbuild app fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button type="button" data-testid="counter">count is 0 (even)</button>
  `;

  const counter = new Counter();
  const button = app.querySelector('[data-testid="counter"]');
  button.addEventListener("click", () => {
    const n = counter.increment();
    button.textContent = `count is ${n} (${n % 2 === 0 ? "even" : "odd"})`;
  });
}

render();
