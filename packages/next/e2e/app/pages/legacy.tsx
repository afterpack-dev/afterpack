import type { GetServerSideProps, NextPage } from "next";
import Link from "next/link";

// Pages Router page, coexisting with the App Router (`app/`) in the same
// project -- Next.js's officially-supported incremental-adoption path, still
// fully supported in Next 16. `getServerSideProps` has no static-generation
// alternative -- it is UNCONDITIONALLY re-run on every request, so its
// output genuinely proves per-request server-side rendering (unlike `/` and
// `/about` under `app/`, which are statically prerendered at build time
// despite the fixture being labeled "SSR" -- see `app/dynamic/page.tsx` for
// the App Router equivalent proof).
interface LegacyProps {
  serverTimestamp: number;
}

const Legacy: NextPage<LegacyProps> = ({ serverTimestamp }) => {
  return (
    <main>
      <h1 data-testid="legacy-title">Legacy Pages Router page</h1>
      <p data-testid="legacy-intro">Rendered via the Pages Router's getServerSideProps (pages/legacy.tsx).</p>
      <p data-testid="legacy-timestamp">{serverTimestamp}</p>
      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
};

export default Legacy;

export const getServerSideProps: GetServerSideProps<LegacyProps> = async () => {
  return { props: { serverTimestamp: Date.now() } };
};
