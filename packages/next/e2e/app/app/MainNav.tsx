"use client";

import Link from "next/link";
import { useGuestbook } from "./guestbook-store";

export function MainNav() {
  const { entries } = useGuestbook();
  return (
    <nav aria-label="Main">
      <Link href="/">Home</Link> <Link href="/about">About</Link>{" "}
      <Link href="/guestbook">Guestbook</Link> <Link href="/stats">Stats</Link>{" "}
      <span data-testid="signed-count">{entries.length} signed</span>
    </nav>
  );
}
