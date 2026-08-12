import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { AutomationClient } from "@/components/zero-base/meta/automation/automation-client";
import {
  buildProviderPostures,
  type GoogleConnectionRead,
} from "@/lib/zero-base/meta/automation-posture";

export const dynamic = "force-dynamic";

export default async function MetaAutomationPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/automation`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const [control, integrations, assignment] = await Promise.all([
    getMetaAutomationControlPlane({ businessId }).catch(() => null),
    // Google's own separate authority. Read, never assumed: the row must state
    // what was actually observed, and a failure here is `unknown`, not healthy.
    getIntegrationStatusByBusiness(businessId).catch((error: unknown) => ({
      failed: error instanceof Error ? error.message : "integration status is unavailable",
    })),
    getProviderAccountAssignments(businessId, "meta").catch(() => null),
  ]);

  const google: GoogleConnectionRead =
    integrations && "failed" in integrations
      ? { read: false, reason: integrations.failed }
      : { read: true, connected: Boolean(integrations?.google) };

  return (
    <AutomationClient
      businessId={businessId}
      providerAccountId={assignment?.account_ids?.length === 1 ? assignment.account_ids[0] : null}
      postures={buildProviderPostures({
        meta: control
          ? { state: "serving", reason: null }
          : {
              state: "degraded",
              reason: "The automation control plane could not be read.",
            },
        google,
      })}
      guardrails={(control?.businessControl?.guardrails ?? {}) as unknown as Record<string, unknown>}
      ceremony={{
        intent: control?.businessControl?.killSwitchEngaged ? "release" : "engage",
        viewer: {
          role: access.context.role,
          isReviewer: access.context.reviewerReadOnly,
          demo: access.context.demo,
        },
        // Null when the plane could not be read: the ceremony refuses to change
        // a state nobody has observed.
        currentlyEngaged: control ? Boolean(control.businessControl?.killSwitchEngaged) : null,
        readBack: null,
      }}
    />
  );
}
