import Link from "next/link";

export default function About() {
  return (
    <main>
      <h1 data-testid="title">About AfterPack</h1>
      <p data-testid="intro">A second route, so the smoke test can navigate between pages.</p>
      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
