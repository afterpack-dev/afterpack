// The page hands a puzzle to a module Web Worker, which Vite builds in its own
// sub-build and emits under a content-hashed name, and registers a service
// worker that precaches every file the build wrote.
const answer = document.querySelector('[data-testid="answer"]');
const offline = document.querySelector('[data-testid="offline"]');

const worker = new Worker(new URL("./solver.worker.js", import.meta.url), { type: "module" });
worker.addEventListener("message", (event) => {
  answer.textContent = event.data;
});

document.querySelector('[data-testid="solve"]').addEventListener("click", () => {
  worker.postMessage({ rows: 6, cols: 7 });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      offline.textContent = "service worker ready";
    });
}
