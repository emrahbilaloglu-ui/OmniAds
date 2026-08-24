import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

// Keep the canonical workspace independently styled. Production can serve an
// app-router recovery document while a dynamic layout redirects or streams;
// relying only on the root entry's CSS then leaves the authenticated workspace
// as unstyled HTML. The route-owned entry keeps /app/** independently styled.
import "./workspace.css";

import { listUserBusinesses } from "@/lib/access";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import { UnifiedDashboardClientShell } from "@/components/dashboard-v2/unified-client-shell";
import { readProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import { readMetaGateRefusal } from "@/lib/meta/release-gate-guard";
import {
  isZeroBaseUiEnabledForBusiness,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Adsecute",
  description: "Multi-platform ad management dashboard",
};

/**
 * Session-scoped application shell.
 *
 * The active business is authorised on every request but is deliberately not
 * part of the public URL. Business switching changes the authenticated
 * session, then returns to the same human-readable `/app/**` surface.
 * The imported route module supplies the page body only; layouts from the
 * `/c/[businessId]` route tree are not inherited across this route boundary.
 * This is therefore the one canonical shell for the readable `/app/**` URLs.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies();
  // The catch-all page owns the unauthenticated redirect. Keeping the layout
  // renderable without a session matters because Next can stream a parent
  // layout while producing a redirect/recovery document for another route.
  // Throwing here leaked the workspace redirect into public documents such as
  // /login in the production standalone runtime and created a self-redirect.
  if (!session) return children;
  if (!session.activeBusinessId) {
    redirect(`/select-business?next=${encodeURIComponent("/app/home")}`);
  }

  const businessId = session.activeBusinessId;
  const access = await requireBusinessPageContext({ businessId });
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/app/home")}`);
  if (access.kind !== "ok") notFound();

  const [businesses, metaAccounts, googleAccounts] = await Promise.all([
    listUserBusinesses(access.context.session.user.id),
    readProviderScopeCatalog(businessId, "meta"),
    readProviderScopeCatalog(businessId, "google"),
  ]);
  const business = businesses.find((item) => item.id === businessId) ?? null;
  const rollout = readZeroBaseRolloutConfig();

  const envelope: WorkspaceContextEnvelope = {
    actor: {
      userId: access.context.session.user.id,
      name: access.context.session.user.name,
      language: access.context.session.user.language,
      membershipRole: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
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
      freshness: "unknown",
    },
    proof: {
      currency: business?.currency ? "configured-only" : "unknown",
      timezone: business?.timezone ? "unknown" : "missing",
    },
    rollout: {
      /**
       * Read, not asserted.
       *
       * This was the literal `true`, so the envelope reported the canonical UI
       * as enabled on `/app/**` whatever `ZERO_BASE_UI_MODE` actually said —
       * including `off`, which is the rollback lever. A flag whose value the
       * shell overrides is not a rollback; anything reading this field for a
       * rollback decision was reading a constant.
       *
       * `/c/**` gates access on the same predicate and 404s when it is false,
       * so there `true` was at least provable. Here nothing gated it, which is
       * exactly why it had to be computed rather than assumed.
       */
      zeroBaseEnabled: isZeroBaseUiEnabledForBusiness(rollout, businessId),
      mutationUiEnabled: rollout.mutationUiEnabled,
    },
  };

  return (
    <UnifiedDashboardClientShell
      envelope={envelope}
      /*
       * The gate is read here, on the server, and only its sentence crosses to
       * the client. `META_ACCOUNT_PICKER` governs the operator's ability to
       * MOVE scope; resolution runs regardless and still fails closed.
       */
      accountChangeRefusalReason={readMetaGateRefusal("accountPicker")?.message ?? null}
      providerCatalogs={[metaAccounts, googleAccounts]}
    >
      {children}
    </UnifiedDashboardClientShell>
  );
}
