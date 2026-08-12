import { describe, expect, it } from "vitest";

import {
  SEARCH_PERMISSION_EMPTY,
  SEARCH_RESULT_CAP,
  SEARCH_SCOPE_LABEL,
  SEARCH_ZERO_RESULT,
  canonicalHrefFor,
  toZeroBaseSearchEnvelope,
} from "@/lib/zero-base/search-adapter";
import type { EntitySearchResult } from "@/lib/entity-search";

function result(overrides: Partial<EntitySearchResult> = {}): EntitySearchResult {
  return {
    entityType: "campaign",
    entityId: "c_1",
    name: "Prospecting",
    businessId: "biz_1",
    matchKind: "contains",
    score: 1,
    ...overrides,
  } as EntitySearchResult;
}

describe("scope label", () => {
  it("is exactly the design's wording, implying no other provider", () => {
    expect(SEARCH_SCOPE_LABEL).toBe("Businesses + Meta entities");
    expect(SEARCH_SCOPE_LABEL).not.toMatch(/google|shopify|klaviyo|ga4|everything/i);
  });

  it("says what search does not cover when nothing matches", () => {
    expect(SEARCH_ZERO_RESULT).toContain("businesses and Meta entities only");
  });

  it("distinguishes no-permission from no-match", () => {
    expect(SEARCH_PERMISSION_EMPTY).not.toEqual(SEARCH_ZERO_RESULT);
    expect(SEARCH_PERMISSION_EMPTY).toMatch(/access/i);
  });
});

describe("canonical deep links", () => {
  it("routes each entity type to a canonical destination", () => {
    expect(canonicalHrefFor({ entityType: "business", entityId: "biz_1", businessId: "biz_1" })).toBe(
      "/switch-business/biz_1?next=%2Fapp%2Fhome",
    );
    expect(canonicalHrefFor({ entityType: "report", entityId: "r_9", businessId: "biz_1" })).toBe(
      "/switch-business/biz_1?next=%2Fapp%2Freports%2Fr_9",
    );
    for (const entityType of ["campaign", "adset", "ad"] as const) {
      expect(canonicalHrefFor({ entityType, entityId: "x", businessId: "biz_1" })).toBe(
        "/switch-business/biz_1?next=%2Fapp%2Fmeta%2Fdecisions",
      );
    }
  });

  it("carries the entity's own business, never another", () => {
    const href = canonicalHrefFor({ entityType: "report", entityId: "r_9", businessId: "biz_2" });
    expect(href).toContain("/switch-business/biz_2?");
    expect(href).not.toContain("biz_1");
  });

  it("returns null rather than guessing when the business is unknown", () => {
    expect(canonicalHrefFor({ entityType: "ad", entityId: "a_1", businessId: "" })).toBeNull();
  });

  it("emits only authorized transitions to clean /app routes, never legacy paths", () => {
    const envelope = toZeroBaseSearchEnvelope([result(), result({ entityType: "business", entityId: "biz_1" })]);
    for (const item of envelope.items) {
      expect(item.href).toMatch(/^\/switch-business\//);
      expect(decodeURIComponent(item.href!)).toContain("next=/app/");
      expect(item.href).not.toMatch(/\/platforms\/|\/overview|\/dashboard/);
    }
  });
});

describe("cap and disclosure", () => {
  it("caps at 50 and states X of Y", () => {
    const many = Array.from({ length: 214 }, (_, i) => result({ entityId: `c_${i}` }));
    const envelope = toZeroBaseSearchEnvelope(many);

    expect(SEARCH_RESULT_CAP).toBe(50);
    expect(envelope.items).toHaveLength(50);
    expect(envelope.servedCount).toBe(50);
    expect(envelope.totalCount).toBe(214);
    expect(envelope.truncated).toBe(true);
    expect(envelope.disclosure).toContain("top 50 of 214");
  });

  it("discloses nothing when nothing was withheld", () => {
    const envelope = toZeroBaseSearchEnvelope([result(), result({ entityId: "c_2" })]);
    expect(envelope.truncated).toBe(false);
    expect(envelope.disclosure).toBeNull();
    expect(envelope.servedCount).toBe(2);
    expect(envelope.totalCount).toBe(2);
  });

  it("reports an empty result honestly", () => {
    const envelope = toZeroBaseSearchEnvelope([]);
    expect(envelope.items).toEqual([]);
    expect(envelope.totalCount).toBe(0);
    expect(envelope.truncated).toBe(false);
  });

  it("groups results so a row's kind is visible", () => {
    const envelope = toZeroBaseSearchEnvelope([
      result({ entityType: "business", entityId: "biz_1" }),
      result({ entityType: "ad", entityId: "a_1" }),
    ]);
    expect(envelope.items.map((item) => item.group)).toEqual(["Businesses", "Meta ads"]);
  });

  it("falls back to the id rather than rendering a blank row", () => {
    const envelope = toZeroBaseSearchEnvelope([result({ name: null as unknown as string })]);
    expect(envelope.items[0].name).toBe("c_1");
  });
});
