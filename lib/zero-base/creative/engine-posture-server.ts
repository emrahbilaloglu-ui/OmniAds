/**
 * The Engine V3 posture, decided on the server for a mounted surface.
 *
 * `engine-posture.ts` has held the five postures and their operator sentences
 * for some time, and nothing in `app/` or `components/` called it: the module
 * was reachable only from its own test. So the rule WP10 states —
 * *"Engine posture hidden, shadow-only veya authoritative olarak çözülür"*,
 * and *"Shadow decision authority gibi gösterilmez"* — was written down and
 * never enforced anywhere an operator could see. A Creative Studio in shadow
 * mode and a Creative Studio serving live decisions looked identical.
 *
 * This is the missing half: one server-side read that turns the stored flags
 * into a posture, so the surface can state which of the five it is in before
 * any decision is shown.
 *
 * ## Failing closed
 *
 * A flag read that throws resolves to `unavailable`, never to `serving`. Those
 * are the two answers that matter and they are not symmetric: "we could not
 * find out" presented as "these decisions are authoritative" is the one
 * mistake in this file that could get a real budget moved.
 */
// No `server-only` marker: the package is not a dependency of this repo and no
// other module uses one. What keeps this file on the server is the import
// below — `resolveEngineV3Flags` reaches the database — and the fact that every
// caller is a Server Component.
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";

import { resolveEnginePosture, type EnginePosture } from "./engine-posture";

export interface ServerEnginePosture {
  posture: EnginePosture;
  /** True only for `serving`. Restated here so a caller need not re-derive it. */
  decisionsAreAuthority: boolean;
}

/**
 * Read the posture for one business.
 *
 * The `status` handed to the resolver is `"serving"` because this is the flag
 * read, not an inventory read: whether decisions EXIST for an account is a
 * separate question that `/api/creatives/decision-engine-v3` answers per
 * account. What this decides is whether any decision that does exist may be
 * presented as authority — which is a business-level fact and is exactly the
 * one the surface was missing.
 */
export async function readServerEnginePosture(
  businessId: string,
): Promise<ServerEnginePosture> {
  const flags = await resolveEngineV3Flags(businessId).catch(() => null);
  const posture = resolveEnginePosture({ status: "serving", flags });
  return { posture, decisionsAreAuthority: posture === "serving" };
}
