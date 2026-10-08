import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { Page } from "@/components/ui";
import { AppError } from "@/server/errors";
import { liveSnapshot } from "@/server/live-service";
import { LiveFixture } from "./live-fixture";

async function load(fixtureId: string) {
  return liveSnapshot(await getDb(), fixtureId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
}

export async function generateMetadata(props: PageProps<"/fixtures/[fixtureId]">): Promise<Metadata> {
  const { fixtureId } = await props.params;
  const s = await load(fixtureId);
  const score = s.status === "SCHEDULED" ? "v" : `${s.groups[0].homeGames}–${s.groups[0].awayGames}`;
  return { title: `${s.home.name} ${score} ${s.away.name}`, description: `${s.competitionName}, ${s.league.name}` };
}

/** Public fixture page: shareable, no login, live while the match is on. */
export default async function FixturePage(props: PageProps<"/fixtures/[fixtureId]">) {
  const { fixtureId } = await props.params;
  const snap = await load(fixtureId);
  return (
    <Page>
      <Link href={`/leagues/${snap.league.slug}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <span aria-hidden>‹</span> {snap.league.name}
      </Link>
      <LiveFixture initial={snap} />
    </Page>
  );
}
