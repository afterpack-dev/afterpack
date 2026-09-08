import type { GetServerSideProps, NextPage } from "next";
import Link from "next/link";

// `getServerSideProps` has no static-generation alternative: it is re-run on
// EVERY request, so its output proves genuine per-request server rendering out
// of the obfuscated server bundle.
interface SsrProps {
  serverTimestamp: number;
}

const Ssr: NextPage<SsrProps> = ({ serverTimestamp }) => (
  <main>
    <h1 data-testid="ssr-title">Server-rendered page</h1>
    <p data-testid="ssr-timestamp">{serverTimestamp}</p>
    <p>
      <Link href="/">Home</Link>
    </p>
  </main>
);

export default Ssr;

export const getServerSideProps: GetServerSideProps<SsrProps> = async () => ({
  props: { serverTimestamp: Date.now() },
});
