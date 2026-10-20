import { useEffect, useRef } from "react";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { commit, NoteInput, notesOf } from "../notes.server";

type FieldErrors = Partial<Record<"title" | "body", string>>;

export async function loader({ request }: { request: Request }) {
  const { notes } = await notesOf(request);
  return { notes };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const result = NoteInput.safeParse({ title: form.get("title"), body: form.get("body") });
  if (!result.success) {
    const errors: FieldErrors = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if ((field === "title" || field === "body") && !errors[field]) errors[field] = issue.message;
    }
    return data({ errors, status: "" }, { status: 400 });
  }
  const { session, notes } = await notesOf(request);
  const note = { id: notes.length + 1, ...result.data };
  session.set("notes", [...notes, note]);
  return data(
    { errors: {} as FieldErrors, status: `Saved note ${note.id}: ${note.title}` },
    { headers: { "Set-Cookie": await commit(session) } },
  );
}

export default function Notes() {
  const { notes } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const errors = result?.errors ?? {};
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (result?.status) form.current?.reset();
  }, [result]);

  return (
    <>
      <h1>Notes</h1>
      <Form method="post" aria-label="New note" noValidate ref={form}>
        <label>
          Title
          <input name="title" aria-invalid={Boolean(errors.title)} />
        </label>
        {errors.title && <p role="alert">{errors.title}</p>}
        <label>
          Body
          <textarea name="body" aria-invalid={Boolean(errors.body)} />
        </label>
        {errors.body && <p role="alert">{errors.body}</p>}
        <button type="submit">Add note</button>
      </Form>
      <p role="status">{result?.status ?? ""}</p>
      <ul aria-label="Saved notes">
        {notes.map((note) => (
          <li key={note.id}>
            <strong>{note.title}</strong> {note.body}
          </li>
        ))}
      </ul>
    </>
  );
}
