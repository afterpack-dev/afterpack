"use client";

import dynamic from "next/dynamic";

export const StatsLoader = dynamic(() => import("./StatsPanel"), {
  ssr: false,
  loading: () => <p>Loading the stats…</p>,
});
