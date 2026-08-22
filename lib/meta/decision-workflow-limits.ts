/**
 * The most decision keys one workflow read may ask for.
 *
 * Shared between `/api/meta/decision-workflow` and the surfaces that call it,
 * because over the cap the read returns an error — and a surface turns that
 * into "ownership unknown" for **every** row. A client capping at a different
 * number than the server therefore turns a large lane into a blank overlay,
 * which looks like "nobody owns any of this" rather than like a request that
 * asked for too much.
 *
 * It lives here rather than in the route because a Next route module may export
 * only what Next accepts (`app/api/route-export-surface.test.ts`).
 */
export const DECISION_WORKFLOW_KEY_CAP = 200;
