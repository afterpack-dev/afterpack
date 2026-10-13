import Link from "next/link";
import { Counter } from "./Counter";

export default function Home() {
  return (
    <main>
      <h1 data-testid="title">CLI Next.js fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
      <Counter />
      <Link href="/about" data-testid="about-link">
        About
      </Link>
    </main>
  );
}
