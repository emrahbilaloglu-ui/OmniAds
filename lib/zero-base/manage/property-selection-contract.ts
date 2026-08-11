/**
 * GA4 property and Search Console site selection.
 *
 * A previous Phase E report claimed this scope was absent. It was not: the
 * routes and helpers below already existed, and the claim was wrong. Discovery,
 * authorization, stale-generation protection and persistence stay owned by
 * those routes; nothing here re-implements selection semantics.
 *
 * The real contracts:
 *
 * - `GET /api/google-analytics/properties?businessId=` → `{data, selectedPropertyId}`.
 *   The discovery route reports the current selection, so it is its own
 *   read-back authority. Wrapped by `fetchGa4Properties`.
 * - `POST /api/google-analytics/select-property` takes
 *   `{businessId, propertyId, propertyName, accountId, accountName}` and
 *   answers `{error}` on failure. Wrapped by `saveGa4PropertySelection`.
 * - `GET /api/google-search-console/sites?businessId=` → `{sites: [{siteUrl,
 *   permissionLevel, siteType}]}`. It reports **no** current selection.
 * - `POST /api/google-search-console/select-site` takes `{businessId, siteUrl}`
 *   and answers `{success, integration}`. It can answer 409
 *   `connection_changed` when the connection moved underneath the validation.
 *
 * Because the sites route carries no selection, the Search Console read-back
 * goes to `/api/integrations?businessId=&provider=search_console`, whose
 * `provider_account_id` is what `select-site` actually wrote. The existing
 * dashboard flow confirms from the write response instead; this one does not,
 * because a write response is what the server said, not what is now stored.
 */
import {
  fetchGa4Properties,
  saveGa4PropertySelection,
  type GA4Property,
} from "@/components/integrations/ga4-property-picker-support";

export { fetchGa4Properties, saveGa4PropertySelection };
export type { GA4Property };

export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string | null;
  siteType: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Compare two GA4 property identifiers.
 *
 * The Admin API returns `properties/12345` and the stored selection is
 * normalized to the same prefixed form, but the two are compared on the bare id
 * so a prefix difference cannot be mistaken for a failed save. This mirrors the
 * server's own `properties/` convention rather than importing its module, which
 * would drag server-only dependencies into the client bundle.
 */
export function samePropertyId(a: string | null, b: string | null): boolean {
  const bare = (value: string | null) => value?.trim().replace(/^properties\//, "") || null;
  const left = bare(a);
  return left !== null && left === bare(b);
}

/**
 * Compare two Search Console site identifiers.
 *
 * `select-site` normalizes a URL through `new URL(...).toString()`, which can
 * add a trailing slash, and passes `sc-domain:` identifiers through untouched.
 * A trailing-slash difference is the same site.
 */
export function sameSiteUrl(a: string | null, b: string | null): boolean {
  const norm = (value: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("sc-domain:")) return trimmed;
    return trimmed.replace(/\/+$/, "");
  };
  const left = norm(a);
  return left !== null && left === norm(b);
}

/** Adapt `{sites}`. A body without the array is refused, never read as empty. */
export function adaptSearchConsoleSites(
  raw: unknown,
): { ok: true; sites: SearchConsoleSite[] } | { ok: false; reason: string } {
  if (!isRecord(raw) || !Array.isArray(raw.sites)) {
    return {
      ok: false,
      reason: "The Search Console sites response could not be read, so no site can be chosen.",
    };
  }
  const sites = raw.sites.filter(isRecord).flatMap((row) => {
    const siteUrl = text(row.siteUrl);
    if (!siteUrl) return [];
    return [
      {
        siteUrl,
        permissionLevel: text(row.permissionLevel),
        siteType: text(row.siteType),
      },
    ];
  });
  return { ok: true, sites };
}

/**
 * The currently stored Search Console site, from the integration record.
 *
 * `/api/integrations?provider=search_console` answers `{integration}`; the site
 * lives in `provider_account_id`. Null means "not readable", which is different
 * from "nothing selected" and is reported differently by the caller.
 */
export function selectedSiteFromIntegration(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.integration)) return null;
  const integration = raw.integration;
  return text(integration.provider_account_id) ?? text(integration.provider_account_name);
}

/** The exact body `select-site` accepts. */
export function selectSiteBody(input: { businessId: string; siteUrl: string }) {
  return { businessId: input.businessId, siteUrl: input.siteUrl };
}

/**
 * Both selection routes require `collaborator`.
 *
 * GA4 discovery also requires `collaborator`; Search Console discovery admits
 * `guest`, so a reviewer may see the site list but may not change it.
 */
export function selectionPermission(role: string | null): { ok: true } | { ok: false; reason: string } {
  if (role === "admin" || role === "collaborator") return { ok: true };
  return {
    ok: false,
    reason: `Changing the selected property or site needs the collaborator role. Your role on this workspace is ${role ?? "not reported"}.`,
  };
}
