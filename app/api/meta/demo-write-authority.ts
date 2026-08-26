/**
 * Request-time demo write authority for the two operator-decision boundaries.
 *
 * The canonical invariant is unconditional:
 *
 *   "Demo decisions ... must use demo_synthetic_review_only, null authorized
 *    action, false action eligibility, and false exact-Ad execution
 *    eligibility. Demo businesses have zero Meta write authority even if a
 *    presentation defect supplies an action."
 *
 * Two POST routes on this surface persisted state for a demo workspace:
 *
 *   - `POST /api/meta/recommendations/respond` inserts a durable row into
 *     `meta_decision_responses`, which `lib/meta/outcome-accrual.ts` later
 *     reads back as evidence that an operator acted, and which
 *     `app/api/meta/lane-classify/route.ts` reads as the decision's operator
 *     state. A demo response therefore does not stay in the demo.
 *   - `POST /api/meta/snapshot/run-now` runs the recommendation engine INLINE:
 *     `requestMetaSnapshotRefreshForBusiness` starts a five-minute in-process
 *     cooldown before it does anything else, then `runMetaSnapshotForBusiness`
 *     opens a calibration transaction and upserts snapshot rows.
 *
 * Neither had a demo gate. `lib/zero-base/meta/intelligence-server.ts` said
 * both routes refuse a demo workspace, and disabled the two controls on that
 * basis — but a control disabled in the browser is not an authority boundary,
 * and `/api/auth/demo-login` opens a session as an ADMIN of the demo business
 * under a non-reviewer email, so a direct POST cleared both the role floor and
 * `rejectIfReviewerReadOnly` and wrote.
 *
 * FAIL-CLOSED. Only a proven live workspace proceeds. An unreadable demo flag
 * refuses rather than reading as "live", because a write must not proceed on an
 * unproven claim that this workspace is real — see
 * `app/api/launchpad/meta/demo-write-authority.ts` for the same decision and
 * why `lib/business-mode.server.isDemoBusiness` (which swallows its errors and
 * falls back to an id comparison) is the wrong instrument for a write.
 *
 * The read is the one Launchpad and Automation already gate on — imported,
 * never re-derived. A second implementation of "is this workspace demo" would
 * be a second answer, and the two would drift the first time one of them
 * learned something.
 */
import { NextResponse } from "next/server";

import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";

export const META_OPERATOR_DEMO_WRITE_REFUSAL =
  "Demo workspaces have zero Meta write authority. Recording a decision and running a snapshot are unavailable here.";

export const META_OPERATOR_UNVERIFIED_WRITE_REFUSAL =
  "This workspace could not be confirmed as a live (non-demo) workspace, so operator decisions and snapshot runs are held.";

/**
 * The refusal both routes issue before any durable write, telemetry emit,
 * cooldown stamp or engine run. Returns `null` only for a proven live
 * workspace.
 *
 * `businessId` must be the SERVER's resolved id — `access.membership.businessId`
 * — never the one the request body supplied, so the flag is read for the
 * workspace the caller was actually authorized against.
 *
 * The two codes are spelled exactly as Launchpad and Automation spell them, so
 * a disabled control on screen and the 403/503 from the route can never name
 * different reasons for the same refusal.
 */
export async function rejectIfMetaOperatorDemoWrite(
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
          message: META_OPERATOR_DEMO_WRITE_REFUSAL,
          action,
        },
        /*
         * Restated at the top level as well as inside `error`.
         *
         * `interpretMetaSnapshotRunResponse` — the one interpreter both
         * run-now clients share — reads `payload.message` and, failing that,
         * falls back to a generic "Snapshot refresh failed." A refusal an
         * operator cannot read is a refusal they will retry.
         */
        message: META_OPERATOR_DEMO_WRITE_REFUSAL,
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
          message: META_OPERATOR_UNVERIFIED_WRITE_REFUSAL,
          action,
        },
        message: META_OPERATOR_UNVERIFIED_WRITE_REFUSAL,
      },
      { status: 503 },
    );
  }
  return null;
}
