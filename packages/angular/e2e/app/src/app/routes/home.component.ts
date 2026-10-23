import { Component, inject, type OnInit, signal } from "@angular/core";
import { CounterButtonComponent } from "../counter-button.component";
import { NotesStore } from "../notes.store";

@Component({
  selector: "app-home",
  standalone: true,
  imports: [CounterButtonComponent],
  template: `
    <h1 data-testid="title">Angular fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button
      type="button"
      appCounter
      data-testid="counter"
      [count]="store.count()"
      [parity]="store.parity()"
      (increment)="store.increment()"
    ></button>
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
