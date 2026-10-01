export function escapeParcelMarkdown(message: string): string {
  return message.replace(/[\\*_`~]/g, (c) => `\\${c}`);
}
