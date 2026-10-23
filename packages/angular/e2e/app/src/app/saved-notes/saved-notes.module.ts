import { Component, Input, NgModule } from "@angular/core";
import type { Note } from "../notes.store";

@Component({
  selector: "app-saved-notes",
  standalone: false,
  template: `
    <ul aria-label="Saved notes">
      @for (note of notes; track note.id) {
        <li><strong>{{ note.title }}</strong> {{ note.body }}</li>
      }
    </ul>
  `,
})
export class SavedNotesComponent {
  @Input({ required: true }) notes!: Note[];
}

@NgModule({
  declarations: [SavedNotesComponent],
  exports: [SavedNotesComponent],
})
export class SavedNotesModule {}
