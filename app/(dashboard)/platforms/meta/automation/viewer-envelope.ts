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
