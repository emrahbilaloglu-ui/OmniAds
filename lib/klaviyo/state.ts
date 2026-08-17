/**
 * The Klaviyo lifecycle state machine.
 *
 * One pure function, five states, and every Klaviyo surface reads its answer
 * rather than re-deriving one. The states are ordered by how much authority the
 * product actually holds, and the resolver returns the FIRST one that is true,
 * so a broken connection can never be described as ready and a deployment with
 * no client credential can never offer a Connect button that must fail.
 *
 *   not_configured          the deployment holds no Klaviyo client credential
 *                           (KLAVIYO_CLIENT_ID / KLAVIYO_CLIENT_SECRET). No
 *                           Connect button; the start route answers 501.
 *   not_connected           configured, but this workspace has no connection.
 *                           Connect button; no rail entry; em-dash table.
 *   reconnect_required      a connection row exists but is not `connected`
 *                           (expired, revoked, errored). Connect button, and
 *                           any stored snapshot is withheld — it describes a
 *                           grant the product no longer holds.
 *   awaiting_first_snapshot connected, no warehouse snapshot yet. The design's
 *                           first-import state: no rail entry, em-dash table.
 *   ready                   connected AND a snapshot exists. Rail entry, rows.
 *
 * Enforced in:
 *   - app/api/klaviyo/flows/route.ts   (serves rows only in `ready`)
 *   - app/api/klaviyo/status/route.ts  (drives the Integrations card button)
 *   - lib/klaviyo/sync.ts              (refuses to run outside `connected`)
 *   - components/layout/v2/app-rail.tsx (pre-existing gate on connected+synced)
 */

export const KLAVIYO_STATES = [
  "not_configured",
  "not_connected",
  "reconnect_required",
  "awaiting_first_snapshot",
  "ready",
] as const;

export type KlaviyoState = (typeof KLAVIYO_STATES)[number];

export interface KlaviyoStateInput {
  /** Both client credentials present in this deployment's environment. */
  oauthConfigured: boolean;
  /** The stored `provider_connections.status` for this business, or null. */
  connectionStatus: string | null;
  /** True when `klaviyo_flow_metrics` holds at least one row for this business. */
  hasSnapshot: boolean;
}

export function resolveKlaviyoState(input: KlaviyoStateInput): KlaviyoState {
  if (!input.oauthConfigured) return "not_configured";
  if (input.connectionStatus == null) return "not_connected";
  if (input.connectionStatus !== "connected") return "reconnect_required";
  if (!input.hasSnapshot) return "awaiting_first_snapshot";
  return "ready";
}

/**
 * Whether the Integrations card may offer a Connect click.
 *
 * `not_configured` is excluded on purpose: the design's own `showBtn`
 * conditional (model 4344) is what takes the button away, and offering one that
 * lands on a 501 would be worse than offering none.
 */
export function klaviyoIsConnectable(state: KlaviyoState): boolean {
  return state !== "not_configured";
}

/** Whether stored flow rows may be served. Only the terminal healthy state qualifies. */
export function klaviyoMayServeRows(state: KlaviyoState): boolean {
  return state === "ready";
}

/** Whether the rail may carry a Klaviyo entry (design 3284: live sources only). */
export function klaviyoBelongsInRail(state: KlaviyoState): boolean {
  return state === "ready";
}
