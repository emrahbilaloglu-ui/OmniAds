/**
 * The ad-grain readers extract funnel stages from `actions`, and none of them
 * still reaches for the dead top-level keys.
 *
 * This is the regression that would be invisible otherwise: the previous
 * expressions were syntactically valid, ran without error, and returned
 * nothing. `COALESCE(..., 0)` then published that nothing as a measured zero.
 * A reader that silently drifts back to `payload_json->>'landing_page_views'`
 * would look exactly as healthy as one that works, so the wiring is pinned
 * here rather than left to a DB test that only runs inside the seam.
 *
 * Scope note: `meta_creative_daily` is a DIFFERENT, already-flattened payload
 * whose top-level funnel keys are present on every row (33,017 of 33,017 over
 * 90 days of production) — but presence there measured the WRITER, not the
 * provider: it wrote each key as a finite number whether or not anything was
 * observed. The creative-grain readers therefore no longer read those keys at
 * all; they read the per-stage stamp in
 * `lib/meta/creative-day-metric-evidence.ts`, and that wiring is pinned in
 * `lib/meta/creative-day-metric-evidence.test.ts` and against PostgreSQL in
 * `lib/creative-decision-engine/creative-day-metric-evidence.db.test.ts`, not
 * here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { READ_NATIVE_AD_CALIBRATION_SOURCE_SQL } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  AD_DAY_DECISION_BEARING_ACTIVITY_SQL,
  HYDRATE_AD_DECISION_INPUTS_QUERY,
} from "@/lib/creative-decision-engine/data-source";
import {
  ADSET_CALIBRATION_AD_DAY_ACTIVITY_SQL,
  ADSET_CALIBRATION_ADSET_DAY_ACTIVITY_SQL,
  ADSET_FUNNEL_STAGE_SQL,
} from "@/lib/meta/calibration";
import { META_FUNNEL_STAGES } from "@/lib/meta/funnel-stage-parse";
import { buildAdDayAuthoritativeLinkClicksSql } from "@/lib/meta/link-click-parse";

/** The keys `meta_ad_daily.payload_json` has never carried. */
const DEAD_AD_GRAIN_KEYS = [
  "landing_page_views",
  "add_to_cart",
  "initiate_checkout",
  "view_content",
  "post_engagement",
  "leads",
] as const;

const executableLines = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const AD_GRAIN_SQL: readonly { name: string; sql: string }[] = [
  {
    name: "native ad calibration source",
    sql: READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  },
  {
    name: "ad decision hydration",
    sql: HYDRATE_AD_DECISION_INPUTS_QUERY,
  },
  {
    /*
      The adset query is assembled inside `readAggregatedAdsetMetricRows`, so
      the file on disk holds the `${...}` placeholder rather than the SQL. The
      fragment it interpolates is exported for exactly this pin; the dead-key
      negatives below still read the file, because that is where a drifted
      expression would reappear.
    */
    name: "adset calibration source",
    sql: [
      ADSET_FUNNEL_STAGE_SQL.lateralSql,
      ADSET_FUNNEL_STAGE_SQL.valueSql("landing_page_view"),
      ADSET_FUNNEL_STAGE_SQL.stateSql("landing_page_view"),
    ].join("\n"),
  },
];

describe("the ad-grain readers extract from payload_json->'actions'", () => {
  it.each(AD_GRAIN_SQL)("$name expands the actions array", ({ sql }) => {
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("->'actions'");
  });

  it.each([
    ...AD_GRAIN_SQL.filter((entry) => entry.name !== "adset calibration source"),
    {
      name: "adset calibration source (file)",
      sql: readFileSync("lib/meta/calibration.ts", "utf8"),
    },
  ])("$name no longer reads a dead top-level funnel key", ({ sql }) => {
    const executable = executableLines(sql);
    for (const key of DEAD_AD_GRAIN_KEYS) {
      expect(executable).not.toContain(`payload_json->>'${key}'`);
    }
  });

  it.each(AD_GRAIN_SQL)("$name decides absence null-safely", ({ sql }) => {
    // `jsonb_typeof(NULL)` is NULL, so a plain `NOT (... = 'array')` never fires
    // the unmeasurable arm and an absent payload falls through to measured zero.
    expect(sql).toContain("IS DISTINCT FROM 'array'");
  });

  it.each(AD_GRAIN_SQL)("$name reads one canonical alias per stage", ({ sql }) => {
    const executable = executableLines(sql);
    for (const stage of META_FUNNEL_STAGES) {
      for (const alias of stage.provenDivergentAliases) {
        expect(executable).not.toContain(`'${alias}'`);
      }
    }
  });
});

describe("the out-of-scope fields are left alone rather than half-fixed", () => {
  it("keeps outbound_clicks on its own reader: it is absent from actions, not misspelled", () => {
    // Measured across 90 days of production: the `outbound_click` action type
    // does not appear in a single stored actions array, and the ad-level Graph
    // request never asks for the `outbound_clicks` field. So the ad grain has no
    // reader to fix: it states NULL by contract, and it no longer casts payload
    // text that a malformed value could make raise.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "NULL::numeric AS outbound_clicks",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "payload_json->>'outbound_clicks'",
    );
    expect(
      META_FUNNEL_STAGES.some((stage) => stage.canonicalAlias === "outbound_click"),
    ).toBe(false);
  });

  it("keeps thumbstop null-honest rather than giving it a fabricated reading", () => {
    // Not an actions entry; it needs a real provider field and denominator,
    // and meta_ad_daily has neither verified. The old read cast the payload
    // key to double precision, which RAISES on a junk string and would have
    // failed the whole calibration statement over one malformed ad-day (R4),
    // while a successful cast emitted a reading nobody verified (R5).
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).toContain(
      "NULL::double precision AS thumbstop",
    );
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).not.toContain(
      "(NULLIF(d.payload_json->>'thumbstop', ''))::double precision",
    );
  });

  it("reads native calibration link clicks through the D095 classifier, not the raw column", () => {
    // A legacy stored zero is not a measurement on its own; the shared
    // classifier decides it from the payload, exactly as the loader does.
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).toContain(
      `${buildAdDayAuthoritativeLinkClicksSql({
        qualifier: "d", providerZeroProofSql: "source_receipt.provider_zero_receipt_verified",
      })} AS link_clicks`,
    );
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).not.toMatch(
      /^\s*d\.link_clicks,\s*$/m,
    );
  });

  it("emits thruplay_actions on the adset reader as NULL rather than reading an unverified key", () => {
    /*
      RE-PINNED. This asserted the reader still read the top-level
      `thruplay_actions` key. That key does not exist on `meta_ad_daily`, no
      `thruplay` action type appears in any stored actions array, and the
      `::numeric` cast on whatever it found would have aborted the whole
      calibration on one malformed value. With no verified provider contract
      the reader now emits NULL outright (R5), which keeps the field
      null-honest without reading anything.
    */
    const executable = executableLines(readFileSync("lib/meta/calibration.ts", "utf8"));
    expect(executable).not.toContain("payload_json->>'thruplay_actions'");
    expect(executable).toContain("NULL::double precision AS thruplay_actions_28d");
  });

  it("classifies adset-calibration activity with the native ad-day predicate", () => {
    // The adset reader restates AD_DAY_DECISION_BEARING_ACTIVITY_SQL with a
    // relation qualifier instead of importing the native loader. Pinned here
    // so the two spellings cannot drift: strip the qualifier and they match.
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
    expect(
      normalize(ADSET_CALIBRATION_AD_DAY_ACTIVITY_SQL.replace(/\bad_day\./g, "")),
    ).toBe(normalize(AD_DAY_DECISION_BEARING_ACTIVITY_SQL));
    expect(
      normalize(ADSET_CALIBRATION_ADSET_DAY_ACTIVITY_SQL.replace(/\badset\./g, "")),
    ).toBe(normalize(AD_DAY_DECISION_BEARING_ACTIVITY_SQL));
  });
});
