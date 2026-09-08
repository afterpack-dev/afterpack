// The app entry: renders the UI and wires the counter interaction. Imports a
// sibling module so esbuild produces a real bundle for @afterpack/esbuild to
// obfuscate.
import { Counter } from "./counter.js";

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
