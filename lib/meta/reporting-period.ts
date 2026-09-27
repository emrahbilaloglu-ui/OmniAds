/** Reporting only: these dates must never enter a decision or action identity. */
export function reportingDayCount(startDate: string, endDate: string): number | null {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      ? date.getTime() : null;
  };
  const start = parse(startDate);
  const end = parse(endDate);
  return start === null || end === null || end < start
    ? null : (end - start) / 86_400_000 + 1;
}
