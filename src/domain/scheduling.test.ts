import { describe, expect, it } from "vitest";
import { weekdayOf, zonedTimeToUtc } from "./dates";
import { circleRounds, generateSchedule, longRuns, matchNights, type DivisionInput, type ScheduledFixture } from "./scheduling";

const teams = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const division = (id: string, n: number, over: Partial<DivisionInput> = {}): DivisionInput => ({
  id,
  name: id,
  teams: teams(id, n),
  weekday: 3,
  startDate: "2026-09-02",
  meetings: 2,
  excludedDates: [],
  ...over,
});

function pairCounts(fixtures: ScheduledFixture[]) {
  const counts = new Map<string, number>();
  for (const f of fixtures) counts.set(`${f.home}>${f.away}`, (counts.get(`${f.home}>${f.away}`) ?? 0) + 1);
  return counts;
}

describe("calendar", () => {
  it("uses the match night every week and skips excluded dates", () => {
    expect(matchNights("2026-09-01", 3, 4, ["2026-09-09"])).toEqual(["2026-09-02", "2026-09-16", "2026-09-23", "2026-09-30"]);
  });

  it("converts local kick-off times through daylight saving", () => {
    expect(zonedTimeToUtc("2026-09-02", "19:30", "Europe/London").toISOString()).toBe("2026-09-02T18:30:00.000Z");
    expect(zonedTimeToUtc("2027-01-06", "19:30", "Europe/London").toISOString()).toBe("2027-01-06T19:30:00.000Z");
  });
});

describe("round-robin", () => {
  it("pairs every slot with every other exactly once, once per round", () => {
    for (const n of [2, 4, 6, 10, 16]) {
      const rounds = circleRounds(n);
      expect(rounds).toHaveLength(n - 1);
      const seen = new Set<string>();
      for (const round of rounds) {
        const inRound = round.flat();
        expect(new Set(inRound).size).toBe(n);
        for (const [a, b] of round) seen.add([a, b].sort().join("-"));
      }
      expect(seen.size).toBe((n * (n - 1)) / 2);
    }
  });

  it("balances home and away within one round-robin", () => {
    for (const n of [4, 6, 8, 10, 12]) {
      const homes = new Array(n).fill(0);
      for (const round of circleRounds(n)) for (const [h] of round) homes[h]++;
      expect(Math.max(...homes) - Math.min(...homes)).toBeLessThanOrEqual(1);
    }
  });

  it("home and away: every team plays every other team once at home and once away", () => {
    const d = division("D", 10);
    const r = generateSchedule([d], []);
    const counts = pairCounts(r.fixtures);
    for (const a of d.teams) for (const b of d.teams) if (a !== b) expect(counts.get(`${a}>${b}`)).toBe(1);
    expect(r.fixtures).toHaveLength(90);
    // Each team plays once per round.
    for (let round = 1; round <= 18; round++) {
      const playing = r.fixtures.filter((f) => f.round === round).flatMap((f) => [f.home, f.away]);
      expect(new Set(playing).size).toBe(10);
    }
  });

  it("gives byes with an odd number of teams", () => {
    const r = generateSchedule([division("D", 5, { meetings: 1 })], []);
    expect(r.fixtures).toHaveLength(10);
    expect(r.byes).toHaveLength(5);
    expect(new Set(r.byes.map((b) => b.team)).size).toBe(5);
  });
});

describe("the brief's Division 1 example", () => {
  const excluded = ["2026-10-28", "2026-12-23", "2026-12-30", "2027-02-17"];
  const r = generateSchedule([division("D1", 10, { excludedDates: excluded })], []);

  it("schedules 18 rounds of Wednesdays from 2 September around the excluded dates", () => {
    const dates = r.dates.D1;
    expect(dates).toHaveLength(18);
    expect(dates[0]).toBe("2026-09-02");
    expect(dates.every((d) => weekdayOf(d) === 3)).toBe(true);
    for (const x of excluded) expect(r.fixtures.some((f) => f.date === x)).toBe(false);
    // 28 Oct is skipped, so round 9 is on 4 Nov.
    expect(dates[8]).toBe("2026-11-04");
  });
});

describe("home and away runs", () => {
  it("counts runs of three or more", () => {
    const f = (date: string, home: string, away: string): ScheduledFixture => ({ divisionId: "D", round: 1, date, home, away });
    expect(longRuns([f("2026-01-01", "A", "B"), f("2026-01-08", "A", "C"), f("2026-01-15", "A", "D")])).toBe(1 + 0);
  });

  it("keeps teams from playing three home or three away games in a row", () => {
    const r = generateSchedule([division("A", 10), division("B", 8)], [{ id: "v", name: "V", teams: ["A1", "B1"], maxHome: 1 }], { seed: 11 });
    expect(r.conflicts).toEqual([]);
    expect(longRuns(r.fixtures)).toBe(0);
  });
});

describe("shared venues", () => {
  it("never has Melville and Melville B at home on the same Wednesday", () => {
    const d1 = division("D1", 10);
    const d3 = division("D3", 8);
    const constraint = { id: "melville", name: "Melville", teams: ["D11", "D31"], maxHome: 1 };
    const r = generateSchedule([d1, d3], [constraint], { seed: 7 });
    expect(r.conflicts).toEqual([]);
    const homeDates = (t: string) => new Set(r.fixtures.filter((f) => f.home === t).map((f) => f.date));
    const a = homeDates("D11");
    for (const date of homeDates("D31")) expect(a.has(date)).toBe(false);
  });

  it("satisfies several venue groups at once", () => {
    const divs = [division("A", 10), division("B", 10), division("C", 8)];
    const constraints = [
      { id: "1", name: "Crown", teams: ["A1", "B1"], maxHome: 1 },
      { id: "2", name: "Swan", teams: ["A2", "C2"], maxHome: 1 },
      { id: "3", name: "Bull", teams: ["B3", "C3"], maxHome: 1 },
      { id: "4", name: "Club", teams: ["A4", "B4", "C4"], maxHome: 2 },
    ];
    expect(generateSchedule(divs, constraints, { seed: 3 }).conflicts).toEqual([]);
  });

  it("handles two teams sharing a venue in the same division", () => {
    const r = generateSchedule([division("D", 8)], [{ id: "v", name: "Shared", teams: ["D1", "D2"], maxHome: 1 }], { seed: 5 });
    expect(r.conflicts).toEqual([]);
  });

  it("ignores divisions on different nights", () => {
    const r = generateSchedule([division("A", 4), division("B", 4, { weekday: 4 })], [{ id: "v", name: "V", teams: ["A1", "B1"], maxHome: 1 }]);
    expect(r.conflicts).toEqual([]);
  });

  it("reports clashes it cannot avoid instead of hiding them", () => {
    // Three two-team divisions on the same night: each team is at home once in two weeks,
    // so three teams sharing one venue can't all fit.
    const divs = [division("A", 2), division("B", 2), division("C", 2)];
    const r = generateSchedule(divs, [{ id: "v", name: "Tiny pub", teams: ["A1", "B1", "C1"], maxHome: 1 }]);
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.conflicts[0]).toMatchObject({ constraintName: "Tiny pub", maxHome: 1 });
    expect(r.fixtures).toHaveLength(6);
  });

  it("is reproducible for a seed", () => {
    const divs = [division("A", 6), division("B", 6)];
    const c = [{ id: "v", name: "V", teams: ["A1", "B1"], maxHome: 1 }];
    expect(generateSchedule(divs, c, { seed: 42 })).toEqual(generateSchedule(divs, c, { seed: 42 }));
  });

  it("rejects a team in two divisions", () => {
    expect(() => generateSchedule([division("A", 4), { ...division("B", 4), teams: ["A1", "B2", "B3", "B4"] }], [])).toThrow(/more than one division/);
  });
});
