<script setup>
import { store } from "../store.js";
</script>

<template>
  <h1 data-testid="title">Vue 3 + Vite fixture</h1>
  <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
  <button type="button" data-testid="counter" @click="store.increment()">
    count is {{ store.count }} ({{ store.parity }})
  </button>
</template>
