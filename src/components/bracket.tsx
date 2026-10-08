import Link from "next/link";
import type { cupBracket } from "@/server/cup-service";
import { formatDate } from "./ui";

type Bracket = Awaited<ReturnType<typeof cupBracket>>;
type TieData = NonNullable<Bracket["rounds"][number]["ties"][number]>;

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * A knockout bracket: one column per round, ties spaced so each sits level
 * with the two ties that feed it. Scrolls sideways on a phone.
 */
export function BracketView({ bracket, tieHref }: { bracket: Bracket; tieHref: (fixtureId: string) => string }) {
  const tz = bracket.league.timezone;
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2">
      <div className="flex min-w-max gap-4">
        {bracket.rounds.map((r) => (
          <section key={r.id} className="flex w-56 flex-col" aria-label={r.name}>
            <header className="mb-2">
              <h3 className="text-sm font-semibold">{r.name}</h3>
              <p className="text-xs text-muted">
                {r.scheduledOn ? `${formatDate(r.scheduledOn, tz, { weekday: "short", day: "numeric", month: "short" })} · ${r.kickOff}` : "Date to be set"}
              </p>
            </header>
            <ol className="flex flex-1 flex-col justify-around gap-2">
              {r.ties.map((t, i) => (
                <li key={i}>{t ? <TieCard tie={t} href={tieHref(t.id)} /> : <EmptyTie />}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function TieCard({ tie, href }: { tie: TieData; href: string }) {
  const bye = !tie.away;
  const live = tie.status === "LIVE";
  const score = (side: "home" | "away") =>
    tie.score ? (side === "home" ? tie.score.home : tie.score.away) : tie.liveScore ? (side === "home" ? tie.liveScore.home : tie.liveScore.away) : null;
  const row = (side: "home" | "away") => {
    const team = side === "home" ? tie.home : tie.away;
    const won = !!team && tie.winnerEntryId === team.entryId;
    const lost = !!tie.winnerEntryId && !won;
    return (
      <div className={cx("flex items-center justify-between gap-2 px-2.5 py-1.5", won && "font-bold", lost && "text-muted")}>
        <span className="truncate">{team ? team.name : <span className="italic text-muted">bye</span>}</span>
        {!bye && <span className="tabular-nums">{score(side) ?? ""}</span>}
      </div>
    );
  };
  const note = bye ? null : tie.status === "VOID" ? "Void" : tie.status === "POSTPONED" ? "Postponed" : tie.awarded ? "Awarded" : live ? "Live" : null;
  return (
    <Link href={href} className={cx("block divide-y divide-border rounded-lg border bg-surface text-sm shadow-sm hover:border-accent", live ? "border-live/60" : "border-border")}>
      {row("home")}
      {row("away")}
      {note && <div className={cx("px-2.5 py-0.5 text-[11px]", live ? "font-semibold text-live" : "text-muted")}>{note}</div>}
    </Link>
  );
}

function EmptyTie() {
  return (
    <div className="divide-y divide-dashed divide-border rounded-lg border border-dashed border-border text-sm text-muted">
      <div className="px-2.5 py-1.5">To be decided</div>
      <div className="px-2.5 py-1.5">To be decided</div>
    </div>
  );
}
