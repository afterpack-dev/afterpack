import { Component, computed, signal } from "@angular/core";

@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <h1 data-testid="title">Angular fixture</h1>
    <p data-testid="intro">AfterPack framework-integration smoke fixture.</p>
    <button type="button" data-testid="counter" (click)="increment()">
      count is {{ count() }} ({{ parity() }})
    </button>
  `,
})
export class AppComponent {
  readonly count = signal(0);
  readonly parity = computed(() => (this.count() % 2 === 0 ? "even" : "odd"));

  increment(): void {
    this.count.update((c) => c + 1);
  }
}
