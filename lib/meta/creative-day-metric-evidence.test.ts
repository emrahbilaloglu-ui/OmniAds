/**
 * The creative-day measurement stamp: what the writer records per stage, how
 * two stamps fold, and the SQL the decision readers take their values from.
 *
 * The acceptance rules this pins, in the owner's words:
 *   R1 zero + missing  -> incomplete (NULL), never 0
 *   R2 zero + zero     -> 0
 *   R3 different action_type aliases are never summed or substituted
 *   R4 a malformed value stays missing — never 0, never coerced, never a raise
 *   R5 thumbstop / video: nothing is stamped, so nothing can be read
 * The real-PostgreSQL half (the SQL executing against stored rows, through the
 * shipped lifecycle and calibration jobs) is
 * `lib/creative-decision-engine/creative-day-metric-evidence.db.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  META_CREATIVE_DAY_METRIC_EVIDENCE_KEY,
  META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
  META_CREATIVE_DAY_METRIC_STAGES,
  buildMeasuredMetaCreativeDayMetricEvidence,
  buildMetaCreativeDayMetricEvidence,
  buildMetaCreativeDayMetricEvidenceLateralSql,
  buildMetaCreativeDayMetricEvidenceSql,
  creativeDayDecisionBearingActivitySql,
  isCreativeDayDecisionBearingActivity,
  mergeCarriedMetaCreativeDayMetricEvidence,
  mergeMetaCreativeDayMetricEvidence,
  mergeMetaCreativeDayPayloadMetricEvidence,
  parseMetaCreativeDayMetricEvidence,
  readMetaCreativeDayMetricEvidence,
  readMetaCreativeDayStageValue,
  withMetaCreativeDayMetricEvidence,
} from "@/lib/meta/creative-day-metric-evidence";
import { META_FUNNEL_STAGE_CONTRACT_VERSION } from "@/lib/meta/funnel-stage-parse";

describe("buildMetaCreativeDayMetricEvidence (the writer's stamp)", () => {
  it("stamps the version and the funnel contract it read the actions under", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({ actions: [] });
    expect(evidence.version).toBe(META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION);
    expect(evidence.funnelStageContractVersion).toBe(META_FUNNEL_STAGE_CONTRACT_VERSION);
    expect(Object.keys(evidence.stages).sort()).toEqual([...META_CREATIVE_DAY_METRIC_STAGES].sort());
  });

  it("reads an omni-only add_to_cart as a measured 0, never as the omni value (R3)", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [
        { action_type: "omni_add_to_cart", value: "9" },
        { action_type: "omni_initiated_checkout", value: "4" },
        { action_type: "omni_landing_page_view", value: "30" },
      ],
    });
    expect(evidence.stages.add_to_cart).toEqual({ state: "measured", value: 0 });
    expect(evidence.stages.initiate_checkout).toEqual({ state: "measured", value: 0 });
    expect(evidence.stages.landing_page_view).toEqual({ state: "measured", value: 0 });
  });

  it("never sums or falls back across aliases of one stage (R3)", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [
        { action_type: "add_to_cart", value: "3" },
        { action_type: "omni_add_to_cart", value: "5" },
        { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "3" },
      ],
    });
    expect(evidence.stages.add_to_cart).toEqual({ state: "measured", value: 3 });
  });

  it("refuses '12abc' as unreadable instead of parseFloat's 12 (R4)", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [{ action_type: "link_click", value: "12abc" }],
    });
    expect(evidence.stages.link_click).toEqual({ state: "unreadable", reason: "malformed_value" });
  });

  it.each([["12.7"], ["-5"], ["1e21"], [" 12"], [""]])(
    "refuses %j as unreadable (R4)",
    (value) => {
      const evidence = buildMetaCreativeDayMetricEvidence({
        actions: [{ action_type: "landing_page_view", value }],
      });
      expect(evidence.stages.landing_page_view.state).toBe("unreadable");
    },
  );

  it("refuses a JSON-number value: the provider sends strings, and the guard is the ad grain's", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [{ action_type: "add_to_cart", value: 4 }],
    });
    expect(evidence.stages.add_to_cart).toEqual({ state: "unreadable", reason: "malformed_value" });
  });

  it("refuses two entries for one stage rather than picking one", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [
        { action_type: "link_click", value: "3" },
        { action_type: "link_click", value: "4" },
      ],
    });
    expect(evidence.stages.link_click).toEqual({ state: "unreadable", reason: "duplicate_entries" });
  });

  it("stamps every action stage unmeasurable when the insight carries no actions array (R1)", () => {
    for (const actions of [undefined, null, {}, "[]", 0]) {
      const evidence = buildMetaCreativeDayMetricEvidence({ actions });
      for (const stage of ["link_click", "landing_page_view", "add_to_cart", "initiate_checkout"] as const) {
        expect(evidence.stages[stage]).toEqual({ state: "unmeasurable", reason: "actions_absent" });
      }
    }
  });

  it("never lets inline_link_clicks stand in for link_click", () => {
    const withActions = buildMetaCreativeDayMetricEvidence({
      actions: [{ action_type: "landing_page_view", value: "8" }],
      inline_link_clicks: "50",
    } as { actions: unknown });
    expect(withActions.stages.link_click).toEqual({ state: "measured", value: 0 });

    const withoutActions = buildMetaCreativeDayMetricEvidence({
      inline_link_clicks: "50",
    } as { actions?: unknown });
    expect(withoutActions.stages.link_click).toEqual({ state: "unmeasurable", reason: "actions_absent" });
  });

  it("never reads omni_link_click as link_click", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [{ action_type: "omni_link_click", value: "40" }],
    });
    expect(evidence.stages.link_click).toEqual({ state: "measured", value: 0 });
  });

  describe("outbound_click, read from its own field", () => {
    it("is unmeasurable when the field is absent (a failed rich page and an omission look alike)", () => {
      expect(buildMetaCreativeDayMetricEvidence({ actions: [] }).stages.outbound_click).toEqual({
        state: "unmeasurable",
        reason: "outbound_clicks_absent",
      });
    });

    it("reads exactly one outbound_click entry strictly", () => {
      expect(
        buildMetaCreativeDayMetricEvidence({
          outbound_clicks: [{ action_type: "outbound_click", value: "7" }],
        }).stages.outbound_click,
      ).toEqual({ state: "measured", value: 7 });
      expect(
        buildMetaCreativeDayMetricEvidence({
          outbound_clicks: [{ action_type: "outbound_click", value: "7x" }],
        }).stages.outbound_click,
      ).toEqual({ state: "unreadable", reason: "malformed_value" });
    });

    it("never reads omni_outbound_click, and an array without the entry is a measured 0", () => {
      expect(
        buildMetaCreativeDayMetricEvidence({
          outbound_clicks: [{ action_type: "omni_outbound_click", value: "11" }],
        }).stages.outbound_click,
      ).toEqual({ state: "measured", value: 0 });
    });

    it("refuses duplicates", () => {
      expect(
        buildMetaCreativeDayMetricEvidence({
          outbound_clicks: [
            { action_type: "outbound_click", value: "1" },
            { action_type: "outbound_click", value: "2" },
          ],
        }).stages.outbound_click,
      ).toEqual({ state: "unreadable", reason: "duplicate_entries" });
    });
  });
});

describe("mergeMetaCreativeDayMetricEvidence (every fold of two rows)", () => {
  const measured = (counts: Parameters<typeof buildMeasuredMetaCreativeDayMetricEvidence>[0]) =>
    buildMeasuredMetaCreativeDayMetricEvidence(counts);

  it("sums measured + measured", () => {
    const merged = mergeMetaCreativeDayMetricEvidence(
      measured({ link_click: 3, add_to_cart: 1 }),
      measured({ link_click: 4, add_to_cart: 0 }),
    );
    expect(merged.stages.link_click).toEqual({ state: "measured", value: 7 });
    expect(merged.stages.add_to_cart).toEqual({ state: "measured", value: 1 });
  });

  it("keeps measured 0 + measured 0 a measured 0 (R2)", () => {
    const merged = mergeMetaCreativeDayMetricEvidence(measured({ link_click: 0 }), measured({ link_click: 0 }));
    expect(merged.stages.link_click).toEqual({ state: "measured", value: 0 });
  });

  it("makes measured 0 + unmeasurable incomplete, never 0 (R1)", () => {
    const merged = mergeMetaCreativeDayMetricEvidence(
      measured({ link_click: 0 }),
      buildMetaCreativeDayMetricEvidence({}),
    );
    expect(merged.stages.link_click).toEqual({ state: "incomplete", reason: "merged_partial" });
  });

  it("makes measured + unreadable incomplete (R4)", () => {
    const merged = mergeMetaCreativeDayMetricEvidence(
      measured({ landing_page_view: 5 }),
      buildMetaCreativeDayMetricEvidence({ actions: [{ action_type: "landing_page_view", value: "5.5" }] }),
    );
    expect(merged.stages.landing_page_view).toEqual({ state: "incomplete", reason: "merged_partial" });
  });

  it("makes EVERY stage incomplete when one side carries no stamp or an unknown version", () => {
    for (const other of [undefined, null, {}, { version: "meta-creative-day-metric-evidence.v0" }]) {
      const merged = mergeMetaCreativeDayMetricEvidence(measured({ link_click: 3 }), other);
      for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
        expect(merged.stages[stage]).toEqual({ state: "incomplete", reason: "evidence_absent" });
      }
    }
  });

  it("treats a stamp under an unreadable funnel contract as absent evidence", () => {
    const other = { ...measured({ link_click: 4 }), funnelStageContractVersion: "meta-funnel-stage.v0" };
    const merged = mergeMetaCreativeDayMetricEvidence(measured({ link_click: 3 }), other);
    expect(merged.stages.link_click).toEqual({ state: "incomplete", reason: "evidence_absent" });
  });

  it("refuses a sum past Number.MAX_SAFE_INTEGER rather than rounding it", () => {
    const merged = mergeMetaCreativeDayMetricEvidence(
      measured({ link_click: Number.MAX_SAFE_INTEGER }),
      measured({ link_click: 1 }),
    );
    expect(merged.stages.link_click.state).toBe("unreadable");
  });

  it("folds a list: nobody stamped says nothing; one unstamped member makes the fold incomplete", () => {
    expect(mergeCarriedMetaCreativeDayMetricEvidence([{}, {}])).toBeNull();
    const single = mergeCarriedMetaCreativeDayMetricEvidence([
      { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 2 }) },
    ]);
    expect(single?.stages.link_click).toEqual({ state: "measured", value: 2 });
    const mixed = mergeCarriedMetaCreativeDayMetricEvidence([
      { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 2 }) },
      {},
    ]);
    expect(mixed?.stages.link_click).toEqual({ state: "incomplete", reason: "evidence_absent" });
    const three = mergeCarriedMetaCreativeDayMetricEvidence([
      { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 2 }) },
      { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 0 }) },
      { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 5 }) },
    ]);
    expect(three?.stages.link_click).toEqual({ state: "measured", value: 7 });
  });

  it("merges only the stamp inside a payload, leaves every other key first-wins, and never mutates", () => {
    const left = { creative_format: "video", [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 2 }) };
    const right = { creative_format: "image", [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: measured({ link_click: 3 }) };
    const leftSnapshot = JSON.stringify(left);
    const merged = mergeMetaCreativeDayPayloadMetricEvidence({ basePayload: left, left, right }) as Record<
      string,
      unknown
    >;
    expect(merged.creative_format).toBe("video");
    expect(readMetaCreativeDayStageValue(merged, "link_click")).toBe(5);
    expect(JSON.stringify(left)).toBe(leftSnapshot);

    const unstamped = { creative_format: "video" };
    expect(
      mergeMetaCreativeDayPayloadMetricEvidence({ basePayload: unstamped, left: unstamped, right: {} }),
    ).toBe(unstamped);
    const halfStamped = mergeMetaCreativeDayPayloadMetricEvidence({
      basePayload: left,
      left,
      right: unstamped,
    });
    expect(readMetaCreativeDayStageValue(halfStamped, "link_click")).toBeNull();
  });
});

describe("reading a stored stamp", () => {
  it("round-trips through JSON and returns a copy", () => {
    const evidence = buildMetaCreativeDayMetricEvidence({
      actions: [{ action_type: "link_click", value: "9" }],
      outbound_clicks: [],
    });
    const stored = JSON.parse(JSON.stringify({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence }));
    const read = readMetaCreativeDayMetricEvidence(stored);
    expect(read).toEqual(evidence);
    expect(read).not.toBe(stored[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]);
  });

  it.each([
    ["not an object", "x"],
    ["wrong version", { ...buildMeasuredMetaCreativeDayMetricEvidence({}), version: "v2" }],
    ["missing funnel contract", { ...buildMeasuredMetaCreativeDayMetricEvidence({}), funnelStageContractVersion: "" }],
    ["unknown funnel contract", { ...buildMeasuredMetaCreativeDayMetricEvidence({}), funnelStageContractVersion: "meta-funnel-stage.v0" }],
    ["missing stage", { version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION, funnelStageContractVersion: "x", stages: {} }],
  ])("rejects %s", (_label, raw) => {
    expect(parseMetaCreativeDayMetricEvidence(raw)).toBeNull();
  });

  it("rejects a measured stage whose value is not a non-negative safe integer", () => {
    for (const value of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1, null]) {
      const evidence = buildMeasuredMetaCreativeDayMetricEvidence({ link_click: 1 }) as unknown as {
        stages: Record<string, unknown>;
      };
      evidence.stages.link_click = { state: "measured", value };
      expect(parseMetaCreativeDayMetricEvidence(evidence)).toBeNull();
      expect(
        readMetaCreativeDayStageValue({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence }, "link_click"),
      ).toBeNull();
    }
  });

  it("reads per stage like the SQL: a malformed sibling does not hide a valid stage", () => {
    const evidence = buildMeasuredMetaCreativeDayMetricEvidence({ link_click: 4 }) as unknown as {
      stages: Record<string, unknown>;
    };
    evidence.stages.add_to_cart = { state: "measured", value: -2 };
    const payload = { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence };
    expect(readMetaCreativeDayStageValue(payload, "link_click")).toBe(4);
    expect(readMetaCreativeDayStageValue(payload, "add_to_cart")).toBeNull();
    expect(readMetaCreativeDayStageValue({ link_clicks: 12, landing_page_views: 9 }, "link_click")).toBeNull();
  });

  it("refuses a per-stage value stamped under an unreadable funnel contract", () => {
    const evidence = {
      ...buildMeasuredMetaCreativeDayMetricEvidence({ link_click: 4 }),
      funnelStageContractVersion: "meta-funnel-stage.v0",
    };
    expect(
      readMetaCreativeDayStageValue(
        { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence },
        "link_click",
      ),
    ).toBeNull();
  });

  it("attaches a stamp without touching the row, and attaches nothing when there is none", () => {
    const row = { id: "r1" };
    expect(withMetaCreativeDayMetricEvidence(row, null)).toBe(row);
    const stamped = withMetaCreativeDayMetricEvidence(row, buildMeasuredMetaCreativeDayMetricEvidence({}));
    expect(stamped).not.toBe(row);
    expect(row).toEqual({ id: "r1" });
    expect(readMetaCreativeDayMetricEvidence(stamped)).not.toBeNull();
  });

  it("refuses a fixture count the writer could never produce", () => {
    expect(() => buildMeasuredMetaCreativeDayMetricEvidence({ link_click: 1.5 })).toThrow();
    expect(() => buildMeasuredMetaCreativeDayMetricEvidence({ link_click: -1 })).toThrow();
  });
});

describe("buildMetaCreativeDayMetricEvidenceSql", () => {
  const sql = buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: "d.payload_json" });

  it("accepts only an identifier or alias.identifier as the payload expression", () => {
    for (const bad of ["d.payload_json; DROP TABLE x", "payload_json->'x'", "D.payload", "a.b.c", ""]) {
      expect(() => buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: bad })).toThrow();
    }
    expect(() => buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: "payload_json" })).not.toThrow();
  });

  it("refuses a stage it does not stamp — thumbstop and video have no contract (R5)", () => {
    for (const stage of ["thumbstop", "video25", "view_content"]) {
      expect(() => sql.valueSql(stage as never)).toThrow();
    }
  });

  it("gates on the stamp version, the measured state and the JSON number type", () => {
    const value = sql.valueSql("add_to_cart");
    expect(value).toContain(
      `(d.payload_json->'metric_evidence'->>'version') IN ('${META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION}', 'meta-creative-day-metric-evidence.v1')`,
    );
    expect(value).toContain(
      `(d.payload_json->'metric_evidence'->>'funnelStageContractVersion') IS NOT DISTINCT FROM '${META_FUNNEL_STAGE_CONTRACT_VERSION}'`,
    );
    expect(value).toContain("->'stages'->'add_to_cart'->>'state') IS NOT DISTINCT FROM 'measured'");
    expect(value).toContain("jsonb_typeof(d.payload_json->'metric_evidence'->'stages'->'add_to_cart'->'value') IS NOT DISTINCT FROM 'number'");
    expect(value).not.toMatch(/landing_page_views|link_clicks|thumbstop|omni/);
  });

  it("attempts no cast before the digit pattern admitted the text (nested CASE, not AND)", () => {
    const value = sql.valueSql("link_click");
    const patternAt = value.indexOf("~ '^[0-9]+$'");
    const numericCastAt = value.indexOf("::numeric");
    const doubleCastAt = value.indexOf("::double precision");
    expect(patternAt).toBeGreaterThan(0);
    expect(numericCastAt).toBeGreaterThan(patternAt);
    expect(doubleCastAt).toBeGreaterThan(numericCastAt);
    expect(value).toContain("<= 9007199254740991");
    expect(value.match(/\bCASE\b/g)?.length).toBe(3);
    expect(value).not.toMatch(/\bAND\b[^\n]*~/);
  });

  it("defines missing as the value being NULL, so it can never itself be NULL", () => {
    expect(sql.missingSql("link_click")).toBe(`(${sql.valueSql("link_click")} IS NULL)`);
  });

  it("emits no backticks and no COALESCE-to-zero", () => {
    for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
      expect(sql.valueSql(stage)).not.toContain("`");
      expect(sql.valueSql(stage)).not.toMatch(/COALESCE/i);
    }
  });
});

describe("creative-day activity and the evaluated-once lateral", () => {
  it("treats delivery, spend, clicks, conversions or revenue as decision-bearing, never NULL", () => {
    const predicate = creativeDayDecisionBearingActivitySql("d");
    for (const column of ["impressions", "spend", "clicks", "conversions", "revenue"]) {
      expect(predicate).toContain(`COALESCE(d.${column}, 0) > 0`);
    }
    expect(() => creativeDayDecisionBearingActivitySql("d; x")).toThrow();
    expect(isCreativeDayDecisionBearingActivity({ spend: 0, impressions: 0 })).toBe(false);
    expect(isCreativeDayDecisionBearingActivity({ impressions: 1 })).toBe(true);
    expect(isCreativeDayDecisionBearingActivity({ revenue: 3 })).toBe(true);
  });

  it("projects every stage from the same valueSql, behind two optimisation fences", () => {
    const lateral = buildMetaCreativeDayMetricEvidenceLateralSql({
      payloadExpression: "d.payload_json",
      rowAlias: "d",
      lateralAlias: "creative_day_evidence",
    });
    const inner = buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: "creative_day_evidence_stamp.payload" });
    for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
      expect(lateral.lateralSql).toContain(`${inner.valueSql(stage)} AS ${stage}`);
      expect(lateral.valueSql(stage)).toBe(`creative_day_evidence.${stage}`);
      expect(lateral.missingSql(stage)).toBe(`(creative_day_evidence.${stage} IS NULL)`);
    }
    expect(lateral.lateralSql.match(/OFFSET 0/g)?.length).toBe(2);
    expect(lateral.lateralSql).toContain("d.payload_json->'metric_evidence'");
    expect(lateral.activitySql).toBe("creative_day_evidence.decision_bearing_activity");
    expect(() =>
      buildMetaCreativeDayMetricEvidenceLateralSql({
        payloadExpression: "d.payload_json",
        rowAlias: "d",
        lateralAlias: "bad alias",
      }),
    ).toThrow();
  });
});
