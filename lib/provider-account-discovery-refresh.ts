import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  forceProviderAccountSnapshotRefresh,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";
import type { ProviderDiscoveryPayload, ProviderDiscoveryRow } from "@/lib/provider-account-discovery";

function mergeAssignments(
  accounts: ProviderAccountSnapshotItem[],
  assignedIds: string[],
): ProviderDiscoveryRow[] {
  const assignedSet = new Set(assignedIds);
  const seenAccountIds = new Set(accounts.map((account) => account.id));
  return [
    ...accounts.map((account) => ({
      ...account,
      assigned: assignedSet.has(account.id),
    })),
    ...assignedIds
      .filter((accountId) => !seenAccountIds.has(accountId))
      .map((accountId) => ({
        id: accountId,
        name: accountId,
        assigned: true,
      })),
  ];
}

export async function refreshProviderDiscoveryPayload(input: {
  businessId: string;
  provider: "meta" | "google";
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  freshnessMs?: number;
  reason?: string;
}): Promise<ProviderDiscoveryPayload> {
  const assignmentRow = await getProviderAccountAssignments(input.businessId, input.provider).catch(
    () => null,
  );
  const refreshed = await forceProviderAccountSnapshotRefresh({
    businessId: input.businessId,
    provider: input.provider,
    liveLoader: input.liveLoader,
    freshnessMs: input.freshnessMs,
    reason: input.reason ?? "assignment_drawer_manual_refresh",
  });

  return {
    data: mergeAssignments(refreshed.accounts, assignmentRow?.account_ids ?? []),
    meta: refreshed.meta,
    notice: null,
  };
}
