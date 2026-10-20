import type { Routes } from "@angular/router";
import { HomeComponent } from "./routes/home.component";
import { NotesComponent } from "./routes/notes.component";

export const routes: Routes = [
  { path: "", component: HomeComponent },
  { path: "notes", component: NotesComponent },
  {
    path: "reports",
    loadComponent: () => import("./routes/reports.component").then((m) => m.ReportsComponent),
  },
];
