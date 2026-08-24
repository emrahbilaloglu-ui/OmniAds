import { notFound, redirect } from "next/navigation";

import MetaAutomationPage from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import { buildAutomationViewerEnvelope } from "@/app/(dashboard)/platforms/meta/automation/viewer-envelope";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { MetaSurfaceState } from "@/components/meta/MetaSurfaceState";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";
import { resolveMetaSurfaceReadState } from "@/lib/meta/surface-read-state";
import { readMetaGateRefusal } from "@/lib/meta/release-gate-guard";

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

  /**
   * The §9 envelope, from the control-plane read that already happened.
   *
   * `getMetaAutomationControlPlane` is caught to `null` above, and a null
   * control plane used to render as an Automation screen with its guardrails at
   * their defaults — which is the most dangerous shape of the D8 defect on this
   * branch, because the defaults look safe. `supervision_state_unavailable`
   * exists in §9.1 for exactly this and now reaches the screen.
   */
  const pageState = await resolveMetaPageSurfaceState({
    surfaceId: "meta-automation",
    businessId,
    requestedAccountId: first(raw.providerAccountId),
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
  });
  const readState =
    pageState.state === "refused"
      ? pageState
      : resolveMetaSurfaceReadState({
          businessId,
          providerAccountId,
          requiresProviderAccount: true,
          permissions: pageState.permissions,
          capability: {
            /*
             * `control === null` is not the failure mode.
             *
             * `getMetaAutomationControlPlane` never throws for a failed section:
             * it degrades each one to a benign-looking default and records
             * `readCompleteness`, precisely because printing "ENABLED, Tier 1,
             * +15%, 3 actions/day" from a read that did not happen is the worst
             * lie this screen can tell. So the capability question is whether
             * the BUSINESS CONTROL was read — everything on the screen that
             * looks like a safety guarantee comes from it — and the remaining
             * sections are reported as sources below.
             */
            canRead:
              control !== null &&
              control.readCompleteness?.businessControl === "complete",
            canWrite: pageState.capability.canWrite,
            readBlockedBy:
              control !== null &&
              control.readCompleteness?.businessControl === "complete"
                ? undefined
                : "supervision_state_unavailable",
          },
          sources:
            control === null
              ? []
              : [
                  {
                    id: "promotion-records",
                    outcome:
                      control.readCompleteness?.promotionRecords === "complete"
                        ? control.promotionRecords.length > 0
                          ? "served"
                          : "empty"
                        : "failed",
                    rowCount: control.promotionRecords.length,
                    failureCode:
                      control.readCompleteness?.promotionRecords === "complete"
                        ? undefined
                        : "supervision_state_unavailable",
                  },
                  {
                    id: "rules",
                    outcome:
                      control.readCompleteness?.rules === "complete"
                        ? (control.rules?.length ?? 0) > 0
                          ? "served"
                          : "empty"
                        : "failed",
                    rowCount: control.rules?.length ?? 0,
                    failureCode:
                      control.readCompleteness?.rules === "complete"
                        ? undefined
                        : "supervision_state_unavailable",
                  },
                  {
                    id: "activity-ledger",
                    // Two different truncations, and they are different states:
                    // an unread ledger is a failure, and a ledger scoped to
                    // business-only rows because no account resolved is a real
                    // subset of a successful read.
                    outcome:
                      control.readCompleteness?.activityLedger !== "complete"
                        ? "failed"
                        : scopedControl !== control
                          ? "partial"
                          : (scopedControl?.activityLedger.length ?? 0) > 0
                            ? "served"
                            : "empty",
                    rowCount: scopedControl?.activityLedger.length ?? 0,
                    failureCode:
                      control.readCompleteness?.activityLedger === "complete"
                        ? undefined
                        : "supervision_state_unavailable",
                  },
                ],
        });

  return (
    <>
    <MetaSurfaceState envelope={readState} surfaceId="meta-automation" />
    <MetaAutomationPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      initialPayload={scopedControl}
      viewer={viewer}
      /*
       * The same answer the route would give, so the refusal is visible before
       * the click. The gate holds ENGAGE only; releasing an existing stop is
       * offered at every gate setting.
       */
      stopEngageRefusalReason={readMetaGateRefusal("automationStopUi")?.message ?? null}
      /*
       * The gate half of "may an approved proposal reach Meta". The guardrail
       * half travels in the payload; the screen closes on either, exactly as
       * the proposals route does.
       */
      liveWritesRefusalReason={
        readMetaGateRefusal("automationLiveWrites")?.message ?? null
      }
    />
    </>
  );
}
