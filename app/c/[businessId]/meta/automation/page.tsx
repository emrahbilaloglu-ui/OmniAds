import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { AutomationView } from "@/components/zero-base/meta/automation/automation-view";
import { buildProviderPostures } from "@/lib/zero-base/meta/automation-posture";

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

  const control = await getMetaAutomationControlPlane({ businessId }).catch(() => null);

  return (
    <AutomationView
      postures={buildProviderPostures({
        meta: control
          ? { state: "serving", reason: null }
          : { state: "unavailable", reason: "The automation control plane could not be read." },
      })}
      guardrails={
        (control?.businessControl?.guardrails ?? {}) as unknown as Record<string, unknown>
      }
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
