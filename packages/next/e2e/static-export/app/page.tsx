import { Counter } from "./Counter";

// Server Component (RSC), rendered once at BUILD time (`output: "export"` —
// no server runtime exists at request time; the entire page ships as a
// static out/index.html plus a client JS bundle for hydration). Embeds a
// client island (Counter) to prove interactivity survives obfuscation with
// zero server involved at runtime, distinct from next-16's SSR fixture.
export default function Home() {
  return (
    <main>
      <h1 data-testid="title">Next.js static export fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture (output: export).</p>
      <Counter />
    </main>
  );
}
