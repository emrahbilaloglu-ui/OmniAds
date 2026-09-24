import { describe, expect, it } from "vitest";
import {
  buildMetaCreativeDayPurchaseEvidence,
  buildMetaCreativeDayPurchasesSql,
  constrainMetaCreativeDayPurchaseEvidenceToScalar,
  mergeMetaCreativeDayPurchaseEvidence,
  readMetaCreativeDayPurchases,
} from "./creative-day-purchase-evidence";

describe("creative-day purchase evidence", () => {
  it("treats omitted actions as provider zero only for a complete actions request", () => {
    expect(buildMetaCreativeDayPurchaseEvidence(undefined)).toMatchObject({
      state: "unmeasurable", reason: "actions_absent",
    });
    const zero = buildMetaCreativeDayPurchaseEvidence(undefined,
      { completeActionsRequest: true });
    expect(zero).toMatchObject({ state: "measured", value: 0 });
    expect(readMetaCreativeDayPurchases({ purchase_evidence: zero }, 0)).toBe(0);
    expect(readMetaCreativeDayPurchases({ purchase_evidence: zero }, 1)).toBeNull();
    expect(buildMetaCreativeDayPurchaseEvidence(null,
      { completeActionsRequest: true })).toMatchObject({ state: "unreadable" });
  });

  it("deduplicates agreeing aliases and refuses conflicting or malformed counts", () => {
    const agreed = buildMetaCreativeDayPurchaseEvidence([
      { action_type: "purchase", value: "1" },
      { action_type: "omni_purchase", value: "1" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "1" },
    ], { completeActionsRequest: true });
    expect(agreed).toMatchObject({ state: "measured", value: 1 });
    for (const actions of [
      [{ action_type: "purchase", value: "1" },
        { action_type: "omni_purchase", value: "2" }],
      [{ action_type: "purchase", value: "1" },
        { action_type: "purchase", value: "1" }],
      [{ action_type: "purchase", value: "1abc" }],
    ]) {
      expect(buildMetaCreativeDayPurchaseEvidence(actions,
        { completeActionsRequest: true })).toMatchObject({ state: "unreadable" });
    }
  });

  it("keeps folds and finalized-scalar conflicts incomplete", () => {
    const zero = buildMetaCreativeDayPurchaseEvidence([], { completeActionsRequest: true });
    const one = buildMetaCreativeDayPurchaseEvidence([
      { action_type: "purchase", value: "1" },
    ], { completeActionsRequest: true });
    expect(mergeMetaCreativeDayPurchaseEvidence(zero, one)).toMatchObject({
      state: "measured", value: 1,
    });
    expect(mergeMetaCreativeDayPurchaseEvidence(zero, null)).toMatchObject({
      state: "incomplete", reason: "evidence_absent",
    });
    expect(constrainMetaCreativeDayPurchaseEvidenceToScalar(one, 0)).toMatchObject({
      state: "incomplete", reason: "source_scalar_conflict",
    });
  });

  it("SQL reads only a matching measured stamp and bounds digits before numeric cast", () => {
    const sql = buildMetaCreativeDayPurchasesSql({ payloadExpression: "d.payload_json",
      conversionsExpression: "d.conversions" });
    expect(sql).toContain("meta-creative-day-purchase-evidence.v1");
    expect(sql).toContain("AND (d.payload_json->'purchase_evidence'->>'value')::numeric = d.conversions");
    expect(sql).toContain("~ '^[0-9]{1,16}$'");
    expect(sql.indexOf("~ '^[0-9]{1,16}$'")).toBeLessThan(sql.indexOf("::numeric"));
    expect(() => buildMetaCreativeDayPurchasesSql({ payloadExpression: "d.payload_json;DROP",
      conversionsExpression: "d.conversions" })).toThrow();
  });
});
