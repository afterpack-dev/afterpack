import { NextResponse } from "next/server";

// Static-export-compatible Route Handler: fixed JSON, no Request-derived
// logic (reading headers/query/body, cookies, etc. would make this route
// dynamic, which is a hard `next build` failure under `output: "export"`).
// `dynamic = "force-static"` is REQUIRED here -- confirmed via a real build
// this session: without it, `next build --output=export` hard-fails
// ("export const dynamic = \"force-static\"/export const revalidate not
// configured on route ... with output: export"), even though this handler
// has no Request-derived logic at all. Rendered once at build time into a
// static out/api/health payload.
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
