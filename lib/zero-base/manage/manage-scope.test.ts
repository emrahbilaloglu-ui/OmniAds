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
      shopify: "app/api/oauth/shopify/start/route.ts",
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
    const page = source("app/(dashboard)/integrations/callback/[provider]/page.tsx");
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
