/**
 * The one read of the operator's ROAS proposal floor, shared by both producers
 * of a confirmation-queue row.
 *
 * It lives in its own module rather than in the control plane because the engine
 * projection (`automation-proposals.ts`) is downstream of the control plane's
 * own import chain — control plane → rules store → proposal intake → proposals —
 * so importing it back would close a cycle. One tiny module both sides depend on
 * keeps a single definition of "what floor did the operator commit" without one.
 *
 * There is no provider client here, and there never may be: this file only ever
 * reads one column of this product's own table.
 */

import { getDb } from "@/lib/db";

/**
 * A floor, or a refusal to state one.
 *
 * `unreadable` exists so a caller can fail closed. "I could not read the floor"
 * and "there is no floor" are different facts, and collapsing them would let a
 * transient database error quietly re-open the guardrail — which is exactly the
 * class of defect this module was written to close.
 */
export type MetaAutomationRoasFloorRead =
  | { status: "known"; floor: number | null }
  | { status: "unreadable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** `42P01` no such table, `42703` no such column — both mean "not migrated yet". */
function isMissingSchemaError(error: unknown) {
  return (
    isRecord(error) && (error.code === "42P01" || error.code === "42703")
  );
}

/**
 * Read `meta_automation_business_controls.min_roas_floor` for one business.
 *
 * A missing table or column is `{ known, floor: null }` on purpose: a schema
 * that cannot hold a floor cannot be hiding one, so an un-migrated database
 * keeps today's behaviour rather than blocking every proposal. Any other failure
 * is `unreadable`, and the caller must withhold rather than proceed.
 */
export async function readMetaAutomationProposalRoasFloor(
  businessId: string,
): Promise<MetaAutomationRoasFloorRead> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT min_roas_floor
      FROM meta_automation_business_controls
      WHERE business_id = ${businessId}
      LIMIT 1
    `) as Array<{ min_roas_floor?: string | number | null }>;
    const raw = rows[0]?.min_roas_floor;
    if (raw === null || raw === undefined || raw === "") {
      return { status: "known", floor: null };
    }
    const floor = Number(raw);
    // A stored value that will not parse is not a floor this process may
    // interpret, and guessing one would be inventing the operator's policy.
    if (!Number.isFinite(floor) || floor <= 0) return { status: "unreadable" };
    return { status: "known", floor };
  } catch (error) {
    if (isMissingSchemaError(error)) return { status: "known", floor: null };
    return { status: "unreadable" };
  }
}
