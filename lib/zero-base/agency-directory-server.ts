import "server-only";

/**
 * Server read for the Agency directory.
 *
 * Two queries total, regardless of client count: the membership list the
 * session already needs, and one batched `readAgencyTodayTotals` over every
 * business id at once. That store is adopted rather than replaced — the legacy
 * Agency projection keeps using it unchanged until WP-27.
 *
 * It returns spend, revenue and purchases alongside the timestamp. Those are
 * read and immediately discarded here: `AgencySourceBusiness` has no field to
 * put them in, so a money value cannot reach the projection even by accident,
 * and the response guard re-checks at runtime.
 */
import { listUserBusinesses } from "@/lib/access";
import { scopeBusinessesForUser } from "@/lib/reviewer-access";
import { readAgencyTodayTotals } from "@/lib/agency-today-store";
import type { AgencySourceBusiness } from "@/lib/zero-base/agency-projection";

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function readAgencyDirectorySource(input: {
  userId: string;
  email: string;
  now?: Date;
}): Promise<AgencySourceBusiness[]> {
  const now = input.now ?? new Date();
  const businesses = scopeBusinessesForUser(
    input.email,
    await listUserBusinesses(input.userId),
  );

  // Only active memberships are clients. An invited-but-unaccepted row is not
  // a client yet, and listing it would imply access the actor does not have.
  const active = businesses.filter((business) => business.membershipStatus === "active");
  if (active.length === 0) return [];

  const end = isoDate(now);
  const start = isoDate(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));

  // One query for all ids. A per-client loop here is exactly the fan-out the
  // design forbids: fifty clients would mean fifty round trips to draw a list.
  const totals = await readAgencyTodayTotals({
    businessIds: active.map((business) => business.id),
    startDate: start,
    endDate: end,
  }).catch(() => new Map());

  return active.map((business) => ({
    id: business.id,
    name: business.name,
    role: business.role,
    membershipStatus: business.membershipStatus,
    currency: business.currency ?? null,
    // The only field taken from the totals row. Spend, revenue and purchases
    // are deliberately not carried across.
    sourceUpdatedAt: totals.get(business.id)?.lastSourceUpdatedAt ?? null,
  }));
}
