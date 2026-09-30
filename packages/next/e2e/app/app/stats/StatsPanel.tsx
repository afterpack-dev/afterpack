"use client";

import { useGuestbook } from "../guestbook-store";

export default function StatsPanel() {
  const { entries } = useGuestbook();
  const characters = entries.reduce((total, entry) => total + entry.message.length, 0);
  return (
    <p data-testid="stats-summary">
      {entries.length} {entries.length === 1 ? "entry" : "entries"}, {characters} characters
    </p>
  );
}
