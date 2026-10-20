<script>
import { notebook, parityOf } from "$lib/notes.svelte.js";
</script>

<h1 data-testid="title">SvelteKit fixture</h1>
<p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
<button type="button" data-testid="counter" onclick={() => (notebook.count += 1)}>
  count is {notebook.count} ({parityOf(notebook.count)})
</button>
