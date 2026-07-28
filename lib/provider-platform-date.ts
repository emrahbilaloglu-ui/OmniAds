import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";

export type ProviderPlatformDateProvider = "meta" | "google";

export interface ProviderPlatformBoundary {
  provider: ProviderPlatformDateProvider;
  businessId: string;
  providerAccountId: string | null;
  timeZone: string;
  /**
   * Whether `timeZone` came from the account snapshot or is the "UTC" default.
   *
   * Without this the two are indistinguishable, and a finality decision for a
   * Los Angeles account whose snapshot row is missing would settle its day
   * seven hours early. Any caller reasoning about day CLOSURE must refuse on
   * "default"; callers that only need a display date may proceed.
   */
  timeZoneSource: "account" | "default";
  currentDate: string;
  previousDate: string;
  isPrimary: boolean;
}

function resolveDatePartsInTimeZone(timeZone: string, referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function getTodayIsoForTimeZoneServer(timeZone: string, referenceDate = new Date()) {
  return resolveDatePartsInTimeZone(timeZone, referenceDate);
}

export function addDaysToIsoDateUtc(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function getProviderPlatformDateBoundaries(input: {
  provider: ProviderPlatformDateProvider;
  businessId: string;
  providerAccountIds?: string[] | null;
  snapshot?: Awaited<ReturnType<typeof readProviderAccountSnapshot>> | null;
}) {
  const [assignment, snapshot] = await Promise.all([
    input.providerAccountIds
      ? Promise.resolve({ account_ids: input.providerAccountIds })
      : getProviderAccountAssignments(input.businessId, input.provider).catch(() => null),
    input.snapshot
      ? Promise.resolve(input.snapshot)
      : readProviderAccountSnapshot({
          businessId: input.businessId,
          provider: input.provider,
        }).catch(() => null),
  ]);

  const accountIds = assignment?.account_ids ?? [];
  if (accountIds.length === 0) {
    return [] satisfies ProviderPlatformBoundary[];
  }

  return accountIds.map((providerAccountId, index) => {
    const snapshotTimeZone = snapshot?.accounts.find(
      (account) => account.id === providerAccountId,
    )?.timezone;
    // An unusable zone is treated as unknown rather than allowed to throw out
    // of the map: every caller of this function swallows a rejection into the
    // server's UTC date, which is the same silent substitution in a worse
    // disguise.
    let timeZone = "UTC";
    let timeZoneSource: "account" | "default" = "default";
    if (snapshotTimeZone && snapshotTimeZone.trim().length > 0) {
      try {
        getTodayIsoForTimeZoneServer(snapshotTimeZone);
        timeZone = snapshotTimeZone;
        timeZoneSource = "account";
      } catch {
        timeZone = "UTC";
        timeZoneSource = "default";
      }
    }
    const currentDate = getTodayIsoForTimeZoneServer(timeZone);
    return {
      provider: input.provider,
      businessId: input.businessId,
      providerAccountId,
      timeZone,
      timeZoneSource,
      currentDate,
      previousDate: addDaysToIsoDateUtc(currentDate, -1),
      isPrimary: index === 0,
    } satisfies ProviderPlatformBoundary;
  });
}

export async function getProviderPlatformCurrentDate(input: {
  provider: ProviderPlatformDateProvider;
  businessId: string;
  providerAccountId?: string | null;
  providerAccountIds?: string[] | null;
  snapshot?: Awaited<ReturnType<typeof readProviderAccountSnapshot>> | null;
}) {
  const boundaries = await getProviderPlatformDateBoundaries({
    provider: input.provider,
    businessId: input.businessId,
    providerAccountIds: input.providerAccountIds ?? undefined,
    snapshot: input.snapshot,
  });
  const match =
    boundaries.find((boundary) => boundary.providerAccountId === (input.providerAccountId ?? null)) ??
    boundaries[0] ??
    null;
  return match?.currentDate ?? new Date().toISOString().slice(0, 10);
}

export async function getProviderPlatformPreviousDate(input: {
  provider: ProviderPlatformDateProvider;
  businessId: string;
  providerAccountId?: string | null;
  providerAccountIds?: string[] | null;
  snapshot?: Awaited<ReturnType<typeof readProviderAccountSnapshot>> | null;
}) {
  const boundaries = await getProviderPlatformDateBoundaries({
    provider: input.provider,
    businessId: input.businessId,
    providerAccountIds: input.providerAccountIds ?? undefined,
    snapshot: input.snapshot,
  });
  const match =
    boundaries.find((boundary) => boundary.providerAccountId === (input.providerAccountId ?? null)) ??
    boundaries[0] ??
    null;
  return match?.previousDate ?? addDaysToIsoDateUtc(new Date().toISOString().slice(0, 10), -1);
}
