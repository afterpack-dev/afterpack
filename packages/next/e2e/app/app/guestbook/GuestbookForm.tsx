"use client";

import { useActionState, useEffect, useState } from "react";
import { useGuestbook } from "../guestbook-store";
import { type SignResult, signGuestbook } from "./actions";

export function GuestbookForm() {
  const { entries, add } = useGuestbook();
  const [result, action, pending] = useActionState<SignResult | null, FormData>(signGuestbook, null);
  const [thanked, setThanked] = useState<SignResult | null>(null);

  useEffect(() => {
    if (result?.ok && thanked !== result) {
      add(result.entry);
      setThanked(result);
    }
  }, [result, thanked, add]);

  const errors = result && !result.ok ? result.errors : {};

  return (
    <>
      <form action={action} aria-label="Sign the guestbook" noValidate>
        <label>
          Name <input name="name" aria-invalid={Boolean(errors.name)} />
        </label>
        {errors.name && <p role="alert">{errors.name}</p>}
        <label>
          Message <textarea name="message" aria-invalid={Boolean(errors.message)} />
        </label>
        {errors.message && <p role="alert">{errors.message}</p>}
        <button type="submit" disabled={pending}>
          Sign
        </button>
      </form>
      <p role="status" data-testid="sign-status">
        {result?.ok ? `Thanks, ${result.entry.name}!` : ""}
      </p>
      <ul aria-label="Guestbook entries">
        {entries.map((entry, index) => (
          <li key={`${entry.name}-${index}`}>
            <strong>{entry.name}</strong>: {entry.message}
          </li>
        ))}
      </ul>
    </>
  );
}
