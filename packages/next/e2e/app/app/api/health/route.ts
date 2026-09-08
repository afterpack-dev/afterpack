import { NextResponse } from "next/server";

// Minimal API route — exercises the Next.js server bundle (.next/server/**).
export function GET() {
  return NextResponse.json({ status: "ok" });
}
