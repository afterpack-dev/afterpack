import { useSyncExternalStore } from "react";
import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() }));

export type Note = z.infer<typeof StoredNotes>[number];

interface Snapshot {
  count: number;
  notes: Note[];
}

const NOTES_STORAGE_KEY = "afterpack-fixture-notes";
const SERVER_SNAPSHOT: Snapshot = { count: 0, notes: [] };
const listeners = new Set<() => void>();
let snapshot: Snapshot | null = null;

function current(): Snapshot {
  if (!snapshot) {
    const parsed = StoredNotes.safeParse(
      JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]"),
    );
    snapshot = { count: 0, notes: parsed.success ? parsed.data : [] };
  }
  return snapshot;
}

function update(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotebook(): Snapshot {
  return useSyncExternalStore(subscribe, current, () => SERVER_SNAPSHOT);
}

export function increment(): void {
  update({ ...current(), count: current().count + 1 });
}

export function addNote(input: z.infer<typeof NoteInput>): Note {
  const note = { id: current().notes.length + 1, ...input };
  const notes = [...current().notes, note];
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  update({ ...current(), notes });
  return note;
}
