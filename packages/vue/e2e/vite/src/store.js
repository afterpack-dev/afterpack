import { reactive, watch } from "vue";
import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() }));

export const NOTES_STORAGE_KEY = "afterpack-fixture-notes";

function loadNotes() {
  const parsed = StoredNotes.safeParse(JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]"));
  return parsed.success ? parsed.data : [];
}

export const store = reactive({
  count: 0,
  notes: loadNotes(),
  get parity() {
    return this.count % 2 === 0 ? "even" : "odd";
  },
  increment() {
    this.count += 1;
  },
  add(input) {
    const note = { id: this.notes.length + 1, ...input };
    this.notes.push(note);
    return note;
  },
});

watch(
  () => store.notes,
  (notes) => localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes)),
  { deep: true },
);
