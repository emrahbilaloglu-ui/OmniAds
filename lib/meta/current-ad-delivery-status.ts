/** Meta can report ACTIVE after a campaign or ad-set schedule has ended. */
export interface CurrentAdScheduleStatusInput {
  effectiveStatus: string | null;
  campaignStopTime?: string | null;
  adsetEndTime?: string | null;
  fetchedAt: string;
}

function currentScheduleExpiry(row: CurrentAdScheduleStatusInput): {
  campaignEnded: boolean; adsetEnded: boolean;
} | null {
  const ends = [row.campaignStopTime, row.adsetEndTime];
  if (ends.every((value) => !value?.trim())) {
    return { campaignEnded: false, adsetEnded: false };
  }
  const fetchedAt = Date.parse(row.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  const parsed = ends.map((value) => value?.trim() ? Date.parse(value) : null);
  if (parsed.some((value) => value !== null && !Number.isFinite(value))) return null;
  return {
    campaignEnded: parsed[0] !== null && parsed[0]! <= fetchedAt,
    adsetEnded: parsed[1] !== null && parsed[1]! <= fetchedAt,
  };
}

const providerStatus = (value: string | null) => value?.trim().toUpperCase() || null;

export function currentEffectiveAdStatus(row: CurrentAdScheduleStatusInput): string | null {
  const schedule = currentScheduleExpiry(row);
  if (!schedule) return null;
  return schedule.campaignEnded || schedule.adsetEnded
    ? "SCHEDULE_ENDED"
    : providerStatus(row.effectiveStatus);
}

export function currentHierarchyStatuses(row: CurrentAdScheduleStatusInput) {
  const schedule = currentScheduleExpiry(row);
  const status = schedule ? providerStatus(row.effectiveStatus) ?? "UNKNOWN" : "UNKNOWN";
  return {
    campaign: schedule?.campaignEnded ? "SCHEDULE_ENDED" : status,
    adset: schedule?.adsetEnded ? "SCHEDULE_ENDED" : status,
    ad: status,
    scheduleEnded: Boolean(schedule?.campaignEnded || schedule?.adsetEnded),
  };
}
