<script>
import { NoteReport, notebook } from "$lib/notes.svelte.js";

let { data } = $props();
const report = $derived(new NoteReport(notebook.notes));
</script>

<h1>{data.heading}</h1>
<p data-testid="report-summary">{report.summary}</p>
<p data-testid="report-longest">
  {report.longest ? `Longest title: ${report.longest}` : "No notes yet"}
</p>
