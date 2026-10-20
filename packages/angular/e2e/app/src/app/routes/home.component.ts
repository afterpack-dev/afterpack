import { Component, inject, type OnInit, signal } from "@angular/core";
import { NotesStore } from "../notes.store";

@Component({
  selector: "app-home",
  standalone: true,
  template: `
    <h1 data-testid="title">Angular fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button type="button" data-testid="counter" (click)="store.increment()">
      count is {{ store.count() }} ({{ store.parity() }})
    </button>
    <p data-testid="lazy">{{ lazy() }}</p>
  `,
})
export class HomeComponent implements OnInit {
  readonly store = inject(NotesStore);
  readonly lazy = signal("loading");

  ngOnInit(): void {
    import("../lazy").then((m) => this.lazy.set(m.describeLazyChunk()));
  }
}
