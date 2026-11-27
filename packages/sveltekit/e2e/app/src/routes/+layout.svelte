<script>
import { onMount } from "svelte";
import { restoreNotes } from "$lib/notes.svelte.js";

let { children } = $props();
let hydrated = $state(false);

onMount(() => {
  restoreNotes();
  hydrated = true;
});
</script>

<nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/notes">Notes</a>
  <a href="/reports">Reports</a>
</nav>
<main data-app-ready={hydrated ? "" : undefined}>
  {@render children()}
</main>
