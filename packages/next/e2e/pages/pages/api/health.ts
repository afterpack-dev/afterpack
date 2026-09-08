import type { NextApiRequest, NextApiResponse } from "next";

// The Pages Router's (req, res) API-route dialect, the only one this fixture has.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: "ok", router: "pages" });
}
