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
      {/* prefetch={false}: `/dynamic` is force-dynamic (no cached RSC payload
          to prefetch) -- Next.js's default viewport-triggered prefetch
          against it kept issuing repeated aborted `?_rsc=` requests in
          Playwright, which meant the network never went idle and every
          `waitUntil: "networkidle"` navigation in the shared smoke runner
          (e2e/helpers/smoke.ts) timed out. Confirmed via real testing this
          session -- not a hypothetical. */}
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
