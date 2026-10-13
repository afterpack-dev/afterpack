import { Component, computed, type OnInit, signal } from "@angular/core";

@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <h1 data-testid="title">Angular fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button type="button" data-testid="counter" (click)="increment()">
      count is {{ count() }} ({{ parity() }})
    </button>
    <p data-testid="lazy">{{ lazy() }}</p>
  `,
})
export class AppComponent implements OnInit {
  readonly count = signal(0);
  readonly lazy = signal("loading");
  readonly parity = computed(() => (this.count() % 2 === 0 ? "even" : "odd"));

  ngOnInit(): void {
    import("./lazy").then((m) => this.lazy.set(m.describeLazyChunk()));
  }

  increment(): void {
    this.count.update((c) => c + 1);
  }
}
