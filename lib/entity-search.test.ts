import { describe, expect, it } from "vitest";
import {
  isSearchableQuery,
  normalizeQuery,
  rankEntitySearchResults,
  type EntitySearchCandidate,
} from "@/lib/entity-search";

const candidates: EntitySearchCandidate[] = [
  {
    entityType: "campaign",
    entityId: "23849",
    name: "Grandmix Prospecting",
    businessId: "biz-1",
    providerAccountId: "act_805150454596350",
    status: "ACTIVE",
  },
  {
    entityType: "adset",
    entityId: "9911",
    name: "Prospecting Hook Tests",
    businessId: "biz-1",
    providerAccountId: "act_805150454596350",
    status: "PAUSED",
  },
  {
    entityType: "ad",
    entityId: "7742",
    name: "Grandmix UGC v3",
    businessId: "biz-1",
    providerAccountId: "act_805150454596350",
    status: "ACTIVE",
  },
  {
    entityType: "business",
    entityId: "biz-1",
    name: "Grandmix",
    businessId: "biz-1",
  },
  {
    entityType: "report",
    entityId: "rep-9",
    name: "Grandmix weekly",
    businessId: "biz-1",
  },
];

describe("query handling", () => {
  it("normalizes case and spacing", () => {
    expect(normalizeQuery("  Grand   MIX ")).toBe("grand mix");
  });

  it("refuses a query too short to be meaningful", () => {
    expect(isSearchableQuery("g")).toBe(false);
    expect(isSearchableQuery("  ")).toBe(false);
    expect(isSearchableQuery("gr")).toBe(true);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(rankEntitySearchResults(candidates, "")).toEqual([]);
    expect(rankEntitySearchResults(candidates, "   ")).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts an exact id match first", () => {
    const [first] = rankEntitySearchResults(candidates, "9911");
    expect(first.entityId).toBe("9911");
    expect(first.matchKind).toBe("exact_id");
  });

  it("matches a provider account id with or without its prefix", () => {
    const withPrefix = rankEntitySearchResults(
      [{ entityType: "campaign", entityId: "act_123", name: null, businessId: "b" }],
      "123",
    );
    expect(withPrefix[0]?.matchKind).toBe("exact_id");
  });

  it("puts an exact name above a prefix match", () => {
    const results = rankEntitySearchResults(candidates, "grandmix");
    expect(results[0].matchKind).toBe("exact_name");
    expect(results[0].name).toBe("Grandmix");
    expect(results.slice(1).every((r) => r.matchKind === "prefix")).toBe(true);
  });

  it("puts a prefix match above a mid-name substring match", () => {
    const results = rankEntitySearchResults(
      [
        { entityType: "campaign", entityId: "1", name: "Winter sale", businessId: "b" },
        { entityType: "campaign", entityId: "2", name: "Retarget winter", businessId: "b" },
      ],
      "winter",
    );
    expect(results.map((r) => r.matchKind)).toEqual(["prefix", "contains"]);
    expect(results[0].entityId).toBe("1");
  });

  it("finds a name that only matches in the middle", () => {
    const results = rankEntitySearchResults(candidates, "hook");
    expect(results.map((r) => r.entityId)).toContain("9911");
    expect(results[0].matchKind).toBe("contains");
  });

  it("orders equal matches by container, then name, so results are stable", () => {
    const results = rankEntitySearchResults(candidates, "grandmix");
    const equalBand = results.filter((r) => r.matchKind === "prefix");
    const types = equalBand.map((r) => r.entityType);
    expect(types).toEqual([...types].sort((a, b) =>
      ["business", "campaign", "adset", "ad", "report"].indexOf(a) -
      ["business", "campaign", "adset", "ad", "report"].indexOf(b)));
  });

  it("respects the result limit", () => {
    expect(rankEntitySearchResults(candidates, "grandmix", 2)).toHaveLength(2);
  });

  it("excludes candidates that do not match at all", () => {
    expect(rankEntitySearchResults(candidates, "zzzz")).toEqual([]);
  });
});

describe("deep links keep the destination in scope", () => {
  it("carries business and provider account into a decision link", () => {
    const [campaign] = rankEntitySearchResults(candidates, "23849");
    expect(campaign.href).toContain("businessId=biz-1");
    expect(campaign.href).toContain("providerAccountId=act_805150454596350");
    expect(campaign.href).toContain("entityType=campaign");
    expect(campaign.href).toContain("entityId=23849");
  });

  it("sends a business to its own overview", () => {
    const business = rankEntitySearchResults(candidates, "grandmix").find(
      (r) => r.entityType === "business",
    );
    expect(business?.href).toBe("/overview?businessId=biz-1");
  });

  it("sends a report to the report itself", () => {
    const report = rankEntitySearchResults(candidates, "weekly")[0];
    expect(report.href).toBe("/reports/rep-9");
  });

  it("explains why each result matched", () => {
    for (const result of rankEntitySearchResults(candidates, "grandmix")) {
      expect(["exact_id", "exact_name", "prefix", "contains"]).toContain(result.matchKind);
    }
  });
});
