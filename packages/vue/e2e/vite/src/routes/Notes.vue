<script setup>
import { reactive, ref } from "vue";
import { NoteInput, store } from "../store.js";

const draft = reactive({ title: "", body: "" });
const errors = ref({});
const status = ref("");

function submit() {
  const result = NoteInput.safeParse({ ...draft });
  if (!result.success) {
    const next = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if ((field === "title" || field === "body") && !next[field]) next[field] = issue.message;
    }
    errors.value = next;
    status.value = "";
    return;
  }
  const note = store.add(result.data);
  errors.value = {};
  status.value = `Saved note ${note.id}: ${note.title}`;
  draft.title = "";
  draft.body = "";
}
</script>

<template>
  <h1>Notes</h1>
  <form aria-label="New note" novalidate @submit.prevent="submit">
    <label>
      Title
      <input v-model="draft.title" name="title" :aria-invalid="Boolean(errors.title)" />
    </label>
    <p v-if="errors.title" role="alert">{{ errors.title }}</p>
    <label>
      Body
      <textarea v-model="draft.body" name="body" :aria-invalid="Boolean(errors.body)"></textarea>
    </label>
    <p v-if="errors.body" role="alert">{{ errors.body }}</p>
    <button type="submit">Add note</button>
  </form>
  <p role="status">{{ status }}</p>
  <ul aria-label="Saved notes">
    <li v-for="note in store.notes" :key="note.id">
      <strong>{{ note.title }}</strong> {{ note.body }}
    </li>
  </ul>
</template>
