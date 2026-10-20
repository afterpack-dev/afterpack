import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() }));

const NOTES_STORAGE_KEY = "afterpack-fixture-notes";

export function useNotebook() {
  const count = useState("count", () => 0);
  const notes = useState("notes", () => []);

  return {
    count,
    notes,
    restore() {
      const parsed = StoredNotes.safeParse(
        JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]"),
      );
      notes.value = parsed.success ? parsed.data : [];
    },
    add(input) {
      const note = { id: notes.value.length + 1, ...input };
      notes.value = [...notes.value, note];
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes.value));
      return note;
    },
  };
}
