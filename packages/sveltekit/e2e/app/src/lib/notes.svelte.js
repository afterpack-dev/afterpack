import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() }));

const NOTES_STORAGE_KEY = "afterpack-fixture-notes";

export const notebook = $state({ count: 0, notes: [] });

export function parityOf(count) {
  return count % 2 === 0 ? "even" : "odd";
}

export function restoreNotes() {
  const parsed = StoredNotes.safeParse(JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]"));
  notebook.notes = parsed.success ? parsed.data : [];
}

export function addNote(input) {
  const note = { id: notebook.notes.length + 1, ...input };
  notebook.notes.push(note);
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notebook.notes));
  return note;
}

export class NoteReport {
  #notes;

  constructor(notes) {
    this.#notes = notes;
  }

  get words() {
    return this.#notes.reduce(
      (total, note) => total + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length,
      0,
    );
  }

  get longest() {
    return this.#notes.reduce((best, note) => (note.title.length > best.length ? note.title : best), "");
  }

  get summary() {
    const count = this.#notes.length;
    return `${count} ${count === 1 ? "note" : "notes"}, ${this.words} words`;
  }
}
