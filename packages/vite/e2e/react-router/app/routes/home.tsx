import { useCounter } from "../counter";

export default function Home() {
  const { count, increment } = useCounter();
  return (
    <>
      <h1 data-testid="title">React Router framework fixture</h1>
      <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
      <button type="button" data-testid="counter" onClick={increment}>
        {`count is ${count} (${count % 2 === 0 ? "even" : "odd"})`}
      </button>
    </>
  );
}
