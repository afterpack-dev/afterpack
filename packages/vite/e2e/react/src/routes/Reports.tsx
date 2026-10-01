import { useNotes } from "../notes-store";

export default function Reports() {
  const { notes } = useNotes();
  const words = notes.reduce(
    (total, note) => total + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length,
    0,
  );
  const longest = notes.reduce((best, note) => (note.title.length > best.length ? note.title : best), "");

  return (
    <>
      <h1>Reports</h1>
      <p data-testid="report-summary">
        {notes.length} {notes.length === 1 ? "note" : "notes"}, {words} words
      </p>
      <p data-testid="report-longest">{longest ? `Longest title: ${longest}` : "No notes yet"}</p>
    </>
  );
}
