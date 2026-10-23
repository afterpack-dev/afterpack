import { Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { NotesStore } from "../notes.store";
import { SavedNotesModule } from "../saved-notes/saved-notes.module";

const TITLE_ERROR = "Give the note a title of at least 3 characters.";
const BODY_ERROR = "Keep the note under 140 characters.";

@Component({
  selector: "app-notes",
  standalone: true,
  imports: [ReactiveFormsModule, SavedNotesModule],
  template: `
    <h1>Notes</h1>
    <form aria-label="New note" novalidate [formGroup]="form" (ngSubmit)="submit()">
      <label>
        Title
        <input name="title" formControlName="title" [attr.aria-invalid]="Boolean(errors().title)" />
      </label>
      @if (errors().title; as message) {
        <p role="alert">{{ message }}</p>
      }
      <label>
        Body
        <textarea name="body" formControlName="body" [attr.aria-invalid]="Boolean(errors().body)"></textarea>
      </label>
      @if (errors().body; as message) {
        <p role="alert">{{ message }}</p>
      }
      <button type="submit">Add note</button>
    </form>
    <p role="status">{{ status() }}</p>
    <app-saved-notes [notes]="store.notes()" />
  `,
})
export class NotesComponent {
  readonly store = inject(NotesStore);
  readonly Boolean = Boolean;
  readonly errors = signal<{ title?: string; body?: string }>({});
  readonly status = signal("");
  readonly form;

  constructor(formBuilder: FormBuilder) {
    this.form = formBuilder.nonNullable.group({
      title: ["", [Validators.required, Validators.minLength(3)]],
      body: ["", Validators.maxLength(140)],
    });
  }

  submit(): void {
    const { title, body } = this.form.controls;
    if (this.form.invalid) {
      this.errors.set({
        title: title.invalid ? TITLE_ERROR : undefined,
        body: body.invalid ? BODY_ERROR : undefined,
      });
      this.status.set("");
      return;
    }
    const note = this.store.add({ title: title.value.trim(), body: body.value.trim() });
    this.errors.set({});
    this.status.set(`Saved note ${note.id}: ${note.title}`);
    this.form.reset();
  }
}
