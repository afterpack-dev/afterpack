import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    return NextResponse.json({ error: "Enter an email address like ada@example.com." }, { status: 400 });
  }
  return NextResponse.json({ subscribed: email });
}
