"use server";

export type SignResult =
  | { ok: true; entry: { name: string; message: string } }
  | { ok: false; errors: { name?: string; message?: string } };

export async function signGuestbook(_previous: SignResult | null, form: FormData): Promise<SignResult> {
  const name = String(form.get("name") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  const errors: { name?: string; message?: string } = {};
  if (name.length < 2) errors.name = "Tell us a name of at least 2 characters.";
  if (message.length === 0) errors.message = "Leave a message.";
  else if (message.length > 80) errors.message = "Keep the message under 80 characters.";
  if (errors.name || errors.message) return { ok: false, errors };
  return { ok: true, entry: { name, message } };
}
