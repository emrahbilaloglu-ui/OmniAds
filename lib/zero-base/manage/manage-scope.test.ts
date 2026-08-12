/**
 * WP-23 contracts, read from the handlers rather than assumed.
 *
 * The defects these lock down:
 *
 * - the reconnect link carried no `returnTo`, while the client waited for a
 *   `reconnected` parameter no callback emitted. The operator never came back.
 * - Klaviyo was offered as reconnectable, but its start route answers 501 by
 *   design.
 * - the team surface read `member.id`; the handler selects `membership_id`.
 * - business settings were absent entirely, though the PATCH route takes name
 *   and currency together.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OAUTH_START_PROVIDERS,
  businessFromList,
  businessSettingsBody,
  oauthStartUrl,
  reconnectReturnPath,
} from "@/lib/zero-base/manage/manage-contract";
import {
  accessRequestBody,
  adaptAccessRequests,
  adaptInvites,
  adaptMembers,
  adaptWorkspaces,
  inviteBody,
  memberRoleBody,
  memberWorkspacesBody,
  removeMemberBody,
  revokeInviteBody,
  teamPermission,
} from "@/lib/zero-base/manage/team-contract";
import {
  adaptAccessibleAccounts,
  getProviderFetchPath,
  getProviderSavePath,
} from "@/lib/zero-base/manage/assignment-contract";
import { sanitizeNextPath } from "@/lib/auth-routing";
import {
  adaptSearchConsoleSites,
  sameSiteUrl,
  samePropertyId,
  selectedSiteFromIntegration,
  selectionPermission,
} from "@/lib/zero-base/manage/property-selection-contract";

const ROOT = process.cwd();
const BIZ = "55555555-5555-4555-8555-555555555555";

function source(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

describe("WP-23 the OAuth return path is real end to end", () => {
  it("REGRESSION: every offered provider's start URL carries a sanitized returnTo", () => {
    for (const provider of Object.keys(OAUTH_START_PROVIDERS)) {
      const url = oauthStartUrl({ provider, businessId: BIZ });
      expect(url, provider).toBeTruthy();
      const params = new URL(url!, "https://example.test").searchParams;
      expect(params.get("businessId"), provider).toBe(BIZ);
      const returnTo = params.get("returnTo");
      expect(returnTo, provider).toBeTruthy();
      // Must survive the same sanitizer every route applies.
      expect(sanitizeNextPath(returnTo), provider).toBe(returnTo);
    }
  });

  it("the return path names the provider so the page knows what to re-read", () => {
    const returnTo = reconnectReturnPath({ businessId: BIZ, provider: "meta" });
    const url = new URL(returnTo, "https://example.test");
    expect(url.pathname).toBe(`/c/${BIZ}/manage/integrations`);
    expect(url.searchParams.get("reconnected")).toBe("meta");
  });

  it("REGRESSION: Klaviyo is not offered, because its start route answers 501", () => {
    expect(Object.keys(OAUTH_START_PROVIDERS)).not.toContain("klaviyo");
    expect(source("app/api/oauth/klaviyo/start/route.ts")).toContain("not_implemented");
  });

  it("every offered start route reads returnTo, directly or by forwarding", () => {
    const paths: Record<string, string> = {
      meta: "app/api/oauth/meta/start/route.ts",
      google: "app/api/oauth/google/start/route.ts",
      // Shopify is deliberately not in OAUTH_START_PROVIDERS; its handler
      // behavior is tested directly in shopify-entry.test.ts.
      ga4: "app/api/oauth/google-analytics/start/route.ts",
      search_console: "app/api/oauth/search_console/start/route.ts",
    };
    for (const [provider, file] of Object.entries(paths)) {
      const text = source(file);
      expect(text, provider).toContain("returnTo");
      // Never raw: the value round-trips through the provider.
      expect(text, provider).toContain("sanitizeNextPath");
    }
  });

  it("every callback re-sanitizes returnTo on the way back", () => {
    const callbacks = [
      "app/api/oauth/meta/callback/route.ts",
      "app/api/oauth/google/callback/route.ts",
      "app/api/oauth/shopify/callback/route.ts",
      "app/api/oauth/google-analytics/callback/route.ts",
    ];
    for (const file of callbacks) {
      const text = source(file);
      expect(text, file).toContain("returnTo");
      expect(text, file).toContain("sanitizeNextPath");
    }
  });

  it("the shared callback page honours returnTo", () => {
    const page = source("app/(dashboard)/integrations/callback/[provider]/legacy-page.tsx");
    expect(page).toContain("sanitizeNextPath(searchParams.get(\"returnTo\"))");
    expect(page).toContain("router.replace(returnTo)");
  });
});

describe("WP-23 team bodies match the handlers", () => {
  it("REGRESSION: members are keyed by membership_id, not a missing id", () => {
    const rows = adaptMembers({
      members: [
        { membership_id: "m1", user_id: "u1", role: "admin", status: "active", name: "Ada", email: "a@x.test" },
        // No membership id: cannot be acted on, so it is not offered.
        { user_id: "u2", role: "guest", status: "active", name: "Bo" },
      ],
    });
    expect(rows).not.toBeNull();
    expect(rows!.map((row) => row.membershipId)).toEqual(["m1"]);
    expect(rows![0].userId).toBe("u1");
  });

  it("refuses a body with no members array rather than showing an empty team", () => {
    expect(adaptMembers({})).toBeNull();
    expect(adaptInvites({})).toBeNull();
    expect(adaptAccessRequests({})).toBeNull();
    expect(adaptWorkspaces({})).toBeNull();
  });

  it("builds the exact bodies each verb takes", () => {
    expect(memberRoleBody({ businessId: BIZ, membershipId: "m1", role: "admin" })).toEqual({
      businessId: BIZ,
      membershipId: "m1",
      role: "admin",
    });
    expect(memberWorkspacesBody({ businessId: BIZ, memberUserId: "u1", workspaceIds: ["w1"] })).toEqual({
      businessId: BIZ,
      action: "update_workspaces",
      memberUserId: "u1",
      workspaceIds: ["w1"],
    });
    expect(removeMemberBody({ businessId: BIZ, membershipId: "m1" })).toEqual({
      businessId: BIZ,
      membershipId: "m1",
    });
    expect(revokeInviteBody({ businessId: BIZ, inviteId: "i1" })).toEqual({
      businessId: BIZ,
      inviteId: "i1",
      action: "revoke",
    });
    expect(accessRequestBody({ businessId: BIZ, membershipId: "m1", action: "approve" })).toEqual({
      businessId: BIZ,
      membershipId: "m1",
      action: "approve",
    });
  });

  it("refuses an empty invite list before the round trip, as the route would", () => {
    const result = inviteBody({ businessId: BIZ, emails: ["  ", ""], role: "guest" });
    expect("error" in result).toBe(true);
    const ok = inviteBody({ businessId: BIZ, emails: [" a@x.test "], role: "guest" });
    expect("error" in ok).toBe(false);
    expect((ok as { emails: string[] }).emails).toEqual(["a@x.test"]);
  });

  it("mirrors the handlers' own role gates", () => {
    // members/invites GET admit guest; every write requires admin.
    expect(teamPermission({ role: "guest", operation: "membersRead" }).ok).toBe(true);
    expect(teamPermission({ role: "reviewer", operation: "membersWrite" }).ok).toBe(false);
    expect(teamPermission({ role: "collaborator", operation: "invitesWrite" }).ok).toBe(false);
    expect(teamPermission({ role: "admin", operation: "invitesWrite" }).ok).toBe(true);
    // access requests are admin-only on both verbs.
    expect(teamPermission({ role: "collaborator", operation: "accessRequestsRead" }).ok).toBe(false);
    expect(teamPermission({ role: "admin", operation: "accessRequestsRead" }).ok).toBe(true);
  });

  it("names the required role in every refusal", () => {
    const result = teamPermission({ role: "reviewer", operation: "membersWrite" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/admin/);
    expect(!result.ok && result.reason).toMatch(/reviewer/);
  });

  it("the handlers really do gate at those roles", () => {
    expect(source("app/api/team/access-requests/route.ts")).toContain('minRole: "admin"');
    const members = source("app/api/team/members/route.ts");
    expect(members).toContain('minRole: "guest"');
    expect(members).toContain('minRole: "admin"');
  });
});

describe("WP-23 business settings use the real PATCH contract", () => {
  it("reads current values from the collection, since the route has no GET", () => {
    expect(source("app/api/businesses/[businessId]/route.ts")).not.toContain("export async function GET");
    const settings = businessFromList(
      { businesses: [{ id: BIZ, name: "Grandmix", currency: "try" }] },
      BIZ,
    );
    expect(settings).toEqual({ name: "Grandmix", currency: "TRY" });
    expect(businessFromList({ businesses: [] }, BIZ)).toBeNull();
  });

  it("refuses what the route refuses, before the round trip", () => {
    expect("error" in businessSettingsBody({ name: "A", currency: "USD" })).toBe(true);
    expect("error" in businessSettingsBody({ name: "Grandmix", currency: "  " })).toBe(true);
    expect(businessSettingsBody({ name: " Grandmix ", currency: "try" })).toEqual({
      name: "Grandmix",
      currency: "TRY",
    });
  });
});

describe("WP-23 assignment reuses the proven endpoints", () => {
  it("uses the real paths and the snake_case body", () => {
    expect(getProviderFetchPath("meta", BIZ)).toContain("/integrations/meta/ad-accounts");
    expect(getProviderFetchPath("google", BIZ)).toContain("/api/google/accessible-accounts");
    expect(getProviderSavePath("meta", BIZ)).toBe(`/businesses/${BIZ}/meta/assign-accounts`);
    // The handler reads `account_ids`, not `accountIds`.
    expect(source("lib/provider-assignment-service.ts")).toContain("account_ids");
  });

  it("adapts `{data, meta, notice}` and refuses anything else", () => {
    const ok = adaptAccessibleAccounts({
      data: [{ id: "act_1", name: "Main", assigned: true }, { id: "act_2", name: "Other" }],
      notice: "Two accounts are hidden by permissions.",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.accounts.map((account) => account.assigned)).toEqual([true, false]);
    expect(ok.notice).toMatch(/hidden/);
    // An unreadable body and an empty list lead to opposite conclusions.
    expect(adaptAccessibleAccounts({ accounts: [] }).ok).toBe(false);
  });
});

describe("WP-23 Plan stays static", () => {
  it("no manage surface calls the billing API or gates on a plan", () => {
    for (const file of [
      "components/zero-base/manage/manage-clients.tsx",
      "components/zero-base/manage/manage-views.tsx",
    ]) {
      expect(source(file), file).not.toContain("/api/billing");
    }
  });
});

describe("WP-23 GA4 / Search Console selection is bound to the real routes", () => {
  it("the routes and their verbs exist as claimed", async () => {
    const ga4List = await import("@/app/api/google-analytics/properties/route");
    const ga4Select = await import("@/app/api/google-analytics/select-property/route");
    const scList = await import("@/app/api/google-search-console/sites/route");
    const scSelect = await import("@/app/api/google-search-console/select-site/route");
    expect(typeof ga4List.GET).toBe("function");
    expect(typeof ga4Select.POST).toBe("function");
    expect(typeof scList.GET).toBe("function");
    expect(typeof scSelect.POST).toBe("function");
    // A prior report claimed this scope was absent. It was not.
    expect("POST" in ga4List).toBe(false);
  });

  it("GA4 discovery reports the selection, so it is its own read-back", () => {
    const text = source("app/api/google-analytics/properties/route.ts");
    expect(text).toContain("selectedPropertyId");
  });

  it("REGRESSION: the sites route reports no selection, so read-back goes elsewhere", () => {
    const text = source("app/api/google-search-console/sites/route.ts");
    // Only `sites`. Confirming a write from this body would be impossible.
    expect(text).not.toContain("selectedSiteUrl");
    // The integration record is what select-site writes.
    expect(source("app/api/google-search-console/select-site/route.ts")).toContain("provider_account_id");
  });

  it("select-site can answer 409 connection_changed, which saved nothing", () => {
    const text = source("app/api/google-search-console/select-site/route.ts");
    expect(text).toContain("connection_changed");
    expect(text).toContain("Nothing was saved");
  });

  it("both selection routes require collaborator", () => {
    expect(source("app/api/google-analytics/select-property/route.ts")).toContain('minRole: "collaborator"');
    expect(source("app/api/google-search-console/select-site/route.ts")).toContain('minRole: "collaborator"');
  });

  it("reuses the proven helpers rather than duplicating selection semantics", () => {
    const contract = source("lib/zero-base/manage/property-selection-contract.ts");
    expect(contract).toContain("ga4-property-picker-support");
    // The POST body is built by the proven helper, not re-derived here.
    expect(contract).not.toContain('method: "POST"');
  });

  it("adapts the sites body and refuses anything else", () => {
    const ok = adaptSearchConsoleSites({
      sites: [{ siteUrl: "https://x.test/", permissionLevel: "siteOwner", siteType: "url-prefix" }],
    });
    expect(ok.ok).toBe(true);
    expect(adaptSearchConsoleSites({ data: [] }).ok).toBe(false);
  });

  it("compares identifiers the way the routes normalize them", () => {
    // The Admin API returns `properties/12345`; the stored value is prefixed too.
    expect(samePropertyId("properties/12345", "12345")).toBe(true);
    expect(samePropertyId("properties/12345", "properties/67890")).toBe(false);
    expect(samePropertyId(null, "12345")).toBe(false);
    // select-site runs URLs through new URL().toString(), which can add a slash.
    expect(sameSiteUrl("https://x.test/", "https://x.test")).toBe(true);
    expect(sameSiteUrl("sc-domain:x.test", "https://x.test/")).toBe(false);
    expect(sameSiteUrl(null, "https://x.test")).toBe(false);
  });

  it("reads the stored site from the integration record", () => {
    expect(selectedSiteFromIntegration({ integration: { provider_account_id: "sc-domain:x.test" } })).toBe(
      "sc-domain:x.test",
    );
    // Not readable and nothing selected are different facts.
    expect(selectedSiteFromIntegration({ integration: null })).toBeNull();
    expect(selectedSiteFromIntegration({})).toBeNull();
  });

  it("mirrors the collaborator gate before the round trip", () => {
    expect(selectionPermission("collaborator").ok).toBe(true);
    expect(selectionPermission("admin").ok).toBe(true);
    const denied = selectionPermission("reviewer");
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.reason).toMatch(/collaborator role/);
  });
});
