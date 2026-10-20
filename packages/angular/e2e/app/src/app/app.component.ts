import { Component } from "@angular/core";
import { RouterLink, RouterOutlet } from "@angular/router";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterLink, RouterOutlet],
  template: `
    <nav aria-label="Main">
      <a routerLink="/">Home</a>
      <a routerLink="/notes">Notes</a>
      <a routerLink="/reports">Reports</a>
    </nav>
    <main>
      <router-outlet />
    </main>
  `,
})
export class AppComponent {}
