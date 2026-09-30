"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export interface GuestbookEntry {
  name: string;
  message: string;
}

const STORAGE_KEY = "afterpack-fixture-guestbook";

interface GuestbookState {
  entries: GuestbookEntry[];
  add: (entry: GuestbookEntry) => void;
}

const GuestbookContext = createContext<GuestbookState | null>(null);

function readStored(): GuestbookEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is GuestbookEntry =>
            typeof entry?.name === "string" && typeof entry?.message === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function GuestbookProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<GuestbookEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setEntries(readStored());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }, [entries, loaded]);

  const add = (entry: GuestbookEntry) => setEntries((current) => [...current, entry]);

  return <GuestbookContext.Provider value={{ entries, add }}>{children}</GuestbookContext.Provider>;
}

export function useGuestbook(): GuestbookState {
  const state = useContext(GuestbookContext);
  if (!state) throw new Error("useGuestbook needs a GuestbookProvider");
  return state;
}
