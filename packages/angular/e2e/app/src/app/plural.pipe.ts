import { Pipe, type PipeTransform } from "@angular/core";

@Pipe({ name: "plural", standalone: true, pure: true })
export class PluralPipe implements PipeTransform {
  transform(count: number, singular: string): string {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
  }
}
