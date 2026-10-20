<script>
import { onMount } from "svelte";
import { restoreNotes } from "$lib/notes.svelte.js";

let { children } = $props();

onMount(restoreNotes);
</script>

<nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/notes">Notes</a>
  <a href="/reports">Reports</a>
</nav>
<main>
  {@render children()}
</main>
