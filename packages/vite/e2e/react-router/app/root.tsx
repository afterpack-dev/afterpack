import { Links, Meta, NavLink, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { ReactNode } from "react";
import { CounterProvider } from "./counter";

export const links = () => [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>React Router framework fixture</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <CounterProvider>
      <nav aria-label="Main">
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/notes">Notes</NavLink>
        <NavLink to="/reports">Reports</NavLink>
      </nav>
      <main>
        <Outlet />
      </main>
    </CounterProvider>
  );
}
