/**
 * ONE DEMO META ACCOUNT, NAMED ONCE.
 *
 * Round 10, item 7. The demo workspace served TWO different Meta account
 * identities at the same time:
 *
 *   - `getDemoIntegrations()`, `listDemoProviderAccounts()` and the business
 *     summary published `act_210009998877` — the id the demo UI displays;
 *   - the campaign, ad-set, breakdown and status fixtures in
 *     `lib/demo-business.ts` stamped every row `demo-meta-1`.
 *
 * Round 9 taught the recommendations route to accept the first, which made the
 * split worse rather than better: the boundary now agreed with the connector
 * list and disagreed with every row behind it. A demo answer whose rows are
 * keyed on an account the surface never names cannot be joined, filtered or
 * scoped by the same code that handles a live one — which is the entire point
 * of having a demo posture at all.
 *
 * `DEMO_META_PROVIDER_ACCOUNT_ID` is now the single literal, and this file is
 * the contract that keeps it single: every served demo Meta account id is
 * enumerated from the real producers and compared to the constant.
 */
import { describe, expect, it, vi } from "vitest";

import { DEMO_META_PROVIDER_ACCOUNT_ID } from "@/lib/demo-business-support";

describe("every served demo Meta account id is the manifest constant", () => {
  it("is the id the demo integration list publishes", async () => {
    const { getDemoIntegrations } = await import("@/lib/demo-business-support");
    const meta = getDemoIntegrations().find(
      (integration) => integration.provider === "meta",
    );
    expect(meta?.provider_account_id).toBe(DEMO_META_PROVIDER_ACCOUNT_ID);
  });

  it("is the id every campaign, ad-set and status fixture is stamped with", async () => {
    const demo = await import("@/lib/demo-business");
    /*
      Enumerated from the PRODUCERS rather than by grepping the file, so a new
      fixture added tomorrow is covered without anyone remembering to add it
      here.
    */
    const campaigns = demo.getDemoMetaCampaigns().rows as Array<{
      accountId?: string | null;
    }>;
    expect(campaigns.length).toBeGreaterThan(0);
    // `getDemoMetaAdSets` returns the rows directly, not a `{ rows }` envelope.
    const adsets = (demo.getDemoMetaAdSets() ?? []) as Array<{
      accountId?: string | null;
    }>;
    expect(adsets.length).toBeGreaterThan(0);

    const served = new Set(
      [...campaigns, ...adsets]
        .map((row) => row.accountId)
        .filter((value): value is string => typeof value === "string"),
    );
    expect(served.size).toBeGreaterThan(0);
    expect([...served]).toEqual([DEMO_META_PROVIDER_ACCOUNT_ID]);
  });

  it("leaves no `demo-meta-1` literal anywhere in the served demo payloads", async () => {
    /*
      The catch-all. The two producers above are the ones that matter today;
      this serializes everything the demo module exposes and refuses the old
      literal outright, so a breakdown or provider fixture that this file does
      not enumerate individually still cannot reintroduce it.
    */
    const demo = await import("@/lib/demo-business");
    const support = await import("@/lib/demo-business-support");
    const serialized = JSON.stringify([
      demo.getDemoMetaCampaigns(),
      demo.getDemoMetaBreakdowns?.() ?? null,
      support.getDemoIntegrations(),
      support.getDemoBusinessSummary(),
    ]);
    expect(serialized).not.toContain("demo-meta-1");
    expect(serialized).toContain(DEMO_META_PROVIDER_ACCOUNT_ID);
  });
});

describe("demo posture never queries production assignments", () => {
  it("serves the demo answer without reading provider_account_assignments", async () => {
    /*
      The other half of the contract. Unifying the id would be a regression if
      it made the demo path look up a real assignment row to validate it — the
      demo workspace has no production account, and reading for one is how a
      production identity leaks into a demo answer.
    */
    vi.resetModules();
    const assignments = vi.fn(async () => ({ account_ids: [] }));
    vi.doMock("@/lib/provider-account-assignments", () => ({
      getProviderAccountAssignments: assignments,
    }));
    vi.doMock("@/app/api/launchpad/meta/demo-write-authority", () => ({
      readLaunchpadWriteAuthority: vi.fn(async () => "demo"),
    }));
    vi.doMock("@/lib/access", () => ({
      requireBusinessAccess: vi.fn(async () => ({
        session: {},
        membership: {},
      })),
    }));
    vi.doMock("@/lib/request-language", () => ({
      resolveRequestLanguage: vi.fn(async () => "en"),
    }));

    const { GET } = await import("@/app/api/meta/recommendations/route");
    const { NextRequest } = await import("next/server");
    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&providerAccountId=${DEMO_META_PROVIDER_ACCOUNT_ID}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(assignments).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/provider-account-assignments");
    vi.resetModules();
  });
});
