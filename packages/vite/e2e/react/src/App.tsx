import { lazy, Suspense } from "react";
import { NavLink, Route, Routes } from "react-router";
import { Home } from "./routes/Home";
import { Notes } from "./routes/Notes";

const Reports = lazy(() => import("./routes/Reports"));

export default function App() {
  return (
    <>
      <nav aria-label="Main">
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/notes">Notes</NavLink>
        <NavLink to="/reports">Reports</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/notes" element={<Notes />} />
          <Route
            path="/reports"
            element={
              <Suspense fallback={<p>Loading the report…</p>}>
                <Reports />
              </Suspense>
            }
          />
        </Routes>
      </main>
    </>
  );
}
