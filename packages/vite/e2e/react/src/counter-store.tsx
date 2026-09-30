import { createContext, type ReactNode, useContext, useState } from "react";

interface CounterState {
  count: number;
  increment: () => void;
}

const CounterContext = createContext<CounterState | null>(null);

export function CounterProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <CounterContext.Provider value={{ count, increment: () => setCount((c) => c + 1) }}>
      {children}
    </CounterContext.Provider>
  );
}

export function useCounter(): CounterState {
  const state = useContext(CounterContext);
  if (!state) throw new Error("useCounter needs a CounterProvider");
  return state;
}
