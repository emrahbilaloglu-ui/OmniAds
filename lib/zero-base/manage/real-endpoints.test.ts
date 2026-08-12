/**
 * WP-23 boundaries against the ACTUAL route modules.
 *
 * A transition audit found three boundaries that could never work: a reconnect
 * POST to a route with no POST, a cost-model read that ignored the `{costModel}`
 * wrapper and asked for fields it does not carry, and a deletion read-back
 * against a route with no GET. Each suite below asserts the real method set or
 * the real payload nesting, so a wrong method or wrong wrapper fails here.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OAUTH_START_PROVIDERS,
  adaptCommercialTarget,
  adaptCostModel,
  adaptRecommendedMode,
  confirmDeletionFromList,
  oauthStartUrl,
} from "@/lib/zero-base/manage/manage-contract";

const ROOT = process.cwd();

describe("/api/integrations has no POST, so reconnect is an OAuth start", () => {
  it("exports GET and DELETE only", async () => {
    const mod = (await import("@/app/api/integrations/route")) as Record<string, unknown>;
    expect(typeof mod.GET).toBe("function");
    expect(typeof mod.DELETE).toBe("function");
    // The defect: the client used to POST here and always got 405.
    expect(mod.POST).toBeUndefined();
    expect(mod.PATCH).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
  });

  it("builds an OAuth start URL that points at a real route file", () => {
    for (const [provider, base] of Object.entries(OAUTH_START_PROVIDERS)) {
      const url = oauthStartUrl({ provider, businessId: "biz-1" });
      expect(url, provider).not.toBeNull();
      expect(url!.startsWith(base), provider).toBe(true);
      expect(url).toContain("businessId=biz-1");
      // The route must exist on disk, or the link 404s.
      expect(existsSync(path.join(ROOT, "app", `${base.replace(/^\/api/, "api")}`, "route.ts")), base).toBe(true);
    }
  });

  it("returns null for a provider with no start route rather than a broken link", () => {
    expect(oauthStartUrl({ provider: "tiktok", businessId: "biz-1" })).toBeNull();
  });

  it("escapes the business id", () => {
    expect(oauthStartUrl({ provider: "meta", businessId: "biz/1" })).toContain("biz%2F1");
  });
});

describe("/api/business-cost-model nests its payload under costModel", () => {
  const REAL = {
    costModel: { cogsPercent: 0.42, shippingPercent: 0.08, feePercent: 0.03, fixedCost: 1200 },
  };

  it("reads the nested model", () => {
    expect(adaptCostModel(REAL)).toEqual({
      cogsPercent: 0.42,
      shippingPercent: 0.08,
      feePercent: 0.03,
      fixedCost: 1200,
    });
  });

  it("REGRESSION: the wrapper itself carries none of those fields", () => {
    // The old client read the wrapper directly, so every field was undefined.
    expect("cogsPercent" in REAL).toBe(false);
    expect(adaptCostModel({ cogsPercent: 0.42 })).toBeNull();
  });

  it("REGRESSION: the cost model has no targetRoas or recommendedMode", () => {
    expect("targetRoas" in REAL.costModel).toBe(false);
    expect("recommendedMode" in REAL.costModel).toBe(false);
  });

  it("keeps an unserved field null rather than zero", () => {
    expect(adaptCostModel({ costModel: {} })?.cogsPercent).toBeNull();
  });
});

describe("commercial target and recommended mode come from their own endpoints", () => {
  it("reads targetRoas from the commercial snapshot", () => {
    const result = adaptCommercialTarget({
      snapshot: { targetRoas: 2.6 },
      revision: "r1",
      permissions: { canEdit: true, reason: null, role: "admin" },
    });
    expect(result).toEqual({ targetRoas: 2.6, canEdit: true });
  });

  it("refuses a body with no snapshot", () => {
    expect(adaptCommercialTarget({ permissions: {} })).toBeNull();
  });

  it("reads recommendedMode from the operating-mode payload", () => {
    expect(adaptRecommendedMode({ recommendedMode: "Peak / Promo" })).toBe("Peak / Promo");
    expect(adaptRecommendedMode({})).toBeNull();
  });
});

describe("/api/businesses/[businessId] has no GET, so deletion confirms from the list", () => {
  it("exports PATCH and DELETE only", async () => {
    const mod = (await import("@/app/api/businesses/[businessId]/route")) as Record<string, unknown>;
    expect(typeof mod.PATCH).toBe("function");
    expect(typeof mod.DELETE).toBe("function");
    // The defect: the read-back GET here always answered 405.
    expect(mod.GET).toBeUndefined();
  });

  it("the list endpoint does have a GET to confirm against", async () => {
    const mod = (await import("@/app/api/businesses/route")) as Record<string, unknown>;
    expect(typeof mod.GET).toBe("function");
  });

  it("confirms only when the deleted id is absent from the list", () => {
    expect(
      confirmDeletionFromList({
        listOk: true,
        businesses: [{ id: "other" }],
        deletedId: "biz-1",
      }),
    ).toBe(true);
  });

  it("refuses to confirm while the id is still listed", () => {
    expect(
      confirmDeletionFromList({
        listOk: true,
        businesses: [{ id: "biz-1" }],
        deletedId: "biz-1",
      }),
    ).toBe(false);
  });

  it("stays unknown when the list read failed", () => {
    // Null, not true: a failed read that happens to yield no rows would
    // otherwise be a false confirmation.
    expect(confirmDeletionFromList({ listOk: false, businesses: null, deletedId: "biz-1" })).toBeNull();
    expect(confirmDeletionFromList({ listOk: true, businesses: null, deletedId: "biz-1" })).toBeNull();
  });
});

describe("the shipped Manage client uses no method the routes lack", () => {
  it("never POSTs to /api/integrations", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      path.join(ROOT, "components", "zero-base", "manage", "manage-clients.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    expect(/\/api\/integrations[^"'`]*["'`],\s*\{\s*method:\s*"POST"/.test(source)).toBe(false);
    // And it does reach for the OAuth start instead.
    expect(source).toContain("oauthStartUrl");
  });

  it("reads the three economics endpoints rather than one", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      path.join(ROOT, "components", "zero-base", "manage", "manage-clients.tsx"),
      "utf8",
    );
    for (const endpoint of [
      "/api/business-cost-model",
      "/api/business-commercial-settings",
      "/api/business-operating-mode",
    ]) {
      expect(source.includes(endpoint), endpoint).toBe(true);
    }
  });

  it("confirms deletion against the list endpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      path.join(ROOT, "components", "zero-base", "manage", "manage-clients.tsx"),
      "utf8",
    );
    expect(source).toContain("confirmDeletionFromList");
    expect(source).toContain('fetch("/api/businesses"');
  });
});
