export const META_WAREHOUSE_HISTORY_DAYS = 761;
export const META_CREATIVE_WAREHOUSE_HISTORY_DAYS = 455;
export const META_CREATIVE_MEDIA_RETENTION_DAYS = 90;

export function addDaysToIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayCountInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

export function getHistoricalWindowStart(endDate: string, totalDays = META_WAREHOUSE_HISTORY_DAYS): string {
  return addDaysToIsoDate(endDate, -(totalDays - 1));
}

export function getCreativeMediaRetentionStart(
  endDate: string,
  retentionDays = META_CREATIVE_MEDIA_RETENTION_DAYS
): string {
  return addDaysToIsoDate(endDate, -(retentionDays - 1));
}
