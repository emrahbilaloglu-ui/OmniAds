/**
 * The funnel stages read the array the pipeline already stores, and they keep
 * "measured zero" apart from "never observed".
 *
 * Four production readers asked `payload_json` for a TOP-LEVEL
 * `landing_page_views` / `add_to_cart` / `initiate_checkout` key. No such key
 * has ever existed; the measurement is inside `payload_json->'actions'`. Two of
 * those readers wrapped the miss in `COALESCE(..., 0)`, which turned "I asked
 * the wrong question" into a confident measured zero — and that zero is what
 * made `funnel_quality_status` report `insufficient` across production with an
 * average funnel sample of 0.5.
 *
 * So the cases below are about the DISTINCTION, not about arithmetic: an absent
 * `actions` array is never a zero, a malformed entry is never a zero, and an
 * array that simply omits the stage IS a zero because that is how Meta encodes
 * "it did not happen".
 */
import { describe, expect, it } from "vitest";

import {
  META_FUNNEL_STAGES,
  META_FUNNEL_STAGE_CONTRACT_VERSION,
  buildMetaCompleteWindowSql,
  buildMetaFunnelStageSql,
  META_METRIC_WINDOW_COMPLETENESS_RULE,
  resolveMetaCompleteWindowSum,
  metaFunnelStage,
  readMetaFunnelStageFromActions,
  readMetaFunnelStageFromPayload,
} from "@/lib/meta/funnel-stage-parse";
import { parseMetaLinkClickValue } from "@/lib/meta/link-click-parse";
import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";

const entry = (action_type: string, value: unknown) => ({ action_type, value });

describe("measured zero is a measurement; absence is not", () => {
  it("reads an omitted stage as a measured zero, because Meta omits what did not occur", () => {
    expect(
      readMetaFunnelStageFromActions([entry("link_click", "12")], "add_to_cart"),
    ).toEqual({ state: "measured", value: 0 });
  });

  it("reads an explicit \"0\" entry as a measured zero", () => {
    // 164 such entries were observed in a single 27-day production window, so
    // this encoding is real and means the same thing as omission.
    expect(
      readMetaFunnelStageFromActions([entry("add_to_cart", "0")], "add_to_cart"),
    ).toEqual({ state: "measured", value: 0 });
  });

  it.each([[undefined], [null], [{}], ["actions"], [42]])(
    "reads %j as unmeasurable rather than as zero",
    (actions) => {
      expect(readMetaFunnelStageFromActions(actions, "landing_page_view")).toEqual({
        state: "unmeasurable",
        reason: "actions_absent",
      });
    },
  );

  it("reads a payload with no actions key as unmeasurable", () => {
    expect(readMetaFunnelStageFromPayload({ spend: "1.00" }, "initiate_checkout")).toEqual({
      state: "unmeasurable",
      reason: "actions_absent",
    });
  });

  it("reads only a receipt-verified provider omission as a measured zero", () => {
    expect(readMetaFunnelStageFromPayload(
      { spend: "1.00" }, "initiate_checkout", { providerZeroReceiptVerified: true },
    )).toEqual({ state: "measured", value: 0 });
    expect(readMetaFunnelStageFromPayload(
      { actions: null }, "initiate_checkout", { providerZeroReceiptVerified: true },
    )).toEqual({ state: "unmeasurable", reason: "actions_absent" });
    const sql = buildMetaFunnelStageSql({
      payloadExpression: "d.payload_json",
      lateralAlias: "fa",
      stages: ["initiate_checkout"],
      providerZeroProofSql: "source_receipt.verified",
    });
    expect(sql.valueSql("initiate_checkout")).toContain(
      "COALESCE(source_receipt.verified, FALSE)",
    );
    expect(sql.valueSql("initiate_checkout")).toContain("NOT (d.payload_json ? 'actions')");
  });

  it("reads a payload's actions array through to a value", () => {
    expect(
      readMetaFunnelStageFromPayload(
        { actions: [entry("initiate_checkout", "7")] },
        "initiate_checkout",
      ),
    ).toEqual({ state: "measured", value: 7 });
  });
});
describe("the strict value guard, shared with the link-click parser", () => {
  it.each([["12.7"], ["12abc"], ["-5"], ["1e21"], [" 7 "], [""], ["NaN"], [12]])(
    "reads %j as unreadable instead of coercing it",
    (raw) => {
      expect(
        readMetaFunnelStageFromActions([entry("add_to_cart", raw)], "add_to_cart"),
      ).toEqual({ state: "unreadable", reason: "malformed_value" });
    },
  );

  it("refuses a digit string past Number.MAX_SAFE_INTEGER", () => {
    expect(
      readMetaFunnelStageFromActions(
        [entry("add_to_cart", "9007199254740992")],
        "add_to_cart",
      ),
    ).toEqual({ state: "unreadable", reason: "malformed_value" });
    expect(
      readMetaFunnelStageFromActions(
        [entry("add_to_cart", "9007199254740991")],
        "add_to_cart",
      ),
    ).toEqual({ state: "measured", value: 9007199254740991 });
  });

  it("is ONE guard: the link-click entry point delegates to it", () => {
    // Two definitions of "is this a count?" is the divergence link-click-parse
    // was written to end; a second copy for the funnel would reopen it.
    for (const raw of ["12.7", "12abc", "-5", "1e21", "", "7"]) {
      expect(parseMetaLinkClickValue(raw)).toEqual(parseMetaActionCountValue(raw));
    }
  });

  it("refuses duplicate entries rather than picking one", () => {
    expect(
      readMetaFunnelStageFromActions(
        [entry("add_to_cart", "3"), entry("add_to_cart", "4")],
        "add_to_cart",
      ),
    ).toEqual({ state: "unreadable", reason: "duplicate_entries" });
  });
});

describe("aliases are chosen per stage and never summed", () => {
  it("reads only the canonical alias, never an equivalent one", () => {
    // `offsite_conversion.fb_pixel_add_to_cart` carried an identical value on
    // every production ad-day observed — which is exactly why it must not be
    // ADDED to the canonical one. Equivalence is a reason not to sum, not a
    // reason to read both.
    expect(
      readMetaFunnelStageFromActions(
        [
          entry("add_to_cart", "5"),
          entry("offsite_conversion.fb_pixel_add_to_cart", "5"),
          entry("omni_add_to_cart", "9"),
        ],
        "add_to_cart",
      ),
    ).toEqual({ state: "measured", value: 5 });
  });

  it("never substitutes a divergent alias when the canonical one is absent", () => {
    // `omni_add_to_cart` differed from the canonical alias on 281 production
    // ad-days in 90 days. Falling back to it would silently change population.
    expect(
      readMetaFunnelStageFromActions([entry("omni_add_to_cart", "9")], "add_to_cart"),
    ).toEqual({ state: "measured", value: 0 });
  });

  it("keeps every stage's alias sets disjoint from its canonical alias", () => {
    for (const stage of META_FUNNEL_STAGES) {
      expect(stage.provenEquivalentAliases).not.toContain(stage.canonicalAlias);
      expect(stage.provenDivergentAliases).not.toContain(stage.canonicalAlias);
      for (const alias of stage.provenDivergentAliases) {
        expect(stage.provenEquivalentAliases).not.toContain(alias);
      }
    }
  });

  it("pins the contract version so a stage or alias change is visible", () => {
    expect(META_FUNNEL_STAGE_CONTRACT_VERSION).toBe("meta-funnel-stage.v1");
    expect(META_FUNNEL_STAGES.map((stage) => `${stage.id}:${stage.canonicalAlias}`)).toEqual([
      "landing_page_view:landing_page_view",
      "add_to_cart:add_to_cart",
      "initiate_checkout:initiate_checkout",
      "view_content:view_content",
      "post_engagement:post_engagement",
      "lead:lead",
      "link_click:link_click",
    ]);
  });

  it("refuses an unknown stage rather than reading nothing", () => {
    expect(() => metaFunnelStage("purchase" as never)).toThrow(
      /meta_funnel_stage_unknown:purchase/,
    );
  });
});

describe("the emitted SQL cannot drift from the parser", () => {
  const sql = buildMetaFunnelStageSql({
    payloadExpression: "d.payload_json",
    lateralAlias: "fa",
  });

  it("reads each stage's canonical alias and no other", () => {
    for (const stage of META_FUNNEL_STAGES) {
      expect(sql.lateralSql).toContain(`= '${stage.canonicalAlias}'`);
      for (const alias of [
        ...stage.provenEquivalentAliases,
        ...stage.provenDivergentAliases,
      ]) {
        expect(sql.lateralSql).not.toContain(`'${alias}'`);
      }
    }
  });

  it("expands the actions array exactly once for every stage", () => {
    // Measured on production: one lateral extracted all four stages in 620 ms
    // over 90 days, where a single stage via jsonb_path_query_array took
    // 1,627 ms. Per-stage expansion would re-parse the same jsonb four times,
    // against reads that already sit under a 30 s statement timeout.
    expect(sql.lateralSql.match(/jsonb_array_elements\(/g)).toHaveLength(1);
  });

  it("uses a null-safe array test, so an absent actions key is unmeasurable", () => {
    // `jsonb_typeof(NULL)` is NULL, so `NOT (jsonb_typeof(...) = 'array')` is
    // NULL rather than TRUE and the unmeasurable arm never fires. Running the
    // emitted SQL against production reported 6,270 such ad-days as measured
    // zeros before this was made null-safe.
    expect(sql.stateSql("landing_page_view")).toContain("IS DISTINCT FROM 'array'");
    expect(sql.stateSql("landing_page_view")).not.toMatch(/NOT \(jsonb_typeof/);
  });

  it("orders the ladder so absence is decided before the zero arm", () => {
    const state = sql.stateSql("add_to_cart");
    expect(state.indexOf("'unmeasurable'")).toBeLessThan(state.indexOf("'measured'"));
  });

  it("mirrors the parser's digit and range guard", () => {
    expect(sql.valueSql("add_to_cart")).toContain("~ '^[0-9]+$'");
    expect(sql.valueSql("add_to_cart")).toContain("<= 9007199254740991");
  });

  it("never emits a coalesce-to-zero over the extracted value", () => {
    for (const stage of META_FUNNEL_STAGES) {
      const executable = sql
        .valueSql(stage.id)
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      expect(executable).not.toMatch(/COALESCE\(\s*\(?fa\.\w+_raw_value/);
    }
  });

  it("never hands a non-array to jsonb_array_elements", () => {
    /*
      `jsonb_array_elements` RAISES on an object or a scalar rather than
      returning no rows, and `LEFT JOIN LATERAL ... ON <test>` does not promise
      the planner runs that test first. Verified against real PostgreSQL with
      `{"actions": {...}}`, `{"actions": 5}`, `{"actions": "x"}` and
      `{"actions": null}`: all four report `unmeasurable`, none errors.
    */
    expect(sql.lateralSql).toContain("ELSE '[]'::jsonb");
    expect(sql.lateralSql).toMatch(
      /jsonb_array_elements\(CASE\s+WHEN jsonb_typeof\(/,
    );
  });

  it("only casts a value the digit test already accepted", () => {
    /*
      PostgreSQL may reorder the operands of an AND, so
      `raw ~ '^[0-9]+$' AND raw::numeric <= ...` can attempt the cast on a value
      the regex would reject and raise instead of reporting `unreadable`.
      Nesting makes the order part of the expression.
    */
    const value = sql.valueSql("add_to_cart");
    const regexAt = value.indexOf("~ '^[0-9]+$'");
    const castAt = value.indexOf("::numeric");
    expect(regexAt).toBeGreaterThan(-1);
    expect(castAt).toBeGreaterThan(regexAt);
    expect(value).not.toMatch(/~ '\^\[0-9\]\+\$'\s*\n?\s*AND/);
  });

  it("agrees with the SQL on leading zeros and on over-long digit strings", () => {
    // Measured against real PostgreSQL: "000000123" -> measured 123, and 400
    // nines -> unreadable. TypeScript reaches the same two answers here.
    expect(
      readMetaFunnelStageFromActions([entry("add_to_cart", "000000123")], "add_to_cart"),
    ).toEqual({ state: "measured", value: 123 });
    expect(
      readMetaFunnelStageFromActions([entry("add_to_cart", "9".repeat(400))], "add_to_cart"),
    ).toEqual({ state: "unreadable", reason: "malformed_value" });
  });

  it("refuses an identifier it did not generate", () => {
    expect(() =>
      buildMetaFunnelStageSql({ payloadExpression: "d.payload_json", lateralAlias: "fa; DROP" }),
    ).toThrow(/meta_funnel_stage_sql_alias_invalid/);
    expect(() =>
      buildMetaFunnelStageSql({ payloadExpression: "(SELECT 1)", lateralAlias: "fa" }),
    ).toThrow(/meta_funnel_stage_sql_payload_expression_invalid/);
  });

  it("refuses to hand back a stage it was not asked to build", () => {
    const narrow = buildMetaFunnelStageSql({
      payloadExpression: "d.payload_json",
      lateralAlias: "fa",
      stages: ["link_click"],
    });
    expect(() => narrow.valueSql("add_to_cart")).toThrow(
      /meta_funnel_stage_sql_stage_not_built:add_to_cart/,
    );
  });
});

/*
  THE WINDOW RULE (D099). The per-day ladder keeps measured zero and "not
  measured" apart; these pin that a window over days does not throw the
  distinction away again. The SQL twin is exercised on real PostgreSQL by
  ad-band-completeness.db.test.ts, calibration-window.db.test.ts and
  creative-day-metric-evidence.db.test.ts.
*/
describe("resolveMetaCompleteWindowSum — the in-memory window rule", () => {
  it.each([
    { name: "zero + zero is a measured zero", rows: [{ value: 0, active: true }, { value: 0, active: true }], expected: 0 },
    { name: "zero + missing is unknown", rows: [{ value: 0, active: true }, { value: null, active: true }], expected: null },
    { name: "value + missing is unknown, never a partial sum", rows: [{ value: 5, active: true }, { value: null, active: true }], expected: null },
    { name: "a day that did nothing is not a gap", rows: [{ value: 5, active: true }, { value: null, active: false }], expected: 5 },
    { name: "an unknown activity counts as delivering", rows: [{ value: 5, active: true }, { value: null, active: null }], expected: null },
    { name: "no rows is unknown", rows: [], expected: null },
    { name: "only inert, unmeasured days is unknown", rows: [{ value: null, active: false }], expected: null },
    { name: "a non-finite value is missing", rows: [{ value: Number.NaN, active: true }], expected: null },
  ])("$name", ({ rows, expected }) => {
    expect(resolveMetaCompleteWindowSum(rows)).toBe(expected);
  });

  it("names the rule so a stored window sum can cite it", () => {
    expect(META_METRIC_WINDOW_COMPLETENESS_RULE).toBe("meta-metric-window.complete-or-null.v1");
  });
});

describe("buildMetaCompleteWindowSql — the SQL window rule", () => {
  const window = buildMetaCompleteWindowSql({
    valueSql: "v",
    missingSql: "v IS NULL",
    activitySql: "impressions > 0",
    rowFilterSql: "date >= $2",
  });

  it("sums only when no decision-bearing row in the window is missing", () => {
    expect(window.sumSql).toContain("WHEN COUNT(*) FILTER (WHERE COALESCE((date >= $2), FALSE) AND (v IS NULL) AND COALESCE((impressions > 0), TRUE)) = 0");
    expect(window.sumSql).toContain("THEN SUM(v) FILTER (WHERE COALESCE((date >= $2), FALSE))");
    // No ELSE: an incomplete window is NULL, never a coalesced zero.
    expect(window.sumSql).not.toContain("ELSE");
    expect(window.sumSql).not.toMatch(/COALESCE\(\s*SUM/);
  });

  it("counts the missing delivering rows with the same predicate", () => {
    expect(window.missingDeliveredRowsSql).toBe(
      "(COUNT(*) FILTER (WHERE COALESCE((date >= $2), FALSE) AND (v IS NULL) AND COALESCE((impressions > 0), TRUE)))::integer",
    );
  });
});

describe("the SQL ladder refuses what the TypeScript guard refuses", () => {
  const sql = buildMetaFunnelStageSql({
    payloadExpression: "d.payload_json",
    lateralAlias: "fa",
    stages: ["landing_page_view"],
  });

  it("reads the JSON type of the value beside its text", () => {
    expect(sql.lateralSql).toContain(
      "max(jsonb_typeof(entry->'value')) FILTER (WHERE entry->>'action_type' = 'landing_page_view') AS landing_page_view_raw_type",
    );
  });

  it("sends a non-string value to the malformed arm before any digit test", () => {
    const value = sql.valueSql("landing_page_view");
    const typeGuard = value.indexOf("fa.landing_page_view_raw_type IS DISTINCT FROM 'string' THEN NULL::double precision");
    const digitTest = value.indexOf("~ '^[0-9]+$'");
    expect(typeGuard).toBeGreaterThan(0);
    expect(typeGuard).toBeLessThan(digitTest);
    // The TypeScript twin refuses the same input.
    expect(readMetaFunnelStageFromActions([{ action_type: "landing_page_view", value: 7 }], "landing_page_view")).toEqual({
      state: "unreadable",
      reason: "malformed_value",
    });
  });

  it("gives the window rule a never-NULL missing predicate", () => {
    const missing = sql.missingSql("landing_page_view");
    expect(missing).toContain("IS DISTINCT FROM 'array' THEN TRUE");
    expect(missing).toMatch(/ELSE TRUE\s+END$/);
  });
});
