/**
 * The one server-produced answer to "may this viewer write on Automation, and
 * if not, why".
 *
 * Copied deliberately from `app/(dashboard)/platforms/meta/launchpad/
 * viewer-envelope.ts`, which already carries a server-owned `refusalCode`
 * precisely so the client never re-derives one. The two failures that model
 * fixes are both live here too:
 *
 *  1. The surface owning a rule. Automation's controls were gated on
 *     `businessId && providerAccountId` alone, so a guest, a reviewer and a
 *     demo session all saw Approve / Modify / Dismiss / + New rule / the rule
 *     toggle rendered LIVE the moment an account resolved. The refusal existed
 *     only as a 403 that landed after the click.
 *  2. A fact nobody forwards reading as permission. The canonical route
 *     authorized the viewer and then threw the answer away: `role`,
 *     `reviewerReadOnly` and `demo` never left the server, so an absent role
 *     was indistinguishable from a collaborator's.
 *
 * Nothing here is authorization. `POST /api/meta/automation` and
 * `POST /api/meta/automation/proposals` each re-check role and reviewer posture
 * on their own authority. This exists so a refusal is visible BEFORE the click,
 * not so the refusal exists at all.
 *
 * EVERY CODE BELOW IS A ROUTE'S OWN ANSWER, INCLUDING THE DEMO ONE.
 * `reviewer_read_only` is what `rejectIfReviewerReadOnly` returns;
 * `insufficient_role` is what `requireBusinessAccess({ minRole:
 * "collaborator" })` returns; `demo_business_read_only` (403) and
 * `demo_status_unverified` (503) are what `rejectIfAutomationDemoWrite`
 * (`app/api/meta/automation/demo-write-authority.ts`) returns on both write
 * routes, enforcing the canonical invariant "Demo businesses have zero Meta
 * write authority even if a presentation defect supplies an action". Nothing
 * here is a rule the browser invented.
 */
import type { MembershipRole } from "@/lib/auth";
import type { LaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";

/**
 * Whether this workspace has any Meta write authority at all.
 *
 * Aliased from the Launchpad module rather than re-derived: it is the same
 * question about the same `businesses.is_demo_business` column, read by the
 * same fail-closed function (`readLaunchpadWriteAuthority`), and a second
 * implementation would be a second answer. The name is Launchpad's only
 * because Launchpad needed it first.
 */
export type MetaWriteAuthority = LaunchpadWriteAuthority;

export interface AutomationViewerEnvelope {
  /** `null` only when no server established it (the preserved legacy mount). */
  role: MembershipRole | null;
  reviewerReadOnly: boolean;
  demo: boolean;
  canMutate: boolean;
  /** Non-null exactly when `canMutate` is false. Shown to the operator. */
  reason: string | null;
  /**
   * The code the route that would answer actually returns, non-null exactly
   * when `canMutate` is false. The client RESTATES this and never re-derives
   * it — re-deriving is what produced "insufficient_role" on Launchpad for a
   * workspace whose demo flag merely could not be read.
   */
  reasonCode:
    | "reviewer_read_only"
    | "demo_business_read_only"
    | "demo_status_unverified"
    | "insufficient_role"
    | null;
}

/*
 * The four sentences below are the ROUTES' own sentences, character for
 * character:
 *
 *   `reviewerReadOnlyError`            lib/meta/reviewer-write-guard.ts
 *   `AUTOMATION_DEMO_WRITE_REFUSAL`    app/api/meta/automation/demo-write-authority.ts
 *   `AUTOMATION_UNVERIFIED_WRITE_REFUSAL`                     (same file)
 *
 * They are duplicated rather than imported because both of those modules pull
 * `next/server` and this one is reached from a `"use client"` component: a
 * runtime import would drag `NextResponse` into the browser bundle. The
 * duplication is the cost of the boundary, and it is deliberately literal so a
 * drift is a one-line diff rather than a paraphrase nobody notices.
 */
export const AUTOMATION_REVIEWER_REFUSAL =
  "Reviewer access is read-only; write actions are unavailable for this workspace.";

export const AUTOMATION_DEMO_REFUSAL =
  "Demo workspaces have zero Meta write authority. Automation changes are unavailable here.";

export const AUTOMATION_UNVERIFIED_REFUSAL =
  "This workspace could not be confirmed as a live (non-demo) workspace, so Automation changes are held.";

export const AUTOMATION_ROLE_REFUSAL =
  "Automation writes require collaborator access on this business.";

/**
 * Roles at or above `collaborator`, which is the floor every Automation write
 * demands: `requireBusinessAccess({ minRole: "collaborator" })` on the rule and
 * mode writes and on the proposal POST. `release_kill_switch` and
 * `set_guardrail_policy` additionally require `admin`, but this surface renders
 * neither control, so raising the floor here would refuse writes the screen can
 * actually issue.
 */
const MUTATING_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  "collaborator",
  "admin",
]);

/**
 * Order matters: the reason shown is the FIRST refusal that applies, spelled
 * the way the route that would answer spells it. A reviewer on the demo
 * workspace is told about reviewer access, because `rejectIfReviewerReadOnly`
 * is the gate they would hit first.
 */
export function buildAutomationViewerEnvelope(input: {
  role: MembershipRole | null | undefined;
  reviewerReadOnly: boolean | undefined;
  writeAuthority: MetaWriteAuthority;
}): AutomationViewerEnvelope {
  const role = input.role ?? null;
  const reviewerReadOnly = Boolean(input.reviewerReadOnly);
  const demo = input.writeAuthority === "demo";

  // `not_established` is the preserved legacy mount, which is reached without a
  // business page context and whose controls are governed entirely by the
  // routes. It is deliberately not a refusal: inventing one would remove a
  // control that mount has always shown, on no evidence at all.
  const reason = reviewerReadOnly
    ? AUTOMATION_REVIEWER_REFUSAL
    : demo
      ? AUTOMATION_DEMO_REFUSAL
      : input.writeAuthority === "unverified"
        ? AUTOMATION_UNVERIFIED_REFUSAL
        : role !== null && !MUTATING_ROLES.has(role)
          ? AUTOMATION_ROLE_REFUSAL
          : null;

  const reasonCode = reviewerReadOnly
    ? ("reviewer_read_only" as const)
    : demo
      ? ("demo_business_read_only" as const)
      : input.writeAuthority === "unverified"
        ? ("demo_status_unverified" as const)
        : role !== null && !MUTATING_ROLES.has(role)
          ? ("insufficient_role" as const)
          : null;

  return {
    role,
    reviewerReadOnly,
    demo,
    canMutate: reason === null,
    reason,
    reasonCode,
  };
}

/**
 * What the preserved legacy mount gets: nothing established, nothing claimed.
 * `canMutate` is true only in the sense of "this surface has no server fact to
 * restate"; the routes still refuse on their own authority.
 */
export const AUTOMATION_VIEWER_NOT_ESTABLISHED: AutomationViewerEnvelope =
  buildAutomationViewerEnvelope({
    role: null,
    reviewerReadOnly: false,
    writeAuthority: "not_established",
  });

/**
 * PRE-DEPLOY AUDIT — who may touch the automatic-execution MASTER switch.
 *
 * `buildAutomationViewerEnvelope` above answers for the controls this surface
 * has always shown, whose routes take a `collaborator` floor. The master
 * switch is not one of them: `set_budget_auto_execution` and
 * `set_guardrail_policy` take `admin`, and so does arming a decision type to
 * Tier 3. A collaborator who was shown an enabled button would be told "no" by
 * the server after pressing it, which is the pattern this file exists to
 * remove.
 *
 * It is also SURFACE-aware. The mobile pane declares itself read-only; it must
 * therefore carry no actionable form at all, whatever the viewer's role.
 */
export interface BudgetMasterSwitchAuthorization {
  /** May press Enable and may save the configuration. Admin only. */
  canConfigure: boolean;
  /**
   * May press Disable. Same admin floor as enabling — the route enforces one
   * `minRole` for the whole action — but deliberately NOT gated on readiness:
   * a stop that readiness could refuse is not a stop.
   */
  canDisable: boolean;
  /** The FIRST refusal that applies, spelled the way the route spells it. */
  reason: string | null;
  reasonCode:
    | "reviewer_read_only" | "demo_business_read_only" | "demo_status_unverified"
    | "insufficient_role" | "read_only_surface" | "viewer_not_established" | null;
  surface: "desktop" | "mobile_read_only";
}

export const BUDGET_MASTER_SWITCH_ADMIN_REFUSAL =
  "Changing automatic execution requires admin access on this business.";

export const BUDGET_MASTER_SWITCH_MOBILE_REFUSAL =
  "This is the read-only mobile view. Open Automation on a desktop browser to change automatic execution.";

/**
 * PRE-DEPLOY AUDIT — the render that started this correction pass. The
 * canonical `/platforms/meta/automation` route never supplied a `viewer`
 * prop at all, so this component always received `AUTOMATION_VIEWER_NOT_
 * ESTABLISHED` (`role: null`). The PREVIOUS version of the function below
 * read that as "no server fact to restate, so let the routes decide" and
 * fell all the way through to a full grant — meaning every visitor to the
 * production route, whatever their real role, saw the master-switch Enable /
 * Disable / Save-preparation controls exactly as an admin would. The route's
 * own 403 on the eventual POST is not a defense here: showing a live control
 * that the server will refuse is the precise defect this surface exists to
 * remove, and it is not undone by the request failing one step later.
 */
export const BUDGET_MASTER_SWITCH_VIEWER_UNESTABLISHED_REFUSAL =
  "This render has no verified viewer identity, so automatic execution controls stay held. Open Automation from an authorized business page.";

/**
 * PRE-DEPLOY AUDIT — an ALLOWLIST, not a denylist.
 *
 * The grant is the FIRST thing decided, from an explicit conjunction of every
 * fact required, and it is the ONLY place in this function that returns
 * `canConfigure`/`canDisable: true`. Every other path — including one this
 * function has never had to name before, `viewer.role === null` — refuses.
 * `viewer.canMutate` and `viewer.reason === null` are equivalent by
 * construction in `buildAutomationViewerEnvelope` (`canMutate: reason ===
 * null`), so checking both is redundant on purpose: if a future edit ever
 * lets that invariant drift, this still fails closed on whichever one is
 * false rather than trusting the other.
 */
export function buildBudgetMasterSwitchAuthorization(input: {
  viewer: AutomationViewerEnvelope;
  surface: "desktop" | "mobile_read_only";
}): BudgetMasterSwitchAuthorization {
  const { viewer, surface } = input;

  const grantedAdmin =
    surface === "desktop"
    && viewer.role === "admin"
    && viewer.canMutate === true
    && viewer.reason === null;

  if (grantedAdmin) {
    return {
      canConfigure: true,
      canDisable: true,
      reason: null,
      reasonCode: null,
      surface,
    };
  }

  // The read-only surface is a fact about the pane, not about the person,
  // and it cannot be argued with — checked first among the refusals so it
  // is never shadowed by a role-shaped explanation that would be misleading
  // on a pane that refuses unconditionally.
  if (surface === "mobile_read_only") {
    return {
      canConfigure: false,
      canDisable: false,
      reason: BUDGET_MASTER_SWITCH_MOBILE_REFUSAL,
      reasonCode: "read_only_surface",
      surface,
    };
  }

  // The caller's own named refusal (reviewer / demo / unverified /
  // insufficient role), restated verbatim rather than re-derived.
  if (viewer.reason !== null) {
    return {
      canConfigure: false,
      canDisable: false,
      reason: viewer.reason,
      reasonCode: viewer.reasonCode,
      surface,
    };
  }

  /*
    `viewer.role === null` is the preserved legacy mount with no server fact
    established for this render — "not established" is NOT "admin", and it
    is no longer treated as one. This is the exact case the whole correction
    pass exists to close.
  */
  if (viewer.role === null) {
    return {
      canConfigure: false,
      canDisable: false,
      reason: BUDGET_MASTER_SWITCH_VIEWER_UNESTABLISHED_REFUSAL,
      reasonCode: "viewer_not_established",
      surface,
    };
  }

  // An ESTABLISHED role below admin, or a `reason === null` viewer whose role
  // is established but not `"admin"` — either way, named and refused rather
  // than defaulted through.
  return {
    canConfigure: false,
    canDisable: false,
    reason: BUDGET_MASTER_SWITCH_ADMIN_REFUSAL,
    reasonCode: "insufficient_role",
    surface,
  };
}
