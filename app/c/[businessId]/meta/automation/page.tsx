import { notFound, redirect } from "next/navigation";

import MetaAutomationPage from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import { buildAutomationViewerEnvelope } from "@/app/(dashboard)/platforms/meta/automation/viewer-envelope";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

export default async function MetaAutomationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/automation`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: first(raw.providerAccountId),
  });
  const control = await getMetaAutomationControlPlane({
    businessId,
    providerAccountId,
  }).catch(() => null);

  /**
   * Who is looking, and whether the server will accept a write from them.
   *
   * This route already had every fact — `requireBusinessPageContext` returns
   * the role and the reviewer posture — and threw all of it away, so the
   * surface had nothing to render and fell back to "an account resolved,
   * therefore write". A guest and a reviewer both got live Approve / Modify /
   * Dismiss / + New rule / rule-toggle controls whose only refusal was the 403
   * that arrived after the click.
   *
   * The demo flag is read from the table rather than reused from
   * `access.context.demo`, which only compares the well-known demo id and would
   * miss a workspace flagged `is_demo_business`. The read fails closed: an
   * unreadable flag is `unverified` and refuses, because a Meta pause must not
   * be offered on an unproven claim that this workspace is real.
   */
  const writeAuthority = await readLaunchpadWriteAuthority(businessId);
  const viewer = buildAutomationViewerEnvelope({
    role: access.context.role,
    reviewerReadOnly: access.context.reviewerReadOnly,
    writeAuthority,
  });

  // When several assigned accounts require an explicit choice, the business
  // control remains readable but account-owned provider action rows do not.
  // This prevents a missing selection from becoming an implicit all-account
  // activity scope while preserving real business-wide control ledger rows.
  const scopedControl =
    control && !providerAccountId
      ? {
          ...control,
          activityLedger: control.activityLedger.filter(
            (item) => item.source === "automation_ledger",
          ),
        }
      : control;

  return (
    <MetaAutomationPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      initialPayload={scopedControl}
      viewer={viewer}
    />
  );
}
