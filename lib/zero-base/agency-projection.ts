/**
 * The safe Agency projection.
 *
 * Agency Desk exists to let someone with several clients find the right one.
 * It does *not* exist to rank them by urgency, because the only honest ranking
 * would need cross-client money, and cross-client money is exactly what cannot
 * be trusted here: currencies differ, freshness differs, and a blended total
 * is a number nobody should act on.
 *
 * So the projection is a **key allowlist**, enforced at runtime rather than
 * only in the type. Spend, revenue, ROAS, severity, anomaly counts and pending
 * work are not "omitted for now" — they are forbidden, and a contract test
 * fails if any of them appears anywhere in the response, at any depth.
 *
 * Ordering is alphabetical by normalised name, then by id. Alphabetical is not
 * a fallback for a ranking we have not built; it is the correct answer, because
 * any other order implies a judgement the data cannot support.
 */

/** Every key a zero-base Agency row may carry. Anything else is a defect. */
export const AGENCY_ROW_KEYS = [
  "businessId",
  "name",
  "role",
  "membershipStatus",
  "metaConnectionStatus",
  "selectedMetaAccountCount",
  "configuredCurrency",
  "sourceUpdatedAt",
  "href",
] as const;

export type AgencyRowKey = (typeof AGENCY_ROW_KEYS)[number];

/**
 * Keys that must never appear. Listed explicitly so the guard names what it is
 * protecting against rather than allow-listing by accident.
 */
export const FORBIDDEN_AGENCY_KEYS = [
  "spend", "revenue", "purchases", "roas", "cpa", "budget", "amount",
  "severity", "anomaly", "risk", "urgency", "score", "rank", "priority",
  "workCount", "pendingCount", "issues", "alerts", "health",
] as const;

// Note: bare "total" is deliberately absent. `totalCount` is a row count and
// is required by the collection envelope, while every monetary total is
// already caught by its own term — `totalSpend` matches "spend",
// `totalRevenue` matches "revenue". Banning the word itself would forbid
// honest pagination to catch nothing extra.

export interface AgencyClientRow {
  businessId: string;
  name: string;
  role: string;
  membershipStatus: "active" | "invited" | "pending";
  /** Meta connection state read from the provider connection, never inferred from activity. */
  metaConnectionStatus?: "connected" | "not_connected";
  /** Count of currently selected Meta account bindings. */
  selectedMetaAccountCount?: number;
  /** Configured, never presented as observed. */
  configuredCurrency: string | null;
  /** Last time this client's sources changed — activity, not health. */
  sourceUpdatedAt: string | null;
  href: string;
}

export interface AgencyDirectoryPage {
  items: AgencyClientRow[];
  servedCount: number;
  totalCount: number;
  nextCursor: string | null;
  truncated: boolean;
  disclosure: string | null;
}

export const AGENCY_PAGE_SIZE = 50;

/** Case- and accent-insensitive, so "Ácme" sorts with "Acme". */
export function normalizeBusinessName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** Alphabetical by normalised name, then id — total, so paging is stable. */
export function compareAgencyRows(a: AgencyClientRow, b: AgencyClientRow): number {
  const byName = normalizeBusinessName(a.name).localeCompare(normalizeBusinessName(b.name));
  if (byName !== 0) return byName;
  return a.businessId.localeCompare(b.businessId);
}

export interface AgencySourceBusiness {
  id: string;
  name: string;
  role: string;
  membershipStatus: "active" | "invited" | "pending";
  metaConnectionStatus?: "connected" | "not_connected";
  selectedMetaAccountCount?: number;
  currency?: string | null;
  sourceUpdatedAt?: string | null;
}

/**
 * Builds one page. Takes already-authorized businesses — this function does no
 * I/O and never fans out per client, which is the other thing the design
 * forbids: fifty parallel per-client reads to render a directory.
 */
export function buildAgencyDirectoryPage(
  businesses: readonly AgencySourceBusiness[],
  options: { cursor?: string | null; pageSize?: number; query?: string | null } = {},
): AgencyDirectoryPage {
  const pageSize = options.pageSize ?? AGENCY_PAGE_SIZE;

  const rows: AgencyClientRow[] = businesses.map((business) => ({
    businessId: business.id,
    name: business.name,
    role: business.role,
    membershipStatus: business.membershipStatus,
    metaConnectionStatus: business.metaConnectionStatus ?? "not_connected",
    selectedMetaAccountCount: Math.max(0, business.selectedMetaAccountCount ?? 0),
    configuredCurrency: business.currency ?? null,
    sourceUpdatedAt: business.sourceUpdatedAt ?? null,
    href: `/c/${business.id}/home`,
  }));

  rows.sort(compareAgencyRows);

  // Search filters the served page only; it is a find-as-you-scan aid, not a
  // second query, so it cannot surface a client the page would not contain.
  const query = options.query?.trim().toLowerCase();
  const filtered = query
    ? rows.filter((row) => normalizeBusinessName(row.name).includes(normalizeBusinessName(query)))
    : rows;

  const startIndex = options.cursor
    ? filtered.findIndex((row) => row.businessId === options.cursor) + 1
    : 0;
  const page = filtered.slice(startIndex, startIndex + pageSize);
  const nextCursor =
    startIndex + pageSize < filtered.length ? (page[page.length - 1]?.businessId ?? null) : null;

  return {
    items: page,
    servedCount: page.length,
    totalCount: filtered.length,
    nextCursor,
    truncated: nextCursor !== null,
    disclosure:
      nextCursor !== null ? `Showing ${page.length} of ${filtered.length} clients.` : null,
  };
}

/**
 * Recursively finds forbidden keys. Recursive because a nested object is
 * exactly how a forbidden field survives a shallow review.
 */
export function findForbiddenAgencyKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenAgencyKeys(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];

  const found: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const lowered = key.toLowerCase();
    if (FORBIDDEN_AGENCY_KEYS.some((forbidden) => lowered.includes(forbidden.toLowerCase()))) {
      found.push(here);
    }
    found.push(...findForbiddenAgencyKeys(nested, here));
  }
  return found;
}

/** Copy the design fixes, so the label cannot drift into a health claim. */
export const AGENCY_CURRENCY_NOTE =
  "Currency shown is the configured setting, not an observed provider value.";
export const AGENCY_ACTIVITY_NOTE =
  "Last source update is activity, not a health signal.";
export const AGENCY_EMPTY_DIRECTORY =
  "No clients yet. A business appears here once you are an active member of it.";
export const AGENCY_MEMBERSHIP_REVOKED =
  "Your membership of this client was revoked, so it is no longer listed.";
