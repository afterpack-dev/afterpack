<script setup>
import { onMounted } from "vue";

const { restore } = useNotebook();

onMounted(restore);
</script>

<template>
  <nav aria-label="Main">
    <NuxtLink to="/">Home</NuxtLink>
    <NuxtLink to="/notes">Notes</NuxtLink>
    <NuxtLink to="/reports">Reports</NuxtLink>
  </nav>
  <main>
    <NuxtPage />
  </main>
</template>
