import { getIntegration, type IntegrationRow } from "@/lib/integrations";
import { resolveGoogleAccessTokenWithGeneration } from "@/lib/google-token-refresh";

const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface SearchConsoleContext {
  businessId: string;
  accessToken: string;
  siteUrl: string | null;
  integration: IntegrationRow;
  googleIntegration: IntegrationRow;
}

export class SearchConsoleAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = "SearchConsoleAuthError";
  }
}

function parseMetadataSite(
  metadata: Record<string, unknown> | undefined,
): string | null {
  if (!metadata) return null;
  const siteUrl = metadata.siteUrl;
  return typeof siteUrl === "string" && siteUrl.trim() ? siteUrl.trim() : null;
}

function hasSearchConsoleScope(scopes: string | null): boolean {
  if (!scopes) return false;
  return scopes.split(/\s+/).includes(SEARCH_CONSOLE_SCOPE);
}

export function getSearchConsoleSiteType(siteUrl: string): "domain" | "url-prefix" {
  return siteUrl.startsWith("sc-domain:") ? "domain" : "url-prefix";
}

export async function resolveSearchConsoleContext(params: {
  businessId: string;
  requireSite?: boolean;
}): Promise<SearchConsoleContext> {
  const requireSite = params.requireSite ?? true;

  const integration = await getIntegration(params.businessId, "search_console");
  if (!integration || integration.status !== "connected") {
    throw new SearchConsoleAuthError(
      "search_console_not_connected",
      "Search Console is not connected for this business.",
      404,
    );
  }

  const googleIntegration = await getIntegration(params.businessId, "google");
  if (!googleIntegration || googleIntegration.status !== "connected") {
    throw new SearchConsoleAuthError(
      "search_console_reconnect_required",
      "Google integration is required for Search Console. Please reconnect Google.",
      401,
    );
  }

  if (!hasSearchConsoleScope(googleIntegration.scopes)) {
    throw new SearchConsoleAuthError(
      "search_console_reconnect_required",
      "Google integration is missing Search Console scope. Please reconnect Google.",
      401,
    );
  }

  // The shared, generation-bound refresh flow. The hand-rolled version here
  // refreshed and never persisted, so every request refreshed again, and it was
  // bound to no generation — a reconnect mid-request was invisible.
  let accessToken: string | null = googleIntegration.access_token;
  const expiresAt = googleIntegration.token_expires_at
    ? new Date(googleIntegration.token_expires_at).getTime()
    : null;
  const expired = typeof expiresAt === "number" && expiresAt <= Date.now();

  if (expired || !accessToken) {
    try {
      accessToken = (
        await resolveGoogleAccessTokenWithGeneration({
          businessId: params.businessId,
          provider: "google",
        })
      ).accessToken;
    } catch {
      throw new SearchConsoleAuthError(
        "search_console_reconnect_required",
        "Search Console token refresh failed. Please reconnect Google.",
        401,
      );
    }
  }

  if (!accessToken) {
    throw new SearchConsoleAuthError(
      "search_console_reconnect_required",
      "Google access token is missing. Please reconnect Google.",
      401,
    );
  }

  const metadata =
    integration.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : undefined;
  const siteUrl =
    parseMetadataSite(metadata) ?? integration.provider_account_id ?? null;

  if (requireSite && !siteUrl) {
    throw new SearchConsoleAuthError(
      "search_console_site_not_selected",
      "Search Console is connected but no site is selected.",
      422,
    );
  }

  return {
    businessId: params.businessId,
    accessToken,
    siteUrl,
    integration,
    googleIntegration,
  };
}
