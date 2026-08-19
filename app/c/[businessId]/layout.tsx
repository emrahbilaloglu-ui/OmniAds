import { notFound, redirect } from "next/navigation";

import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { listUserBusinesses } from "@/lib/access";
import {
  isZeroBaseUiEnabledForBusiness,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";
import { UnifiedDashboardClientShell } from "@/components/dashboard-v2/unified-client-shell";
import { readProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * Canonical client scope.
 *
 * `businessId` arrives in the URL, so it is authorized through the WP-03
 * resolver before anything renders — never trusted because it is in the path.
 * Each refusal maps to what the browser is allowed to learn: not-found hides
 * whether the business exists at all, so probing IDs reveals nothing.
 *
 * With rollout off these routes do not exist. That is the WP-06 rollback:
 * nothing here can affect the legacy dashboard, because nothing here renders.
 */
export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const rollout = readZeroBaseRolloutConfig();
  if (!isZeroBaseUiEnabledForBusiness(rollout, businessId)) notFound();

  const result = await requireBusinessPageContext({ businessId });
  if (result.kind === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(`/c/${businessId}/home`)}`);
  }
  // Forbidden and not-found both render not-found: telling a member of another
  // tenant that this business exists is itself a leak.
  if (result.kind !== "ok") notFound();

  const [businesses, metaAccounts, googleAccounts] = await Promise.all([
    listUserBusinesses(result.context.session.user.id),
    readProviderScopeCatalog(businessId, "meta"),
    readProviderScopeCatalog(businessId, "google"),
  ]);
  const business = businesses.find((item) => item.id === businessId) ?? null;

  const envelope: WorkspaceContextEnvelope = {
    actor: {
      userId: result.context.session.user.id,
      name: result.context.session.user.name,
      language: result.context.session.user.language,
      membershipRole: result.context.role,
      reviewerReadOnly: result.context.reviewerReadOnly,
      demo: result.context.demo,
    },
    mode: "client",
    business: business
      ? {
          id: business.id,
          name: business.name,
          configuredCurrency: business.currency ?? null,
          businessTimezone: business.timezone ?? null,
        }
      : {
          id: businessId,
          // The business is authorized but its record could not be read. This
          // fell back to `name: businessId`, which printed a raw UUID in the
          // workspace switcher as if it were the workspace's name. A name we
          // do not have is null; presentation says so.
          name: null,
          configuredCurrency: null,
          businessTimezone: null,
        },
    provider: null,
    evidence: {
      windowLabel: null,
      snapshotAt: null,
      sourceUpdatedAt: null,
      // No snapshot yet ⇒ unknown, never "fresh" by omission.
      freshness: "unknown",
    },
    proof: {
      // A configured currency is not a proven one; the read models that can
      // prove it fill this in from observed provider data (WP-11+).
      currency: business?.currency ? "configured-only" : "unknown",
      timezone: business?.timezone ? "unknown" : "missing",
    },
    rollout: {
      zeroBaseEnabled: true,
      mutationUiEnabled: rollout.mutationUiEnabled,
    },
  };

  return (
    <UnifiedDashboardClientShell
      envelope={envelope}
      providerCatalogs={[metaAccounts, googleAccounts]}
    >
      {children}
    </UnifiedDashboardClientShell>
  );
}
