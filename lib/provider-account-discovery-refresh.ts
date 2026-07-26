import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  forceProviderAccountSnapshotRefresh,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";
import {
  reconcileAssignments,
  type ProviderDiscoveryPayload,
} from "@/lib/provider-account-discovery";

export async function refreshProviderDiscoveryPayload(input: {
  businessId: string;
  provider: "meta" | "google";
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  freshnessMs?: number;
  reason?: string;
  expectedConnectionGeneration?: string | null;
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
    expectedConnectionGeneration: input.expectedConnectionGeneration,
  });

  // A manual refresh is the strongest evidence available: it just asked the
  // provider. Anything selected that the provider did not return is therefore
  // NOT accessible right now, and appending it as a row named after its own id
  // — which is what this used to do — turned a revoked or arbitrary id into
  // apparently authoritative account data.
  const reconciled = reconcileAssignments(
    input.provider,
    refreshed.accounts,
    assignmentRow?.account_ids ?? [],
  );
  return {
    data: reconciled.rows,
    meta: refreshed.meta,
    notice: null,
    invalidAssignedAccountIds: reconciled.invalidAssignedAccountIds,
  };
}
