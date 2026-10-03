import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import {
  INSERT_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY,
  READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY,
  nativeCampaignContextReferenceWritesEnabled,
  persistNativeCampaignContextReferences,
} from "../native-campaign-context-writer";

afterEach(() => vi.unstubAllEnvs());
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const digest = "ab".repeat(32);
const inputs = [{ business_ref_id: tenant, campaign_context_json: { computedAt: "2026-10-03T10:01:02.123456Z", role: "prospecting", nested: { ü: "İ" } } }];
const valid = { ordinal: 1, reference_hex: digest, original_payload_matches: true };
function dbReturning(rows: unknown[]) {
  const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
  return { query, db: { query } as unknown as Pick<DbClient, "query"> };
}

describe("native campaign context reference linkage", () => {
  it("remains opt-in and rejects non-exact environment values", () => {
    vi.stubEnv("ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED", undefined);
    expect(nativeCampaignContextReferenceWritesEnabled()).toBe(false);
    for (const value of ["TRUE", "1", " true", "false"]) {
      vi.stubEnv("ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED", value);
      expect(nativeCampaignContextReferenceWritesEnabled()).toBe(false);
    }
    vi.stubEnv("ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED", "true");
    expect(nativeCampaignContextReferenceWritesEnabled()).toBe(true);
  });
  it("issues no query for an empty batch", async () => {
    const { db, query } = dbReturning([]);
    expect(await persistNativeCampaignContextReferences(db, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it.each([null, [], "{}", 17])("refuses an absent/non-object original payload before a write: %j", async (value) => {
    const { db, query } = dbReturning([valid]);
    await expect(persistNativeCampaignContextReferences(db, [{ business_ref_id: tenant, campaign_context_json: value }])).rejects.toThrow(/unavailable/);
    expect(query).not.toHaveBeenCalled();
  });
  it("preserves each original payload while resolving the same immutable reference for repeated content", async () => {
    const two = [inputs[0], structuredClone(inputs[0])];
    const before = JSON.stringify(two);
    const { db, query } = dbReturning([valid, { ...valid, ordinal: 2 }]);
    expect(await persistNativeCampaignContextReferences(db, two)).toEqual([digest, digest]);
    expect(query.mock.calls).toEqual([
      [INSERT_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY, [before]],
      [READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY, [before]],
    ]);
    expect(JSON.stringify(two)).toBe(before);
  });
  it.each([
    [], [valid, valid], [{ ...valid, ordinal: 2 }], [{ ...valid, ordinal: "1" }],
    [{ ...valid, original_payload_matches: false }], [{ ...valid, original_payload_matches: "true" }],
    [{ ...valid, reference_hex: digest.toUpperCase() }], [{ ...valid, reference_hex: digest.slice(2) }],
    [{ ...valid, reference_hex: null }],
  ].map((rows) => ({ rows })))("refuses missing, duplicate, unmatched or malformed storage links: %j", async ({ rows }) => {
    const { db } = dbReturning(rows);
    await expect(persistNativeCampaignContextReferences(db, inputs)).rejects.toThrow(/linkage incomplete|identity differs/);
  });
  it("propagates insertion failure without a fallback reference or equality read", async () => {
    const { db, query } = dbReturning([valid]);
    query.mockReset().mockRejectedValue(new Error("object insert refused"));
    await expect(persistNativeCampaignContextReferences(db, inputs)).rejects.toThrow("object insert refused");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
