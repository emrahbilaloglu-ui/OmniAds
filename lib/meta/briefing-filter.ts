export type BriefingStatusFilter = "active" | "active_plus_recent_paused" | "all";

export const BRIEFING_STATUS_FILTERS: BriefingStatusFilter[] = [
  "active",
  "active_plus_recent_paused",
  "all",
];

export const BRIEFING_STATUS_FILTER_LABELS: Record<BriefingStatusFilter, string> = {
  active: "Active",
  active_plus_recent_paused: "Active + paused",
  all: "All",
};

const RECENT_PAUSED_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Statuses that put an entity in the archive rather than the briefing.
 *
 * UNKNOWN is deliberately NOT one of them. `normalizeBriefingStatus` returns it
 * for a null column, so listing it here made "we did not capture a status" mean
 * the same thing as "the operator archived this" — and the two are opposites.
 *
 * On a real account that hid the money: five campaigns carried $34,612 of a
 * $36,451 window while `meta_campaign_daily.campaign_status` was null for every
 * one of their rows (the system knew they were ACTIVE — `meta_entity_state_history`
 * said so — the daily table just never carried it). The active filter dropped
 * all five, and the Decision Center reported ROAS 0.00 and $0 spend for an
 * account spending well over a thousand dollars a day.
 */
const ARCHIVE_ONLY_STATUSES = new Set(["PAUSED", "ARCHIVED", "DELETED"]);

export interface BriefingStatusEntity {
  status?: string | null;
  effectiveStatus?: string | null;
  effective_status?: string | null;
  statusChangedAt?: string | Date | null;
  status_changed_at?: string | Date | null;
  statusUpdatedAt?: string | Date | null;
  status_updated_at?: string | Date | null;
  effectiveStatusUpdatedAt?: string | Date | null;
  effective_status_updated_at?: string | Date | null;
  updatedTime?: string | Date | null;
  updated_time?: string | Date | null;
  updatedAt?: string | Date | null;
  updated_at?: string | Date | null;
}

export function parseBriefingStatusFilter(value: string | null | undefined): BriefingStatusFilter {
  return BRIEFING_STATUS_FILTERS.includes(value as BriefingStatusFilter)
    ? (value as BriefingStatusFilter)
    : "active";
}

export function normalizeBriefingStatus(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return normalized || "UNKNOWN";
}

function statusTimestamp(entity: BriefingStatusEntity) {
  return (
    entity.statusChangedAt ??
    entity.status_changed_at ??
    entity.statusUpdatedAt ??
    entity.status_updated_at ??
    entity.effectiveStatusUpdatedAt ??
    entity.effective_status_updated_at ??
    entity.updatedTime ??
    entity.updated_time ??
    entity.updatedAt ??
    entity.updated_at ??
    null
  );
}

export function hoursSinceStatusChange(entity: BriefingStatusEntity, now = new Date()) {
  const value = statusTimestamp(entity);
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now.getTime() - parsed) / 3_600_000);
}

export function briefingStatusForEntity(entity: BriefingStatusEntity) {
  return normalizeBriefingStatus(entity.effectiveStatus ?? entity.effective_status ?? entity.status);
}

export function isRecentlyPaused(entity: BriefingStatusEntity, now = new Date()) {
  if (briefingStatusForEntity(entity) !== "PAUSED") return false;
  const hours = hoursSinceStatusChange(entity, now);
  return hours != null && hours * 3_600_000 <= RECENT_PAUSED_WINDOW_MS;
}

export function isInBriefing(
  entity: BriefingStatusEntity,
  filter: BriefingStatusFilter = "active",
  now = new Date(),
) {
  const status = briefingStatusForEntity(entity);
  if (filter === "all") return true;
  if (status === "ACTIVE") return true;
  // An unknown status is not a pause. This filter exists to hide what the
  // operator turned off, so it may only exclude what it knows is off; treating
  // a missing column as "off" removed spending entities from every rollup and
  // left the surface reporting zeros for an account that was spending.
  if (status === "UNKNOWN") return true;
  return filter === "active_plus_recent_paused" && isRecentlyPaused(entity, now);
}

export function isWithIssuesEntity(entity: BriefingStatusEntity) {
  return briefingStatusForEntity(entity) === "WITH_ISSUES";
}

export function isArchiveOnlyEntity(
  entity: BriefingStatusEntity,
  filter: BriefingStatusFilter = "active",
  now = new Date(),
) {
  const status = briefingStatusForEntity(entity);
  if (status === "WITH_ISSUES") return false;
  if (filter === "all") return false;
  if (status === "PAUSED" && filter === "active_plus_recent_paused" && isRecentlyPaused(entity, now)) {
    return false;
  }
  return ARCHIVE_ONLY_STATUSES.has(status) || !isInBriefing(entity, filter, now);
}

export function briefingStatusLabel(entity: BriefingStatusEntity, now = new Date()) {
  const status = briefingStatusForEntity(entity);
  if (status === "PAUSED") {
    const hours = hoursSinceStatusChange(entity, now);
    if (hours == null) return "Paused";
    if (hours < 24) return `Paused ${Math.max(1, Math.round(hours))}h`;
    return `Paused ${Math.round(hours / 24)}d`;
  }
  return status
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
