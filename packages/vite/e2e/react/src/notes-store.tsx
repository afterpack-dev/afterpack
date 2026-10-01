import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(
  z.object({ id: z.number().int(), title: z.string(), body: z.string() }),
);

export type Note = z.infer<typeof StoredNotes>[number];

export const NOTES_STORAGE_KEY = "afterpack-fixture-notes";

function loadNotes(): Note[] {
  const parsed = StoredNotes.safeParse(JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]"));
  return parsed.success ? parsed.data : [];
}

interface NotesState {
  notes: Note[];
  add: (note: z.infer<typeof NoteInput>) => Note;
}

const NotesContext = createContext<NotesState | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>(loadNotes);

  useEffect(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  }, [notes]);

  const add = (input: z.infer<typeof NoteInput>): Note => {
    const note = { id: notes.length + 1, ...input };
    setNotes((current) => [...current, note]);
    return note;
  };

  return <NotesContext.Provider value={{ notes, add }}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesState {
  const state = useContext(NotesContext);
  if (!state) throw new Error("useNotes needs a NotesProvider");
  return state;
}
