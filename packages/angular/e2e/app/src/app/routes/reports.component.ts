import { Component, computed, inject } from "@angular/core";
import { type Note, NotesStore } from "../notes.store";
import { PluralPipe } from "../plural.pipe";

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

  get count(): number {
    return this.#notes.length;
  }
}

@Component({
  selector: "app-reports",
  standalone: true,
  imports: [PluralPipe],
  template: `
    <h1>Reports</h1>
    <p data-testid="report-summary">{{ report().count | plural: "note" }}, {{ report().words | plural: "word" }}</p>
    <p data-testid="report-longest">
      {{ report().longest ? "Longest title: " + report().longest : "No notes yet" }}
    </p>
  `,
})
export class ReportsComponent {
  readonly #store = inject(NotesStore);
  readonly report = computed(() => new NoteReport(this.#store.notes()));
}
