import { createCookieSessionStorage } from "react-router";
import { z } from "zod";

export const NoteInput = z.object({
  title: z.string().trim().min(3, "Give the note a title of at least 3 characters."),
  body: z.string().trim().max(140, "Keep the note under 140 characters."),
});

const StoredNotes = z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() }));

export type Note = z.infer<typeof StoredNotes>[number];

const sessions = createCookieSessionStorage({
  cookie: {
    name: "afterpack_notes",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: ["afterpack-fixture"],
  },
});

export async function notesOf(request: Request) {
  const session = await sessions.getSession(request.headers.get("Cookie"));
  const parsed = StoredNotes.safeParse(session.get("notes") ?? []);
  return { session, notes: parsed.success ? parsed.data : [] };
}

export function commit(session: Awaited<ReturnType<typeof notesOf>>["session"]) {
  return sessions.commitSession(session);
}
