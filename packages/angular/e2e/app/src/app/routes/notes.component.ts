import { Component, inject, signal } from "@angular/core";
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
} from "@angular/forms";
import { NotesStore } from "../notes.store";

const TITLE_ERROR = "Give the note a title of at least 3 characters.";
const BODY_ERROR = "Keep the note under 140 characters.";

function trimmedMinLength(min: number, message: string) {
  return (control: AbstractControl): ValidationErrors | null =>
    String(control.value ?? "").trim().length >= min ? null : { message };
}

function trimmedMaxLength(max: number, message: string) {
  return (control: AbstractControl): ValidationErrors | null =>
    String(control.value ?? "").trim().length <= max ? null : { message };
}

@Component({
  selector: "app-notes",
  standalone: true,
  imports: [ReactiveFormsModule],
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
    <ul aria-label="Saved notes">
      @for (note of store.notes(); track note.id) {
        <li><strong>{{ note.title }}</strong> {{ note.body }}</li>
      }
    </ul>
  `,
})
export class NotesComponent {
  readonly store = inject(NotesStore);
  readonly Boolean = Boolean;
  readonly errors = signal<{ title?: string; body?: string }>({});
  readonly status = signal("");
  readonly form = new FormGroup({
    title: new FormControl("", { nonNullable: true, validators: trimmedMinLength(3, TITLE_ERROR) }),
    body: new FormControl("", { nonNullable: true, validators: trimmedMaxLength(140, BODY_ERROR) }),
  });

  submit(): void {
    const { title, body } = this.form.controls;
    if (this.form.invalid) {
      this.errors.set({ title: title.errors?.["message"], body: body.errors?.["message"] });
      this.status.set("");
      return;
    }
    const note = this.store.add({ title: title.value.trim(), body: body.value.trim() });
    this.errors.set({});
    this.status.set(`Saved note ${note.id}: ${note.title}`);
    this.form.reset();
  }
}
