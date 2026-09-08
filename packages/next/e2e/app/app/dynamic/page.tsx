// Genuinely dynamic App Router route -- unlike `/` and `/about` (statically
// prerendered at build time, confirmed via `next build` output showing
// `○ (Static)` despite this fixture being labeled "SSR"), `force-dynamic`
// forces this route to be computed fresh on every request (Next.js marks it
// `ƒ (Dynamic)` in the build output). Renders a request-derived value so the
// smoke test can prove two separate requests produce different output.
export const dynamic = "force-dynamic";

export default async function DynamicPage() {
  const requestTimestamp = Date.now();
  return (
    <main>
      <h1 data-testid="title">Dynamic route</h1>
      <p data-testid="intro">Rendered with export const dynamic = "force-dynamic" -- computed fresh per request.</p>
      <p data-testid="dynamic-timestamp">{requestTimestamp}</p>
    </main>
  );
}
