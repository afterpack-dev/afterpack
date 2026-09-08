"use client";

import { useState } from "react";
import { echo } from "./actions";

// Wires up the previously-unused `echo` Server Action (app/actions.ts) to a
// real, clickable UI element -- Server Actions must be invoked from a Client
// Component (or a <form action={...}>); a plain onClick handler calling the
// imported server function is the simplest way to exercise the genuine
// Next.js Server Action RPC round-trip (client -> POST -> server -> response),
// not just literal ("use server") preservation through obfuscation.
const FIXED_MESSAGE = "hello from client";

export function ActionForm() {
  const [result, setResult] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        data-testid="action-button"
        onClick={async () => {
          setResult(await echo(FIXED_MESSAGE));
        }}
      >
        Call server action
      </button>
      {result !== null && <p data-testid="action-result">{result}</p>}
    </div>
  );
}
