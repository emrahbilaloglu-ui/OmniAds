/**
 * Request-time demo write authority for the Automation write boundary.
 *
 * The canonical invariant is unconditional:
 *
 *   "Demo decisions ... must use demo_synthetic_review_only, null authorized
 *    action, false action eligibility, and false exact-Ad execution
 *    eligibility. Demo businesses have zero Meta write authority even if a
 *    presentation defect supplies an action."
 *
 * Automation honoured that for PROVIDER writes only, and only on one of its two
 * routes. `getMetaWriteBlockState` does refuse a demo business
 * (lib/meta/automation-control-plane.ts: `reason: "demo_business_read_only"`),
 * but it is consulted from exactly one place —
 * `app/api/meta/automation/proposals/route.ts`, inside `approve()`. Everything
 * else a demo session can POST went straight through:
 *
 *   - `POST /api/meta/automation` with engage/release_kill_switch,
 *     set_decision_type_mode, set_guardrail_policy, create_rule,
 *     set_rule_active, evaluate_rules — persisted control, guardrail, rule and
 *     proposal rows, none of them behind a write-block read.
 *   - `POST /api/meta/automation/proposals` with modify or dismiss — the
 *     `decideWithoutProviderWrite` path settles a proposal row and writes an
 *     activity-ledger row without ever calling `rejectIfMetaWritesBlocked`.
 *
 * "It reaches no provider" is not the test. A demo workspace has zero write
 * authority of any kind, and a rule, a guardrail floor, a quiet-hours window or
 * a settled proposal is durable state that the next real snapshot reads back.
 * The role check does not catch this either: `/api/auth/demo-login` opens a
 * session as an ADMIN of the demo business under a non-reviewer email, so it
 * clears both `requireBusinessAccess({ minRole: "admin" })` and
 * `rejectIfReviewerReadOnly`.
 *
 * `engage_kill_switch` is refused with the rest, and that is deliberate rather
 * than an oversight about STOP controls. Refusing a STOP would be fail-open
 * only if the STOP were doing something; for a demo business
 * `getMetaWriteBlockState` already returns blocked with reason
 * `demo_business_read_only` BEFORE it ever looks at `kill_switch_engaged`, so
 * every Meta write is already stopped and engaging it changes nothing except to
 * persist a control row for a workspace that has no controls to persist.
 *
 * The read is the same one Launchpad gates on — imported, never re-derived. A
 * second implementation of "is this workspace demo" would be a second answer,
 * and the two would drift the first time one of them learned something. See
 * `app/api/launchpad/meta/demo-write-authority.ts` for why an unreadable flag is
 * `unverified` and refuses instead of reading as "live".
 */
import { NextResponse } from "next/server";

import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";

export const AUTOMATION_DEMO_WRITE_REFUSAL =
  "Demo workspaces have zero Meta write authority. Automation changes are unavailable here.";

export const AUTOMATION_UNVERIFIED_WRITE_REFUSAL =
  "This workspace could not be confirmed as a live (non-demo) workspace, so Automation changes are held.";

/**
 * The refusal every state-changing Automation request issues before it writes
 * anything — control state, guardrail policy, a rule, a proposal settlement or
 * an activity-ledger row. Returns `null` only for a proven live workspace.
 *
 * The two codes are spelled exactly as Launchpad spells them and exactly as the
 * Automation viewer envelope restates them
 * (`app/(dashboard)/platforms/meta/automation/viewer-envelope.ts`), so the
 * disabled control on screen and the 403/503 from the route can never name
 * different reasons for the same refusal.
 */
export async function rejectIfAutomationDemoWrite(
  businessId: string,
  action: string,
): Promise<NextResponse | null> {
  const authority = await readLaunchpadWriteAuthority(businessId);
  if (authority === "demo") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "demo_business_read_only",
          message: AUTOMATION_DEMO_WRITE_REFUSAL,
          action,
        },
      },
      { status: 403 },
    );
  }
  if (authority !== "live") {
    // `unverified` and `not_established` both land here. Neither is proof of a
    // live workspace, and a write must not proceed on an unproven claim that
    // this workspace is real — a database outage must never read as authority.
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "demo_status_unverified",
          message: AUTOMATION_UNVERIFIED_WRITE_REFUSAL,
          action,
        },
      },
      { status: 503 },
    );
  }
  return null;
}
