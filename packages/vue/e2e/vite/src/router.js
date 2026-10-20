import { createRouter, createWebHistory } from "vue-router";
import Home from "./routes/Home.vue";
import Notes from "./routes/Notes.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/notes", component: Notes },
    { path: "/reports", component: () => import("./routes/Reports.vue") },
  ],
});
