"use client";

import { type FormEvent, useState } from "react";

export function SubscribeForm() {
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    const response = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await response.json()) as { subscribed?: string; error?: string };
    setOutcome(
      response.ok
        ? { ok: true, text: `Subscribed ${body.subscribed}` }
        : { ok: false, text: body.error ?? "Something went wrong." },
    );
  };

  return (
    <form aria-label="Subscribe" noValidate onSubmit={submit}>
      <label>
        Email <input name="email" type="email" />
      </label>
      <button type="submit">Subscribe</button>
      {outcome && <p role={outcome.ok ? "status" : "alert"}>{outcome.text}</p>}
    </form>
  );
}
