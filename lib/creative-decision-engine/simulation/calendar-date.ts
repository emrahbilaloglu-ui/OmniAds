const POSTGRES_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatCalendarDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isValidCalendarDate(year: number, month: number, day: number) {
  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/**
 * Normalizes a PostgreSQL DATE value without converting its calendar day to UTC.
 *
 * `pg` materializes DATE values as local-midnight Date instances in some parser
 * configurations. Reading those values through `toISOString()` can move a date
 * one day backwards in positive UTC offsets. Timestamp values are intentionally
 * outside this helper's contract and must keep their own instant semantics.
 */
export function normalizePostgresDate(value: unknown): string | null {
  if (typeof value === "string") {
    const match = POSTGRES_DATE_PATTERN.exec(value.trim());
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return isValidCalendarDate(year, month, day)
      ? formatCalendarDate(year, month, day)
      : null;
  }

  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return null;
  }

  if (
    value.getHours() !== 0 ||
    value.getMinutes() !== 0 ||
    value.getSeconds() !== 0 ||
    value.getMilliseconds() !== 0
  ) {
    return null;
  }

  return formatCalendarDate(
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
  );
}
