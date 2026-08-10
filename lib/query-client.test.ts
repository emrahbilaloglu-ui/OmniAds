import { describe, expect, it } from "vitest";
import { QUERY_STALE_TIME_MS, isQueryRevalidationEnabled } from "@/lib/query-client";

/**
 * Every revalidation trigger used to be disabled, so a tab left open through a
 * sync cycle kept presenting the numbers it loaded hours earlier as current.
 */
describe("query revalidation policy", () => {
  it("revalidates by default so open tabs do not serve frozen data", () => {
    expect(isQueryRevalidationEnabled({})).toBe(true);
    expect(isQueryRevalidationEnabled({ NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION: "0" })).toBe(true);
  });

  it("can be switched off by exactly one documented runtime flag", () => {
    expect(isQueryRevalidationEnabled({ NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION: "1" })).toBe(false);
    expect(isQueryRevalidationEnabled({ NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION: " 1 " })).toBe(false);
  });

  it("does not treat an unrelated value as a kill switch", () => {
    expect(isQueryRevalidationEnabled({ NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION: "true" })).toBe(true);
    expect(isQueryRevalidationEnabled({ NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION: "" })).toBe(true);
  });

  it("keeps a stale window so focus revalidation cannot become a request storm", () => {
    expect(QUERY_STALE_TIME_MS).toBeGreaterThanOrEqual(30_000);
  });
});
