import type { AppProps } from "next/app";

// `pages/_app.tsx` is the Pages Router's composition root -- a file shape the
// App Router has no equivalent of. It ends up in its own client chunk, so it is
// real Pages-only code passing through the obfuscator.
export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <p data-testid="app-shell">pages/_app.tsx shell</p>
      <Component {...pageProps} />
    </>
  );
}
