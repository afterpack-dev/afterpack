import { type Note, useNotebook } from "../lib/notebook";

class NoteReport {
  readonly #notes: Note[];

  constructor(notes: Note[]) {
    this.#notes = notes;
  }

  get words(): number {
    return this.#notes.reduce(
      (total, note) => total + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length,
      0,
    );
  }

  get longest(): string {
    return this.#notes.reduce((best, note) => (note.title.length > best.length ? note.title : best), "");
  }

  get summary(): string {
    const count = this.#notes.length;
    return `${count} ${count === 1 ? "note" : "notes"}, ${this.words} words`;
  }
}

export default function Report() {
  const report = new NoteReport(useNotebook().notes);

  return (
    <>
      <p data-testid="report-summary">{report.summary}</p>
      <p data-testid="report-longest">
        {report.longest ? `Longest title: ${report.longest}` : "No notes yet"}
      </p>
    </>
  );
}
