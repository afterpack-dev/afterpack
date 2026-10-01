import Link from "next/link";
import { ActionForm } from "./ActionForm";
import { Counter } from "./Counter";

// Server Component (RSC) — renders on the server, embeds a client island.
export default function Home() {
  return (
    <main>
      <h1 data-testid="title">Next.js fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
      <Counter />
      <ActionForm />
      <p>
        <Link href="/about">About</Link>
      </p>
      {/* prefetch={false}: the App Router's prefetch of /legacy, a Pages Router page, never
          completes, so the network never settles; its prefetch of the force-dynamic /dynamic is
          aborted and reissued, so the requests a scenario run makes depend on timing. */}
      <p>
        <Link href="/dynamic" prefetch={false}>
          Dynamic
        </Link>
      </p>
      <p>
        <Link href="/legacy" prefetch={false}>
          Legacy (Pages Router)
        </Link>
      </p>
    </main>
  );
}
