import { describe, expect, it } from "vitest";
import { FoldError, planFold, type FoldFixture } from "./folds";
import { renderNotification } from "./notifications";
import { hasExpired, proposalWarnings } from "./rearrangements";

describe("rearrangement proposals", () => {
  it("warns (never blocks) about team clashes, blackouts and full venues", () => {
    const w = proposalWarnings({
      proposedDate: "2026-11-04",
      teamClashes: [{ teamName: "Crown", opponentName: "Swan" }],
      blackouts: [{ reason: "Cup night" }],
      venueLimits: [
        { name: "The Melville", maxHomePerDate: 1, homeAlready: 1 },
        { name: "The Crown", maxHomePerDate: 2, homeAlready: 1 },
      ],
    });
    expect(w.map((x) => x.code)).toEqual(["TEAM_CLASH", "BLACKOUT", "VENUE_LIMIT"]);
    expect(w[2].message).toBe("The Melville: 1 home match already that night (limit 1)");
  });

  it("expires once the original or the proposed time has passed", () => {
    const r = { originalAt: new Date("2026-11-04T19:30:00Z"), proposedAt: new Date("2026-11-11T19:30:00Z") };
    expect(hasExpired(r, new Date("2026-11-04T19:29:00Z"))).toBe(false);
    expect(hasExpired(r, new Date("2026-11-04T19:30:00Z"))).toBe(true);
    expect(hasExpired({ ...r, proposedAt: new Date("2026-11-01T19:30:00Z") }, new Date("2026-11-02T00:00:00Z"))).toBe(true);
  });
});

describe("folding a team", () => {
  const fixtures: FoldFixture[] = [
    { id: "played-home", status: "COMPLETED", side: "HOME" },
    { id: "next-away", status: "SCHEDULED", side: "AWAY" },
    { id: "postponed", status: "POSTPONED", side: "HOME" },
    { id: "asked-to-move", status: "REARRANGEMENT_REQUESTED", side: "HOME" },
    { id: "already-void", status: "VOID", side: "AWAY" },
  ];
  const plan = (r: Parameters<typeof planFold>[1]) => Object.fromEntries(planFold(fixtures, r).map((a) => [a.fixtureId, a.action === "AWARD" ? `AWARD ${a.winner}` : a.action]));

  it("voids everything not already void", () => {
    expect(plan("VOID_ALL")).toEqual({ "played-home": "VOID", "next-away": "VOID", postponed: "VOID", "asked-to-move": "VOID", "already-void": "KEEP" });
  });

  it("awards unplayed fixtures to the opponent and keeps played results", () => {
    expect(plan("MAX_LOSS_REMAINING")).toEqual({
      "played-home": "KEEP",
      "next-away": "AWARD HOME",
      postponed: "AWARD AWAY",
      "asked-to-move": "AWARD AWAY",
      "already-void": "KEEP",
    });
  });

  it("can also replace played results with a maximum loss", () => {
    expect(plan("MAX_LOSS_ALL")["played-home"]).toBe("AWARD AWAY");
  });

  it("refuses while one of the team's matches is live", () => {
    expect(() => planFold([{ id: "x", status: "LIVE", side: "HOME" }], "VOID_ALL")).toThrow(FoldError);
  });
});

describe("notification wording", () => {
  const base = { fixtureId: "f1", leagueSlug: "manchester", home: "Melville", away: "Crown", tz: "Europe/London" };

  it("describes a request with both dates in the league's timezone, the note and any warnings", () => {
    const n = renderNotification("rearrangement.requested", {
      ...base,
      requestedBy: "Crown",
      originalAt: "2026-11-04T19:30:00Z",
      proposedAt: "2026-11-11T19:30:00Z",
      note: "Darts night clash",
      warnings: ["Melville already play Swan that night"],
    });
    expect(n.title).toBe("Rearrangement requested: Melville v Crown");
    expect(n.body).toBe('Crown ask to move it from Wed 4 Nov, 19:30 to Wed 11 Nov, 19:30. "Darts night clash" Note: Melville already play Swan that night.');
    expect(n.href).toBe("/admin/manchester/fixtures/f1");
  });

  it("links team folds to the public tables", () => {
    expect(renderNotification("team.folded", { leagueSlug: "manchester", team: "Swan", competition: "Division 1", fixtures: 9 })).toMatchObject({
      title: "Swan have folded",
      href: "/leagues/manchester/tables",
    });
  });
});
