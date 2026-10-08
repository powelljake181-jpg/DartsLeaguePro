"use client";

import dynamic from "next/dynamic";
import type { LiveSnapshot } from "@/server/live-service";

/** The scoring app reads the phone's saved queue on start, so it only renders in the browser. */
const ScoreApp = dynamic(() => import("./score-app").then((m) => m.ScoreApp), {
  ssr: false,
  loading: () => <p className="p-6 text-center text-muted">Loading scoreboard…</p>,
});

export function ScoreAppLoader({ initial }: { initial: LiveSnapshot }) {
  return <ScoreApp initial={initial} />;
}
