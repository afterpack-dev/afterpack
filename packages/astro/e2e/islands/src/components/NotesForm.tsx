import { type FormEvent, useState } from "react";
import { addNote, NoteInput, useNotebook } from "../lib/notebook";

type FieldErrors = Partial<Record<"title" | "body", string>>;

export default function NotesForm() {
  const { notes } = useNotebook();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = NoteInput.safeParse({ title: data.get("title"), body: data.get("body") });
    if (!result.success) {
      const next: FieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if ((field === "title" || field === "body") && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      setStatus("");
      return;
    }
    const note = addNote(result.data);
    setErrors({});
    setStatus(`Saved note ${note.id}: ${note.title}`);
    form.reset();
  };

  return (
    <>
      <form aria-label="New note" noValidate onSubmit={submit}>
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
      </form>
      <p role="status">{status}</p>
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
