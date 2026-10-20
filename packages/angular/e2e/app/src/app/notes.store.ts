import { computed, effect, Injectable, signal } from "@angular/core";

export interface Note {
  id: number;
  title: string;
  body: string;
}

export const NOTES_STORAGE_KEY = "afterpack-fixture-notes";

function isNote(value: unknown): value is Note {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Record<string, unknown>;
  return (
    Number.isInteger(note["id"]) && typeof note["title"] === "string" && typeof note["body"] === "string"
  );
}

function loadNotes(): Note[] {
  const stored: unknown = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]");
  return Array.isArray(stored) && stored.every(isNote) ? stored : [];
}

@Injectable({ providedIn: "root" })
export class NotesStore {
  readonly count = signal(0);
  readonly parity = computed(() => (this.count() % 2 === 0 ? "even" : "odd"));
  readonly notes = signal<Note[]>(loadNotes());

  constructor() {
    effect(() => localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(this.notes())));
  }

  increment(): void {
    this.count.update((c) => c + 1);
  }

  add(input: { title: string; body: string }): Note {
    const note = { id: this.notes().length + 1, ...input };
    this.notes.update((notes) => [...notes, note]);
    return note;
  }
}
