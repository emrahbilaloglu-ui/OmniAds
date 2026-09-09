import { notFound, redirect } from "next/navigation";

import MetaAutomationPage from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import { buildAutomationViewerEnvelope } from "@/app/(dashboard)/platforms/meta/automation/viewer-envelope";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import {
  ensureBusinessControlRow,
  getMetaAutomationControlPlane,
} from "@/lib/meta/automation-control-plane";
import { getDb } from "@/lib/db";
import { readStateHistoryCompactionReadiness } from "@/lib/meta/state-history-compaction-readiness";
import { readBudgetWriteSurfaceReadiness } from "@/lib/meta/budget-write-readiness-server";
import { readBudgetReadiness } from "@/lib/meta/budget-readiness-read-model";
import { campaignContextAuthorityResolverVersion } from "@/lib/creative-decision-engine/campaign-context/source";
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

  // D077: server-owned, display-only recovery readiness. The helper fails
  // closed to an explicit unavailable state; a null here (unexpected throw)
  // renders as unavailable too — never as ready.
  const stateHistoryReadiness = await readStateHistoryCompactionReadiness(
    getDb(),
    { businessId },
  ).catch(() => null);

  /*
    D086: server-owned, display-only budget-readiness for the three retention
    blockers D085 r16 left open.

    ACCOUNT-SCOPED FROM THE ROUTE'S OWN RESOLUTION. The provider account is the
    one `resolveProviderAccountId` already resolved above — never a client
    parameter and never a row's self-description. A business with more than one
    assigned account resolves to exactly one here; when nothing resolves, `null`
    travels through and the read model fails closed with an explicit scope
    blocker rather than aggregating accounts into a single verdict.

    A throw yields `null`, which the section renders as unavailable — never as
    ready. `nowIso` is passed explicitly so the read model holds no clock.
  */
  const budgetReadiness = await readBudgetReadiness(getDb(), {
    businessId,
    providerAccountId,
    nowIso: new Date().toISOString(),
    /*
      THE CANONICAL RESOLVER, not raw `process.env`.

      `campaignContextAuthorityResolverVersion()` returns the approved version
      only when it equals the compiled one, so route readiness and runtime
      authority cannot drift. Reading the variable directly would have let a
      stale or arbitrary value look like an approval here while the runtime
      refused it.
    */
    approvedResolverVersion: campaignContextAuthorityResolverVersion(),
  }).catch(() => null);

  /*
    D088 C3: the budget write-readiness surface model.

    It carries the exact provider account automatic execution is enabled for,
    which the business-wide control row alone cannot express. A failed read is
    `null` and renders as unavailable.
  */
  const budgetWriteReadiness = await readBudgetWriteSurfaceReadiness({
    businessId, providerAccountId,
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

  /*
    Bootstrap the control row AFTER the viewer's authority is known, and only
    for a viewer who has some.

    Every Meta write requires a persisted control row: `getMetaWriteBlockState`
    refuses `control_state_unavailable` without one. A business that has never
    been opened here therefore cannot act at all, and the surface could not say
    why. Creating the row is not an authorization — STOP is clear but automatic
    execution is off, rehearsal is on, and no spend ceiling is claimed.

    But it IS a durable write, stamped `updated_by` with whoever triggered it.
    Running it at the top of the page meant a reviewer merely LOOKING at the
    screen, or anyone opening a demo workspace, persisted the initial control
    state under their own id — attributing it to an actor the server would
    refuse every write from. `POST /api/meta/automation` carried the same
    ordering defect and was corrected the same way
    (`control-row-bootstrap-ordering.test.ts`); this is the second site.

    THE GATE IS THE VIEWER'S OWN MUTATION AUTHORITY, not the business's
    posture. `!reviewerReadOnly && writeAuthority === "live"` asked about the
    WORKSPACE and about the reviewer flag, and never about the person:
    `requireBusinessPageContext` is called above with no `minRole`, and
    `evaluateBusinessAuthorization` defaults that to `"guest"`, so a guest
    membership is admitted here. A guest is not a reviewer and a guest's
    workspace can be perfectly live, so both halves passed and the INSERT ran —
    stamping `updated_by` with an id every Automation write refuses, since
    `POST /api/meta/automation` and `POST /api/meta/automation/proposals` each
    take a `collaborator` floor. `viewer.canMutate` is the answer the envelope
    built just above already computes for exactly this question, and it is
    false for all four refusals at once: reviewer, demo, unverified demo flag,
    and a role below `collaborator`.

    `writeAuthority === "live"` is kept alongside it rather than folded into
    it. `buildAutomationViewerEnvelope` deliberately treats the
    `"not_established"` sentinel as "no server fact to restate" rather than as
    a refusal, so `canMutate` alone would admit it; `readLaunchpadWriteAuthority`
    never returns that value, and this conjunction is what keeps the bootstrap
    closed if it ever does.

    A reviewer, a guest and a demo session therefore see a never-opened business
    as NOT CONFIGURED rather than as a configured one. Precisely: a missing row
    is a successful read that degrades to the default — `mapControlRow`
    returns `defaultBusinessControl` with `source: "default"`, completeness stays
    `complete`, and the control plane emits `business_control_not_configured`.
    It is the WRITE boundary that answers `control_state_unavailable`, as the
    paragraph above says, and an earlier draft of this sentence confused the two.

    That is the honest reading of a read-only viewer's position either way: they
    cannot act here, and they should not cause a durable write to make their own
    view more explanatory.
  */
  if (viewer.canMutate && writeAuthority === "live") {
    await ensureBusinessControlRow({
      businessId,
      userId: access.context.session.user.id,
    }).catch(() => null);
  }

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
      accountSelection={readMetaGateRefusal("accountPicker") ? "local" : "shared"}
      initialPayload={scopedControl}
      viewer={viewer}
      stateHistoryReadiness={stateHistoryReadiness}
      budgetReadiness={budgetReadiness}
      /* D088 C3: the activation state, and the account it is bound to. */
      budgetWriteReadiness={budgetWriteReadiness}
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
