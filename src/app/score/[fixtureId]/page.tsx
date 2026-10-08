import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { Notice, Page } from "@/components/ui";
import { can } from "@/domain/permissions";
import { requireActor } from "@/lib/session";
import { loadFixtureContext } from "@/server/context";
import { AppError } from "@/server/errors";
import { liveSnapshot } from "@/server/live-service";
import { ScoreAppLoader } from "./loader";

export const metadata: Metadata = { title: "Scoring", robots: { index: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1 };

/** The scoring screen. Only the responsible team's admins (or the league) can score. */
export default async function ScorePage(props: PageProps<"/score/[fixtureId]">) {
  const { fixtureId } = await props.params;
  const { actor } = await requireActor();
  const db = await getDb();
  const ctx = await loadFixtureContext(db, fixtureId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const allowed = can(actor, {
    action: "scoring.submit",
    leagueId: ctx.fixture.leagueId,
    fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId, responsibleSide: ctx.responsibleSide },
  });
  const snap = await liveSnapshot(db, fixtureId);
  if (!allowed) {
    const scorer = ctx.responsibleSide === "HOME" ? snap.home.name : snap.away.name;
    return (
      <Page narrow>
        <Notice tone="warning">
          {scorer} keep the official score for this match. You can follow it on the <Link className="underline" href={`/fixtures/${fixtureId}`}>match page</Link>.
        </Notice>
      </Page>
    );
  }
  return <ScoreAppLoader initial={snap} />;
}
