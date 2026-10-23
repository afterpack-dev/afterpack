import { Component, EventEmitter, HostListener, Input, Output } from "@angular/core";

@Component({
  selector: "button[appCounter]",
  standalone: true,
  template: `count is {{ count }} ({{ parity }})`,
})
export class CounterButtonComponent {
  @Input({ required: true }) count!: number;
  @Input({ required: true }) parity!: string;
  @Output() readonly increment = new EventEmitter<void>();

  @HostListener("click")
  onClick(): void {
    this.increment.emit();
  }
}
