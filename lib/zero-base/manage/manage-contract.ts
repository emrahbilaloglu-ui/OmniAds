/**
 * Integrations, Team, Business, Plan (H41–H47, Flows H and M).
 *
 * Three rules shape this module, each from a way an operator could be misled:
 *
 * 1. **Provider health is per provider.** Meta being connected says nothing
 *    about Google. A single "integrations healthy" badge is a claim about
 *    providers nobody checked.
 * 2. **A write is not a read-back.** Reconnect, reassign and delete each end
 *    with a separate read of the resulting state. A 200 is an acknowledgement,
 *    not an observation, and business deletion in particular must never report
 *    success from a response alone.
 * 3. **Plan is presentation.** It gates no route and no control, and there is
 *    no billing call anywhere in this surface — asserted by a call-site scan.
 */

export type ProviderId = "meta" | "google" | "shopify" | "ga4" | "search_console";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  meta: "Meta Ads",
  google: "Google Ads",
  shopify: "Shopify",
  ga4: "Google Analytics 4",
  search_console: "Search Console",
};

export type ConnectionState =
  | { kind: "connected"; accountLabel: string | null }
  | { kind: "needs_reconnect"; reason: string }
  | { kind: "not_connected" }
  | { kind: "unknown"; reason: string };

export interface ProviderHealth {
  provider: ProviderId;
  label: string;
  state: ConnectionState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Adapt the integration status payload into per-provider rows.
 *
 * A provider the payload does not mention is `unknown`, never `not_connected`:
 * we did not read it, which is a different fact from having read that it is
 * absent.
 */
export function adaptProviderHealth(raw: unknown, providers: readonly ProviderId[]): ProviderHealth[] {
  const body = isRecord(raw) ? raw : {};
  const integrations = isRecord(body.integrations) ? body.integrations : body;
  return providers.map((provider) => {
    const entry = integrations[provider];
    if (entry === undefined) {
      return {
        provider,
        label: PROVIDER_LABEL[provider],
        state: { kind: "unknown", reason: "This provider was not reported by the status read." },
      };
    }
    if (entry === true) {
      return { provider, label: PROVIDER_LABEL[provider], state: { kind: "connected", accountLabel: null } };
    }
    if (entry === false) {
      return { provider, label: PROVIDER_LABEL[provider], state: { kind: "not_connected" } };
    }
    if (isRecord(entry)) {
      const status = str(entry.status);
      if (status === "connected") {
        return {
          provider,
          label: PROVIDER_LABEL[provider],
          state: { kind: "connected", accountLabel: str(entry.accountName) ?? str(entry.accountId) },
        };
      }
      if (status === "expired" || entry.reconnectRequired === true) {
        return {
          provider,
          label: PROVIDER_LABEL[provider],
          state: {
            kind: "needs_reconnect",
            reason: str(entry.message) ?? "This connection needs to be re-authorized.",
          },
        };
      }
      return { provider, label: PROVIDER_LABEL[provider], state: { kind: "not_connected" } };
    }
    return {
      provider,
      label: PROVIDER_LABEL[provider],
      state: { kind: "unknown", reason: "This provider's status could not be read." },
    };
  });
}

/** There is no aggregate health. Asking for one returns the reason there isn't. */
export const NO_UNIVERSAL_HEALTH =
  "Each provider is reported on its own. One being connected says nothing about the others.";

/* ------------------------------------------------------------- read-back */

export type CeremonyOutcome =
  | { kind: "unstarted" }
  | { kind: "submitted" }
  | { kind: "confirmed"; detail: string }
  | { kind: "unknown"; detail: string }
  | { kind: "failed"; detail: string };

/**
 * Resolve a write plus its separate read-back.
 *
 * `accepted` is what the POST said. `observed` is what a later, independent
 * read saw — null when that read did not happen or failed. Only an observation
 * that matches the intent may be reported as confirmed.
 */
export function resolveCeremony(input: {
  accepted: boolean;
  acceptError: string | null;
  observed: boolean | null;
  observeError: string | null;
}): CeremonyOutcome {
  if (input.acceptError) return { kind: "failed", detail: `${input.acceptError} Nothing was changed.` };
  if (!input.accepted) return { kind: "unstarted" };
  if (input.observed === null) {
    return {
      kind: "unknown",
      detail:
        (input.observeError ? `${input.observeError} ` : "") +
        "The change was submitted but could not be confirmed by a separate read. Treat the result as unknown.",
    };
  }
  if (!input.observed) {
    return {
      kind: "unknown",
      detail: "The change was submitted but the read-back does not show it. Treat the result as unknown.",
    };
  }
  return { kind: "confirmed", detail: "Confirmed by a separate read." };
}

/**
 * Business deletion never claims success from a response.
 *
 * The only outcome that may say "deleted" is one where a later read no longer
 * finds the business. Everything else is unknown, because a business that still
 * exists while the UI says it is gone is unrecoverable confusion.
 */
export const DELETE_CEREMONY_NOTE =
  "Deleting a business is confirmed only by a separate read that no longer finds it. Until then the result is unknown, never 'deleted'.";

/* --------------------------------------------------------------- economics */

export interface EconomicsField {
  key: string;
  label: string;
  /** Where this value came from. */
  source: string;
  /** What actually reads it. Named, so divergence is traceable. */
  consumers: string[];
  value: string | null;
}

/**
 * Divergence between two economics sources.
 *
 * Naming the exact source and the exact consumers is the point: "these differ"
 * is not actionable, while "the cost model says X, the commercial target says
 * Y, and the decision engine reads the commercial target" tells an operator
 * which one to fix.
 */
export function economicsDivergence(fields: readonly EconomicsField[]): {
  diverged: boolean;
  message: string | null;
} {
  const byKey = new Map<string, EconomicsField[]>();
  for (const field of fields) {
    byKey.set(field.key, [...(byKey.get(field.key) ?? []), field]);
  }
  const conflicts = [...byKey.entries()].filter(([, group]) => {
    const values = new Set(group.map((f) => f.value ?? "(not set)"));
    return group.length > 1 && values.size > 1;
  });
  if (conflicts.length === 0) return { diverged: false, message: null };
  const detail = conflicts
    .map(([key, group]) =>
      `${key}: ` +
      group
        .map((f) => `${f.source} says ${f.value ?? "nothing"} (read by ${f.consumers.join(", ") || "nothing"})`)
        .join("; "),
    )
    .join(" · ");
  return { diverged: true, message: `These economics sources disagree — ${detail}.` };
}

/** `recommendedMode` is advice. It is displayed and never editable. */
export const RECOMMENDED_MODE_READ_ONLY =
  "Recommended mode is derived by the engine. It is shown for reference and cannot be set here.";

/* -------------------------------------------------------------------- plan */

export const BILLING_ENDPOINT = "/api/billing";

/** Plan gates nothing. Stated so the absence of gating is deliberate. */
export const PLAN_GATES_NOTHING =
  "Your plan is shown for reference. No route or control in this product is gated by it.";

/* ============================================================================
 * Real endpoint contracts.
 *
 * Added after a transition audit found three boundaries that could never work:
 *
 * - `/api/integrations` has GET and DELETE only, so the reconnect POST always
 *   answered 405. Reconnect is an OAuth start, not a mutation on that route.
 * - `/api/business-cost-model` returns `{costModel}`, and the client read the
 *   wrapper itself while asking for `targetRoas`/`recommendedMode`, neither of
 *   which the cost model carries. Those live on two other endpoints.
 * - `/api/businesses/[businessId]` has no GET, so the deletion read-back always
 *   saw 405 and could never confirm.
 * ========================================================================== */

/**
 * Providers whose start route begins a completable OAuth round trip from here.
 *
 * Two deliberate absences:
 *
 * - **Klaviyo.** `/api/oauth/klaviyo/start` answers 501 by design, so a control
 *   for it could only ever refuse.
 * - **Shopify.** Its start route redirects any request without a `shop` to
 *   `/shopify/connect` and drops `businessId`/`returnTo` on the way, because
 *   installation is owned by the Shopify App Store or Admin. Presenting it here
 *   as a generic Connect would claim a round trip this product cannot begin.
 *   Shopify has its own entry below.
 */
export const OAUTH_START_PROVIDERS = {
  meta: "/api/oauth/meta/start",
  google: "/api/oauth/google/start",
  ga4: "/api/oauth/google-analytics/start",
  search_console: "/api/oauth/search_console/start",
} as const satisfies Partial<Record<ProviderId, string>>;

/**
 * Who may begin an authorization round trip.
 *
 * Every start route above calls `requireBusinessAccess({minRole:
 * "collaborator"})`. A guest who clicks is answered with a JSON 403 — a raw
 * error document, not a surface — so the refusal has to happen here, before the
 * navigation. The server gate remains the authority; this only stops the UI
 * from offering an action it knows will be refused.
 */
export function oauthStartPermission(role: string | null): { ok: true } | { ok: false; reason: string } {
  if (role === "admin" || role === "collaborator") return { ok: true };
  return {
    ok: false,
    reason: `Connecting or reconnecting a provider needs the collaborator role. Your role on this workspace is ${role ?? "not reported"}.`,
  };
}

/**
 * Where the operator lands after the round trip.
 *
 * This is the surface that started the authorization, carrying the provider so
 * the page knows which one to re-read. The same path serves a first-time
 * connect and a reconnect: the provider does not distinguish them, and two
 * separate return paths would be two chances to get the return wrong. It is not an invented contract: every start
 * route sanitizes it into its OAuth state, every callback re-sanitizes it back
 * out, and the shared callback page redirects to it — so the parameter arrives
 * because the real flow carried it, not because the UI hoped for it.
 */
export function reconnectReturnPath(input: { businessId: string; provider: string }): string {
  return `/c/${encodeURIComponent(input.businessId)}/manage/integrations?reconnected=${encodeURIComponent(
    input.provider,
  )}`;
}

/**
 * The URL that begins a reconnect.
 *
 * Reconnecting is an OAuth round trip through the provider, not a POST this
 * product can make on the user's behalf. Returning null for an unknown provider
 * keeps the surface from rendering a link that 404s.
 */
export function oauthStartUrl(input: {
  provider: string;
  businessId: string;
}): string | null {
  const base = (OAUTH_START_PROVIDERS as Record<string, string>)[input.provider];
  if (!base) return null;
  const returnTo = reconnectReturnPath({ businessId: input.businessId, provider: input.provider });
  return `${base}?businessId=${encodeURIComponent(input.businessId)}&returnTo=${encodeURIComponent(returnTo)}`;
}

/** `{ costModel: { cogsPercent, shippingPercent, feePercent, fixedCost } }`. */
export interface AdaptedCostModel {
  cogsPercent: number | null;
  shippingPercent: number | null;
  feePercent: number | null;
  fixedCost: number | null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function adaptCostModel(raw: unknown): AdaptedCostModel | null {
  if (!isRecord(raw) || !isRecord(raw.costModel)) return null;
  const model = raw.costModel as Record<string, unknown>;
  return {
    cogsPercent: nullableNumber(model.cogsPercent),
    shippingPercent: nullableNumber(model.shippingPercent),
    feePercent: nullableNumber(model.feePercent),
    fixedCost: nullableNumber(model.fixedCost),
  };
}

/** `{ snapshot, revision, permissions }` from business-commercial-settings. */
export function adaptCommercialTarget(raw: unknown): { targetRoas: number | null; canEdit: boolean } | null {
  if (!isRecord(raw) || !isRecord(raw.snapshot)) return null;
  const snapshot = raw.snapshot as Record<string, unknown>;
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  return {
    targetRoas: nullableNumber(snapshot.targetRoas) ?? nullableNumber(snapshot.target_roas),
    canEdit: permissions.canEdit === true,
  };
}

/** `recommendedMode` from the operating-mode payload. */
export function adaptRecommendedMode(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const value = raw.recommendedMode;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Confirm a business deletion from the LIST endpoint.
 *
 * `/api/businesses/[businessId]` has no GET, so re-reading it always answered
 * 405 and the ceremony could never confirm. The list is the read that can
 * actually answer the question, and only its absence counts.
 */
export function confirmDeletionFromList(input: {
  listOk: boolean;
  businesses: unknown;
  deletedId: string;
}): boolean | null {
  if (!input.listOk || !Array.isArray(input.businesses)) return null;
  const ids = input.businesses
    .map((item) => (isRecord(item) ? item.id : null))
    .filter((id): id is string => typeof id === "string");
  // An empty list from a failed-but-ok read would be a false confirmation, so
  // the caller must only pass a genuinely successful list read.
  return !ids.includes(input.deletedId);
}


/* ------------------------------------------------------- business settings */

export interface BusinessSettings {
  name: string;
  currency: string;
}

/**
 * Current name and currency.
 *
 * `/api/businesses/[businessId]` has PATCH and DELETE only — no GET — so the
 * current values are read from the collection the session can already see.
 */
export function businessFromList(raw: unknown, businessId: string): BusinessSettings | null {
  if (!isRecord(raw)) return null;
  const list = Array.isArray(raw.businesses) ? raw.businesses : null;
  if (!list) return null;
  const match = list.filter(isRecord).find((row) => String(row.id ?? "") === businessId);
  if (!match) return null;
  return {
    name: typeof match.name === "string" ? match.name : "",
    currency: typeof match.currency === "string" ? match.currency.toUpperCase() : "",
  };
}

/**
 * The exact body `PATCH /api/businesses/[businessId]` accepts.
 *
 * It requires **both** fields on every call and refuses a name under two
 * characters, so a partial patch is a guaranteed 400. Refusing here keeps the
 * round trip out and states the same rule the handler enforces.
 */
export function businessSettingsBody(input: {
  name: string;
  currency: string;
}): { name: string; currency: string } | { error: string } {
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  if (name.length < 2) {
    return { error: "A workspace name needs at least two characters." };
  }
  if (!currency) {
    return { error: "A currency is required." };
  }
  return { name, currency };
}


/* ------------------------------------------------------------------ Shopify */

/** The pattern the real `normalizeShopifyShopDomain` accepts. */
const SHOPIFY_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The setup surface the Shopify start route itself redirects to. */
export const SHOPIFY_SETUP_PATH = "/shopify/connect";

export const SHOPIFY_EXTERNAL_NOTE =
  "Authorization for Shopify starts in Shopify, from the App Store or your store admin. This product cannot begin it, and cannot confirm the result until the install returns.";

export type ShopifyEntry =
  | {
      kind: "reauthorize";
      /** A real, completable start: the handler accepts a session plus a shop. */
      href: string;
      shopDomain: string;
      label: string;
    }
  | { kind: "external_install"; href: string; label: string; note: string };

/**
 * How Shopify is actually entered.
 *
 * With no `shop`, `/api/oauth/shopify/start` redirects to `/shopify/connect`
 * and discards `businessId` and `returnTo`, so a generic Connect is a dead end.
 * With a valid `shop` the same handler *does* complete: it reads the session,
 * encodes `businessId` and a sanitized `returnTo` into the OAuth state, and
 * redirects to Shopify's authorization URL. That path is only offered when a
 * connected integration supplies an authoritative shop domain — never from a
 * domain this surface guessed or asked the operator to type.
 */
export function shopifyEntry(input: {
  businessId: string;
  /** `provider_account_id` from the stored Shopify integration, if connected. */
  shopDomain: string | null;
}): ShopifyEntry {
  const shop = input.shopDomain?.trim().toLowerCase() ?? "";
  if (SHOPIFY_SHOP_DOMAIN.test(shop)) {
    const returnTo = reconnectReturnPath({ businessId: input.businessId, provider: "shopify" });
    const params = new URLSearchParams({
      shop,
      businessId: input.businessId,
      returnTo,
    });
    return {
      kind: "reauthorize",
      href: `/api/oauth/shopify/start?${params.toString()}`,
      shopDomain: shop,
      label: `Reauthorize ${shop}`,
    };
  }
  return {
    kind: "external_install",
    href: SHOPIFY_SETUP_PATH,
    label: "Open Shopify setup",
    note: SHOPIFY_EXTERNAL_NOTE,
  };
}
