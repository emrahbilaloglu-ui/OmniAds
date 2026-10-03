import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db";
import { assertInlineCampaignContextArchiveRow, inspectNativeCampaignContextImmutability,
  nativeCampaignContextSql, requireNativeCampaignContext, NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL,
} from "../native-campaign-context-storage";

describe("native campaign context compatibility", () => {
  it.each([null, undefined, 0, "{}", [], true])("refuses absent/non-object contents instead of empty data: %j", value => {
    expect(() => requireNativeCampaignContext(value)).toThrow(/unavailable or inconsistent/);
  });
  it("preserves explicitly recorded empty context and original clocks", () => {
    const context = { sourceUpdatedAt: "2026-09-24T07:00:00.000001Z", campaignId: "abc" };
    expect(requireNativeCampaignContext(context)).toBe(context);
    expect(requireNativeCampaignContext({})).toEqual({});
  });
  it.each(["e;DROP TABLE x", "e.x", "e /*", "", "1e", "E"]) ("refuses interpolated unsafe aliases: %s", alias => {
    expect(() => nativeCampaignContextSql(alias)).toThrow(/Invalid/);
  });
  it("uses tenant-bound exact lookup and refuses both representations", () => {
    const sql = nativeCampaignContextSql("evaluation");
    expect(sql).toContain("campaign_object.business_ref_id = evaluation.business_ref_id");
    expect(sql).toContain("campaign_object.payload_sha256 = evaluation.campaign_context_ref");
    expect(sql).toContain("WHEN evaluation.campaign_context_json IS NULL");
    expect(sql).toContain("ELSE NULL");
    expect(sql).not.toContain("'{}'");
  });
  it("retains old inline archives and refuses new omitted object roots", () => {
    expect(() => assertInlineCampaignContextArchiveRow({ campaign_context_json: {} })).not.toThrow();
    expect(() => assertInlineCampaignContextArchiveRow({ campaign_context_json: {}, campaign_context_ref: null })).not.toThrow();
    expect(() => assertInlineCampaignContextArchiveRow({ campaign_context_json: null, campaign_context_ref: "\\x123" })).toThrow(/new archive contract/);
  });
  it("R1 never drops the old inline NOT NULL or rewrites evaluation data", () => {
    expect(NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL).not.toMatch(/DROP NOT NULL|UPDATE engine_v3_ad_decision_evaluations|DELETE FROM|VALIDATE CONSTRAINT/);
    expect(NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL).toContain("ON DELETE RESTRICT NOT VALID");
  });
  const trigger = { enabled: "O", trigger_type: 27, function_name: "refuse_native_campaign_context_object_mutation",
    security_definer: false, function_result: "trigger",
    function_source: NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL.match(/LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$/)![1]! };
  it("recognizes the pinned immutable trigger", async () => {
    expect(await inspectNativeCampaignContextImmutability({ query: async () => [trigger] } as unknown as DbClient)).toBe(true);
  });
  it.each([{ enabled: "D" }, { trigger_type: 19 }, { function_name: "impostor" },
    { function_source: "BEGIN RETURN OLD; END;" }, { security_definer: true }, { function_result: "void" }])(
    "rejects altered/disabled same-name trigger: %j", async delta => {
      expect(await inspectNativeCampaignContextImmutability({ query: async () => [{ ...trigger, ...delta }] } as unknown as DbClient)).toBe(false);
    });
});
