import Link from "next/link";

export default function About() {
  return (
    <main>
      <h1 data-testid="title">About the CLI Next.js fixture</h1>
      <Link href="/" data-testid="home-link">
        Home
      </Link>
    </main>
  );
}
