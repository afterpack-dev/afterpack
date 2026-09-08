<script>
let count = $state(0);
const parity = $derived(count % 2 === 0 ? "even" : "odd");
</script>

<h1 data-testid="title">SvelteKit fixture</h1>
<p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
<button type="button" data-testid="counter" onclick={() => (count += 1)}>
  count is {count} ({parity})
</button>
