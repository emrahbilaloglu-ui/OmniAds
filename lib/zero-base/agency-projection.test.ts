import { describe, expect, it } from "vitest";

import {
  AGENCY_ACTIVITY_NOTE,
  AGENCY_CURRENCY_NOTE,
  AGENCY_PAGE_SIZE,
  AGENCY_ROW_KEYS,
  buildAgencyDirectoryPage,
  compareAgencyRows,
  findForbiddenAgencyKeys,
  normalizeBusinessName,
  type AgencySourceBusiness,
} from "@/lib/zero-base/agency-projection";

function business(overrides: Partial<AgencySourceBusiness> = {}): AgencySourceBusiness {
  return {
    id: "biz_1",
    name: "Acme",
    role: "admin",
    membershipStatus: "active",
    currency: "USD",
    sourceUpdatedAt: "2026-08-10T12:00:00Z",
    ...overrides,
  };
}

describe("key allowlist", () => {
  it("emits only the seven permitted keys", () => {
    const page = buildAgencyDirectoryPage([business()]);
    expect(Object.keys(page.items[0]).sort()).toEqual([...AGENCY_ROW_KEYS].sort());
  });

  it("contains no money, severity, ranking or work-count key at any depth", () => {
    const page = buildAgencyDirectoryPage([
      business(),
      business({ id: "biz_2", name: "Grandmix" }),
    ]);
    expect(findForbiddenAgencyKeys(page)).toEqual([]);
  });

  it("detects a forbidden key even when nested, which is how one would survive", () => {
    const contaminated = {
      items: [{ businessId: "biz_1", meta: { nested: { spend: 8214 } } }],
    };
    expect(findForbiddenAgencyKeys(contaminated)).toEqual(["items[0].meta.nested.spend"]);
  });

  it("permits a row count while still forbidding a monetary total", () => {
    // `totalCount` is pagination, not money. `totalSpend` is money and is
    // caught by its own term, so banning the bare word "total" would forbid
    // honest pagination and catch nothing extra.
    expect(findForbiddenAgencyKeys({ totalCount: 50 })).toEqual([]);
    expect(findForbiddenAgencyKeys({ totalSpend: 8214 })).toEqual(["totalSpend"]);
    expect(findForbiddenAgencyKeys({ totalRevenue: 1 })).toEqual(["totalRevenue"]);
  });

  it("catches near-miss names rather than only exact matches", () => {
    expect(findForbiddenAgencyKeys({ totalSpend: 1 })).toContain("totalSpend");
    expect(findForbiddenAgencyKeys({ anomalyCount: 1 })).toContain("anomalyCount");
    expect(findForbiddenAgencyKeys({ riskScore: 1 })).toContain("riskScore");
    expect(findForbiddenAgencyKeys({ pendingCount: 1 })).toContain("pendingCount");
  });
});

describe("alphabetical ordering", () => {
  it("sorts by normalised name, not by any implied urgency", () => {
    const page = buildAgencyDirectoryPage([
      business({ id: "b", name: "zeta" }),
      business({ id: "a", name: "Álpha" }),
      business({ id: "c", name: "Beta" }),
    ]);
    expect(page.items.map((row) => row.name)).toEqual(["Álpha", "Beta", "zeta"]);
  });

  it("normalises case and accents so they sort together", () => {
    expect(normalizeBusinessName("Ácme  ")).toBe("acme");
  });

  it("breaks ties by id so paging is stable", () => {
    const a = { businessId: "biz_2", name: "Same" } as never;
    const b = { businessId: "biz_1", name: "Same" } as never;
    expect(compareAgencyRows(a, b)).toBeGreaterThan(0);
    expect(compareAgencyRows(b, a)).toBeLessThan(0);
    // Total order: comparing a row with itself is zero.
    expect(compareAgencyRows(a, a)).toBe(0);
  });
});

describe("pagination", () => {
  const fifty = Array.from({ length: 50 }, (_, i) =>
    business({ id: `biz_${String(i).padStart(2, "0")}`, name: `Client ${String(i).padStart(2, "0")}` }),
  );

  it("serves a full page and reports what is left", () => {
    const page = buildAgencyDirectoryPage(fifty, { pageSize: 20 });
    expect(page.items).toHaveLength(20);
    expect(page.totalCount).toBe(50);
    expect(page.truncated).toBe(true);
    expect(page.disclosure).toBe("Showing 20 of 50 clients.");
  });

  it("scans 50 clients without repeating or dropping a row", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: ReturnType<typeof buildAgencyDirectoryPage> = buildAgencyDirectoryPage(fifty, {
        pageSize: 20,
        cursor,
      });
      seen.push(...page.items.map((row) => row.businessId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it("discloses nothing on the last page", () => {
    const page = buildAgencyDirectoryPage(fifty.slice(0, 5), { pageSize: 20 });
    expect(page.truncated).toBe(false);
    expect(page.disclosure).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("defaults to a 50-client page", () => {
    expect(AGENCY_PAGE_SIZE).toBe(50);
  });
});

describe("search", () => {
  it("filters the served page by name", () => {
    const page = buildAgencyDirectoryPage(
      [business({ id: "a", name: "Acme" }), business({ id: "b", name: "Grandmix" })],
      { query: "grand" },
    );
    expect(page.items.map((row) => row.name)).toEqual(["Grandmix"]);
    expect(page.totalCount).toBe(1);
  });

  it("is accent- and case-insensitive", () => {
    const page = buildAgencyDirectoryPage([business({ name: "Ácme" })], { query: "acme" });
    expect(page.items).toHaveLength(1);
  });
});

describe("honest labelling", () => {
  it("calls currency configured, not observed", () => {
    expect(AGENCY_CURRENCY_NOTE).toMatch(/configured/i);
    expect(AGENCY_CURRENCY_NOTE).not.toMatch(/proven|verified|observed provider value is/i);
  });

  it("calls source updates activity, not health", () => {
    expect(AGENCY_ACTIVITY_NOTE).toMatch(/activity, not a health signal/i);
  });

  it("carries the configured currency through without reinterpreting it", () => {
    const page = buildAgencyDirectoryPage([business({ currency: null })]);
    expect(page.items[0].configuredCurrency).toBeNull();
  });
});

describe("no fan-out", () => {
  it("builds a page from already-authorized input with no I/O", () => {
    // The function takes plain data and returns plain data: there is no client
    // to call per row, which is how a 50-client directory would become 50
    // parallel provider reads.
    expect(buildAgencyDirectoryPage.length).toBeLessThanOrEqual(2);
    const page = buildAgencyDirectoryPage([business()]);
    expect(page.items[0].href).toBe("/switch-business/biz_1?next=%2Fapp%2Fhome");
  });
});
