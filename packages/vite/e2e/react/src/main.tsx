import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App.tsx";
import { CounterProvider } from "./counter-store.tsx";
import { NotesProvider } from "./notes-store.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <CounterProvider>
        <NotesProvider>
          <App />
        </NotesProvider>
      </CounterProvider>
    </BrowserRouter>
  </StrictMode>,
);
