<script>
import { addNote, NoteInput, notebook } from "$lib/notes.svelte.js";

let title = $state("");
let body = $state("");
let errors = $state({});
let status = $state("");

function submit(event) {
  event.preventDefault();
  const result = NoteInput.safeParse({ title, body });
  if (!result.success) {
    const next = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if ((field === "title" || field === "body") && !next[field]) next[field] = issue.message;
    }
    errors = next;
    status = "";
    return;
  }
  const note = addNote(result.data);
  errors = {};
  status = `Saved note ${note.id}: ${note.title}`;
  title = "";
  body = "";
}
</script>

<h1>Notes</h1>
<form aria-label="New note" novalidate onsubmit={submit}>
  <label>
    Title
    <input name="title" bind:value={title} aria-invalid={Boolean(errors.title)} />
  </label>
  {#if errors.title}
    <p role="alert">{errors.title}</p>
  {/if}
  <label>
    Body
    <textarea name="body" bind:value={body} aria-invalid={Boolean(errors.body)}></textarea>
  </label>
  {#if errors.body}
    <p role="alert">{errors.body}</p>
  {/if}
  <button type="submit">Add note</button>
</form>
<p role="status">{status}</p>
<ul aria-label="Saved notes">
  {#each notebook.notes as note (note.id)}
    <li><strong>{note.title}</strong> {note.body}</li>
  {/each}
</ul>
