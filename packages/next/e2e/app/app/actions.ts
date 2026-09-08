"use server";

// A minimal Server Action. Exercises Next.js's dual-bundle split: the
// "use server" prologue string is an RSC protocol literal that the engine
// must pin (framework-integration.md §9.2, Next.js row / §2.4 literals).
export async function echo(message: string): Promise<string> {
  return `server received: ${message}`;
}
