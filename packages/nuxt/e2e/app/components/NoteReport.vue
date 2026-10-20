<script setup>
import { computed } from "vue";

class NoteReport {
  #notes;

  constructor(notes) {
    this.#notes = notes;
  }

  get words() {
    return this.#notes.reduce(
      (total, note) => total + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length,
      0,
    );
  }

  get longest() {
    return this.#notes.reduce((best, note) => (note.title.length > best.length ? note.title : best), "");
  }

  get summary() {
    const count = this.#notes.length;
    return `${count} ${count === 1 ? "note" : "notes"}, ${this.words} words`;
  }
}

const { notes } = useNotebook();
const report = computed(() => new NoteReport(notes.value));
</script>

<template>
  <p data-testid="report-summary">{{ report.summary }}</p>
  <p data-testid="report-longest">
    {{ report.longest ? `Longest title: ${report.longest}` : "No notes yet" }}
  </p>
</template>
