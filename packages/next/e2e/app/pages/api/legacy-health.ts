import type { NextApiRequest, NextApiResponse } from "next";

// Pages-Router-STYLE API route -- the OLDER (req, res) handler signature,
// deliberately a different code shape from the App Router's
// `app/api/health/route.ts` (`GET` export) so both API-route dialects are
// exercised through obfuscation.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: "ok", router: "pages" });
}
