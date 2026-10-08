/** Calendar helpers. League dates (deadlines, match nights, rule changes) are local to the league's timezone. */

/**
 * The instant a deadline "date" ends in the league's timezone, e.g.
 * 31 January in Europe/London → 2027-01-31T23:59:59.999Z (GMT), and a
 * summer date ends at 22:59:59.999Z (BST).
 */
export function endOfDayInZone(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Start from local midnight of the next day expressed as UTC, then correct by the zone offset.
  const guess = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - offset;
  // Re-check offset at the corrected instant (DST transition days).
  const offset2 = zoneOffsetMs(new Date(corrected), timeZone);
  return new Date(guess - offset2 - 1);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of a local date and time (HH:MM) in a timezone, e.g. 19:30 London in September → 18:30Z. */
export function zonedTimeToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const offset2 = zoneOffsetMs(new Date(guess - offset), timeZone);
  return new Date(guess - offset2);
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
