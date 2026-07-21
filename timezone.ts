/**
 * Timezone handling.
 *
 * ClickBank's Analytics API treats the start/end dates you pass as UTC calendar
 * days and reports data on a UTC basis. ClickBank's OWN dashboard, however,
 * displays everything in Pacific time (America/Los_Angeles, i.e. PST/PDT).
 *
 * Those two clocks do not line up: a Pacific day begins 7-8 hours AFTER the
 * corresponding UTC day. So sales that happen late in a Pacific day can fall
 * on the next UTC calendar day, and a UTC-bounded query will not exactly match
 * a Pacific-bounded dashboard view. This module makes that explicit in every
 * response so Claude never silently misreports a day's numbers by an offset.
 */

const PACIFIC_TZ = "America/Los_Angeles";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a YYYY-MM-DD date string; throws a clear error otherwise. */
export function assertDate(name: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(
      `${name} must be in YYYY-MM-DD format (got "${value}"). Example: 2026-07-09`,
    );
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`${name} is not a valid calendar date: "${value}".`);
  }
}

/** Offset in minutes of a timezone from UTC at a given instant (negative = west of UTC). */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return (asUTC - instant.getTime()) / 60000;
}

/** Human-readable Pacific abbreviation (PST/PDT) for a date. */
function pacificAbbrev(instant: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    timeZoneName: "short",
    year: "numeric",
  });
  const part = dtf.formatToParts(instant).find((p) => p.type === "timeZoneName");
  return part?.value ?? "PT";
}

export interface TimezoneNote {
  api_basis: string;
  dashboard_basis: string;
  pacific_offset_from_utc: string;
  explanation: string;
  reconciliation_tip: string;
}

/**
 * Build the timezone note for a given start date. The Pacific offset is
 * computed for that date so DST (PST vs PDT) is reflected accurately.
 */
export function timezoneNote(startDate: string): TimezoneNote {
  // Evaluate the offset at noon UTC on the start date to avoid edge effects.
  const instant = new Date(`${startDate}T12:00:00Z`);
  const offsetMin = tzOffsetMinutes(instant, PACIFIC_TZ);
  const offsetHours = offsetMin / 60;
  const abbrev = pacificAbbrev(instant);
  const sign = offsetHours <= 0 ? "" : "+";
  const offsetLabel = `UTC${sign}${offsetHours} (${abbrev})`;

  return {
    api_basis: "UTC — the dates you queried are treated as UTC calendar days.",
    dashboard_basis: "Pacific time (America/Los_Angeles) — what the ClickBank web dashboard shows.",
    pacific_offset_from_utc: offsetLabel,
    explanation:
      `On ${startDate}, Pacific time is ${offsetLabel}. A Pacific day starts ` +
      `${Math.abs(offsetHours)} hours after the UTC day, so figures here are on a UTC ` +
      `basis and will not line up exactly with a Pacific-bounded dashboard view near ` +
      `the day boundaries.`,
    reconciliation_tip:
      "If these numbers are close to the dashboard but off by a few hours' worth of " +
      "sales, that is the UTC-vs-Pacific offset, not a bug. To compare a specific " +
      "Pacific day, expect the boundary sales to shift by the offset above.",
  };
}
