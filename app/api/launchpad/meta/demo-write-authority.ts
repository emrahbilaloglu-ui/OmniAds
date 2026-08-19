/**
 * Whether this workspace has ANY Meta write authority at all.
 *
 * The canonical invariant is unconditional:
 *
 *   "Demo decisions ... must use demo_synthetic_review_only, null authorized
 *    action, false action eligibility, and false exact-Ad execution
 *    eligibility. Demo businesses have zero Meta write authority even if a
 *    presentation defect supplies an action."
 *
 * Before this module the Decisions/briefing side honoured that rule and no
 * Launchpad route did. That asymmetry was reachable, not theoretical:
 * `/api/auth/demo-login` opens a session as an ADMIN of the demo business, and
 * that admin is not the reviewer email — so `rejectIfLaunchpadReviewerReadOnly`
 * let it straight through and `requireLaunchpadBusinessAccess` saw a role above
 * `collaborator`. Every Launchpad write was open to a demo session.
 *
 * The rule lives here, on the server, for a reason. Holding it only in the
 * browser would INVENT a rule the backend does not have: the surface would show
 * a refusal while the endpoint still accepted a hand-rolled POST. The client
 * gets to restate this refusal, never to be the only thing enforcing it.
 *
 * Fail-closed on an unreadable answer. `lib/business-mode.server.isDemoBusiness`
 * swallows its own errors and falls back to "is it the well-known demo id",
 * which reads a database outage as "live" — for a read-only presentation that is
 * survivable, for a provider write it is the wrong direction. Here an
 * unreadable demo flag is `unverified` and refuses, because a write must not
 * proceed on an unproven claim that this workspace is real.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";
import { jsonError } from "./route-utils";

export type LaunchpadWriteAuthority =
  /** Read, and this is a real workspace: writes may be attempted. */
  | "live"
  /** Read, and this is a demo workspace: zero Meta write authority. */
  | "demo"
  /** The flag could not be read. Refuses, and never reads as "live". */
  | "unverified"
  /**
   * No server established it for this render. Used only by the preserved
   * legacy mount, which is reached without a business page context. It does
   * not by itself grant anything — the route still holds the refusal — it only
   * means the surface has nothing server-owned to restate.
   */
  | "not_established";

export const LAUNCHPAD_DEMO_WRITE_REFUSAL =
  "Demo workspaces have zero Meta write authority. Launchpad writes are unavailable here.";

export const LAUNCHPAD_UNVERIFIED_WRITE_REFUSAL =
  "This workspace could not be confirmed as a live (non-demo) workspace, so Launchpad writes are held.";

export async function readLaunchpadWriteAuthority(
  businessId: string | null | undefined,
): Promise<LaunchpadWriteAuthority> {
  const id = businessId?.trim() ?? "";
  if (!id) return "unverified";
  // The well-known demo id is demo whether or not the table can be read.
  if (id === DEMO_BUSINESS_ID) return "demo";
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT is_demo_business
      FROM businesses
      WHERE id = ${id}
      LIMIT 1
    `) as Array<{ is_demo_business?: unknown }>;
    const row = rows[0];
    // The caller has already been authorized against a membership on this
    // business, so "no row" is a broken read, not a live workspace.
    if (!row) return "unverified";
    return row.is_demo_business ? "demo" : "live";
  } catch {
    return "unverified";
  }
}

/**
 * The refusal every mutating Launchpad route issues before it does anything
 * with provider or store state. Returns `null` only for a proven live
 * workspace.
 */
export async function rejectIfLaunchpadDemoWrite(
  businessId: string,
  action: string,
): Promise<NextResponse | null> {
  const authority = await readLaunchpadWriteAuthority(businessId);
  if (authority === "demo") {
    return jsonError(403, "demo_business_read_only", LAUNCHPAD_DEMO_WRITE_REFUSAL, {
      action,
    });
  }
  if (authority !== "live") {
    return jsonError(
      503,
      "demo_status_unverified",
      LAUNCHPAD_UNVERIFIED_WRITE_REFUSAL,
      { action },
    );
  }
  return null;
}
