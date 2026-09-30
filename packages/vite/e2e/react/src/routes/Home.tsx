import { Counter } from "../Counter";

export function Home() {
  return (
    <>
      <h1 data-testid="title">Vite + React fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
      <Counter />
    </>
  );
}
