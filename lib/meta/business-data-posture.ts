/**
 * Is this workspace's Meta data demo, live, or unknown?
 *
 * The READ-side sibling of `readLaunchpadWriteAuthority`, and deliberately the
 * same underlying read of `businesses.is_demo_business`, so a surface and the
 * write boundary behind it can never disagree about what a workspace is.
 *
 * ## Why the third state exists
 *
 * `lib/business-mode.server.isDemoBusiness` answers a BOOLEAN, and it
 * manufactures that boolean when it cannot read: a `businesses` table that is
 * not ready, a query that throws, or a row that is missing all degrade to
 * "is this the one hard-coded demo id", which for every other workspace means
 * `false` — live. It then caches that guess for 60 seconds as if it were a
 * measurement. `lib/demo-business.isDemoBusinessId` is only the id comparison
 * and never reads the column at all.
 *
 * On a write path that is a security hole, and it was closed by
 * `app/api/meta/demo-write-authority.ts`. On a READ path it is a different but
 * still real defect: an unreadable flag makes the surface call a provider,
 * serve live figures, and enable controls for a workspace it cannot vouch for —
 * and INVARIANTS is unconditional that a demo workspace has zero Meta write
 * authority and false action eligibility. A screen that cannot tell must say so.
 *
 * ## What each answer permits
 *
 *   `demo`       — committed synthetic review evidence. Demo fixtures may be
 *                  served, and only demo fixtures.
 *   `live`       — proven real workspace. Live sources may be read.
 *   `unverified` — NOT live. Render unavailable or read-only. Do not call a
 *                  provider, do not serve live figures as fact, do not enable a
 *                  control. This is the fail-closed direction and it is the
 *                  whole point of the type being three-valued.
 *
 * There is no fourth state and no default. A caller that treats `unverified`
 * like `live` has reintroduced the defect, and
 * `app/api/meta-demo-posture.contract.test.ts` fails when one appears.
 */
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";

export type MetaBusinessDataPosture = "demo" | "live" | "unverified";

/**
 * The canonical read. One database read of one column, through one function.
 *
 * `not_established` — the write authority's word for "no server established
 * this" — collapses into `unverified` here, because a read surface has the same
 * obligation either way: it may not present unproven data as live.
 */
export async function readMetaBusinessDataPosture(
  businessId: string | null | undefined,
): Promise<MetaBusinessDataPosture> {
  const authority = await readLaunchpadWriteAuthority(businessId);
  if (authority === "demo") return "demo";
  if (authority === "live") return "live";
  return "unverified";
}

/** The sentence a source or surface says when the posture cannot be read. */
export const META_POSTURE_UNVERIFIED_REASON =
  "This workspace could not be confirmed as a live (non-demo) workspace, so Meta data is withheld rather than shown as live.";
