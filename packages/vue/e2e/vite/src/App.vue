<script setup>
import { computed, ref } from "vue";

const count = ref(0);
const parity = computed(() => (count.value % 2 === 0 ? "even" : "odd"));
</script>

<template>
  <h1 data-testid="title">Vue 3 + Vite fixture</h1>
  <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
  <button type="button" data-testid="counter" @click="count++">
    count is {{ count }} ({{ parity }})
  </button>
</template>
