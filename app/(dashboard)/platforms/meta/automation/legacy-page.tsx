// Next.js App Router page files may only export `default` plus reserved page
// exports. The automation surface additionally exports `MetaAutomationView`
// (rendered directly in tests), so the implementation lives in
// ./automation-view.
//
// D078: this body is a thin SERVER component rather than a bare re-export.
// The D077 state-history recovery readiness is server-owned display-only
// evidence; the zero-base route (`app/c/[businessId]/meta/automation`) read it
// but this canonical route mounted the view with the default `null`, so the
// recovery section rendered "Readiness read unavailable" forever in the
// zero-base-off posture that production actually serves. The read is
// access-gated exactly like the zero-base page and fails closed: no
// businessId, no session, denied access, or a throwing read all pass `null`,
// which the section renders as visibly unavailable — never as ready.
//
// PRE-DEPLOY AUDIT — the viewer envelope, established for real.
//
// This body never supplied `viewer` to `AutomationView` at all, so every
// render defaulted to `AUTOMATION_VIEWER_NOT_ESTABLISHED` (`role: null`).
// `buildBudgetMasterSwitchAuthorization` used to read that as "no server
// fact, let the routes decide" and granted the master-switch controls in
// full — meaning every visitor to this route, whatever their real role
// (collaborator, reviewer, a demo workspace, an unverified one, or no
// membership at all), saw Enable / Disable / Save-preparation exactly as an
// admin would. `buildBudgetMasterSwitchAuthorization` itself is fixed to
// refuse an unestablished viewer (see viewer-envelope.ts); this is the other
// half — establishing a REAL viewer here, from the same canonical sources
// the zero-base route (`app/c/[businessId]/meta/automation/page.tsx`) already
// uses, so a genuine admin on this route is not collaterally locked out by
// that fix.
//
// `businessId` and `providerAccountId` are handed to `AutomationView` ONLY
// TOGETHER, and ONLY when access actually succeeded. The component
// distinguishes "the server authorized this scope" from "the client should
// resolve its own" by whether `providerAccountId` is `undefined` versus an
// explicit value (including `null` for "authorized, resolved to none") —
// passing `providerAccountId: null` while `businessId` stays client-resolved
// would wrongly lock the account scope to "none" for whatever business the
// client-side store later selects. On any failure (no businessId, denied
// access, or a throwing read) both stay `undefined`, which is exactly the
// pre-existing behaviour: the client falls back to its own store-selected
// business and its own full account resolution, same as before this file
// established anything. `viewer` also stays `undefined` on failure, which
// `AutomationView` defaults to `AUTOMATION_VIEWER_NOT_ESTABLISHED` — now
// itself fail-closed for every mutation this surface gates on a role.
import AutomationView from "./automation-view";
import { buildAutomationViewerEnvelope } from "./viewer-envelope";
import type { AutomationViewerEnvelope } from "./viewer-envelope";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { getDb } from "@/lib/db";
import { readStateHistoryCompactionReadiness } from "@/lib/meta/state-history-compaction-readiness";
import { readBudgetWriteSurfaceReadiness } from "@/lib/meta/budget-write-readiness-server";
import { readMetaGateRefusal } from "@/lib/meta/release-gate-guard";
import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import type { StateHistoryCompactionReadiness } from "@/lib/meta/state-history-compaction-readiness";

interface LegacyAutomationPageProps {
  params?: Promise<Record<string, string | string[] | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

export default async function LegacyMetaAutomationPage(
  props: LegacyAutomationPageProps,
) {
  const raw = (await props.searchParams) ?? {};
  const businessId = firstValue(raw.businessId);

  // Server-AUTHORIZED scope, passed to `AutomationView` only together and
  // only on success — see the file header for exactly why `undefined` (not
  // `null`) is the correct failure value for both.
  let authorizedBusinessId: string | undefined;
  let authorizedProviderAccountId: string | null | undefined;
  let viewer: AutomationViewerEnvelope | undefined;
  let stateHistoryReadiness: StateHistoryCompactionReadiness | null = null;
  /*
    D088 C3: the budget write-readiness model, which carries the exact-account
    activation state. Both automation bodies mounted the section with `null`,
    so the activation ceremony and the account it is bound to were invisible on
    the route production actually serves.
  */
  let budgetWriteReadiness: BudgetWriteReadinessModel | null = null;

  if (businessId) {
    const access = await requireBusinessPageContext({ businessId }).catch(
      () => null,
    );
    if (access?.kind === "ok") {
      /*
        Assignment-scoped, never the raw query parameter. A business with one
        assigned account resolves to it regardless of what a caller passed;
        one with several requires the explicit choice `resolveProviderAccountId`
        already enforces; one with none resolves to `null`, and every read
        below stays scoped to that `null` rather than silently widening.
      */
      const providerAccountId = await resolveProviderAccountId({
        businessId,
        provider: "meta",
        requestedAccountId: firstValue(raw.providerAccountId),
      }).catch(() => null);

      /*
        The demo flag is read from the table, same as the zero-base route —
        never inferred from the well-known id alone, which would miss a
        workspace flagged `is_demo_business`. An unreadable flag fails closed
        to `unverified`, never to `live`.
      */
      const writeAuthority = await readLaunchpadWriteAuthority(businessId);

      authorizedBusinessId = businessId;
      authorizedProviderAccountId = providerAccountId;
      viewer = buildAutomationViewerEnvelope({
        role: access.context.role,
        reviewerReadOnly: access.context.reviewerReadOnly,
        writeAuthority,
      });

      stateHistoryReadiness = await readStateHistoryCompactionReadiness(
        getDb(),
        { businessId },
      ).catch(() => null);
      budgetWriteReadiness = await readBudgetWriteSurfaceReadiness({
        businessId,
        providerAccountId,
      }).catch(() => null);
    }
    // access failed (unauthenticated / not-found / forbidden / unavailable,
    // or the read itself threw): every `authorized*` variable and `viewer`
    // stay `undefined`, and readiness stays `null` — the fail-closed default
    // this block never needs to special-case.
  }

  return (
    <AutomationView
      businessId={authorizedBusinessId}
      providerAccountId={authorizedProviderAccountId}
      viewer={viewer}
      stateHistoryReadiness={stateHistoryReadiness}
      budgetWriteReadiness={budgetWriteReadiness}
      /*
       * The same answer the route would give, so a refusal is visible before
       * the click. Both reads are pure environment/config lookups — no
       * database, no business scope — so they run unconditionally, exactly as
       * the zero-base route already does.
       */
      stopEngageRefusalReason={readMetaGateRefusal("automationStopUi")?.message ?? null}
      liveWritesRefusalReason={
        readMetaGateRefusal("automationLiveWrites")?.message ?? null
      }
    />
  );
}
