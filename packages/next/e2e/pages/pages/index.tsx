import type { GetStaticProps, NextPage } from "next";
import Link from "next/link";
import { Counter } from "../components/Counter";

// Statically generated at build time via getStaticProps -- the Pages Router's
// SSG path, which has no App Router equivalent code shape.
interface HomeProps {
  builtWith: string;
}

const Home: NextPage<HomeProps> = ({ builtWith }) => (
  <main>
    <h1 data-testid="title">Next.js Pages Router fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <p data-testid="built-with">{builtWith}</p>
    <Counter />
    <p>
      <Link href="/ssr" prefetch={false}>
        SSR page
      </Link>
    </p>
  </main>
);

export default Home;

export const getStaticProps: GetStaticProps<HomeProps> = async () => ({
  props: { builtWith: "getStaticProps" },
});
