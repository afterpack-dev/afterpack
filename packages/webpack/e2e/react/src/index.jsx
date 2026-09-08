import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [count, setCount] = useState(0);
  const parity = count % 2 === 0 ? "even" : "odd";
  return (
    <main>
      <h1 data-testid="title">webpack + React fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
      <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count is {count} ({parity})
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
