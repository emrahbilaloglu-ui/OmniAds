/**
 * The differential replay's claims, and the boundaries it must not cross.
 *
 * The runner exists because no frozen research replay can validate the repair:
 * `native-ad-grain-paired-replay.ts` reads the stale top-level funnel keys and
 * coerces link_clicks through `numberOrZero`, so it reproduces both defects, and
 * `current-engine-historical-replay.ts` exercises the campaign-role guard at
 * creative grain only. Those files are deliberately left alone — editing a
 * frozen artifact so it agrees with a new implementation destroys the only thing
 * it was keeping. These cases pin that separation, the read-only posture, and
 * the three evidence classes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONFIG_RECEIPT_SOURCE_KIND,
  DIFFERENTIAL_REPLAY_BOUNDS,
  DifferentialReplayUsageError,
  REPLAY_AD_DAY_SQL,
  REPLAY_ENGINE_WINDOW_DAYS,
  REPLAY_HELD_DECISION_SQL,
  REPLAY_OBJECTIVE_SOURCE_SQL,
  REPLAY_PIT_ANCHOR_SQL,
  assertSessionIsReadOnly,
  buildDifferentialFromRows,
  executeDifferentialReplay,
  parseDifferentialReplayArgs,
} from "./native-ad-repair-differential-replay";
import { ReadOnlySnapshotError } from "./read-only-snapshot";

/** A cutoff, and instants either side of it. */
const CUTOFF = "2026-09-11T03:06:30.000Z";
const BEFORE = "2026-09-09T00:00:00.000Z";
const AFTER = "2026-09-19T00:00:00.000Z";

const SCOPE = {
  businessId: "biz-1",
  startDate: "2026-08-25",
  endDate: "2026-09-20",
  pitAnchor: { asOfDate: "2026-09-21", cutoff: CUTOFF },
};
const BOUNDS = { maxRows: 100, queryTimeoutMs: 1_000 };

function adDay(overrides: Record<string, unknown> = {}) {
  return {
    provider_account_id: "act_1",
    campaign_id: "cmp_1",
    ad_id: "ad_1",
    date: "2026-09-10",
    spend: 100,
    local_day_end: "2026-09-10T21:00:00.000Z",
    row_created_at: BEFORE,
    row_updated_at: BEFORE,
    first_consuming_run_started_at: BEFORE,
    // Pre-repair funnel keys: absent on every real meta_ad_daily row.
    baseline_lpv: null,
    baseline_atc: null,
    baseline_ic: null,
    repaired_lpv: 200,
    repaired_lpv_state: "measured",
    repaired_atc: 16,
    repaired_ic: 3,
    baseline_link_clicks: 227,
    reader_link_clicks: 227,
    raw_link_click_entries: [{ action_type: "link_click", value: "227" }],
    actions_present: true,
    baseline_objective: "OUTCOME_SALES",
    objective_source_value: "OUTCOME_SALES",
    objective_source_tier: "provider_receipt_day_bracketed",
    objective_source_readiness: "decision_authority",
    objective_source_class: "modern",
    objective_source_pit_class: "as_of_known",
    receipt_objective: "OUTCOME_SALES",
    receipt_objective_captured_at: BEFORE,
    receipt_objective_created_at: BEFORE,
    receipt_objective_same_day: true,
    typed_witness_objective: null,
    typed_witness_observed_at: null,
    asof_objective: "OUTCOME_SALES",
    asof_objective_source_kind: "provider_config_receipt",
    baseline_creative_id: "creative_a",
    baseline_creative_campaign_id: "cmp_1",
    repaired_creative_id: "creative_a",
    repaired_creative_observed_at: BEFORE,
    repaired_creative_captured_at: BEFORE,
    repaired_creative_presence: "present",
    repaired_creative_has_coverage: true,
    ...overrides,
  };
}

const dim = (receipt: ReturnType<typeof buildDifferentialFromRows>, name: string) => {
  const found = receipt.dimensions.find((entry) => entry.dimension === name);
  if (!found) throw new Error(`dimension ${name} missing`);
  return found;
};

describe("it never edits the frozen research replays", () => {
  it("leaves native-ad-grain-paired-replay on its stale keys", () => {
    // If someone "fixes" that file to make a repair look validated, this fails
    // and the differential loses its reason to exist.
    const frozen = readFileSync(
      "scripts/creative-decision-center/native-ad-grain-paired-replay.ts",
      "utf8",
    );
    expect(frozen).toContain("d.payload_json->>'landing_page_views'");
    expect(frozen).toContain("numberOrZero(row.link_clicks)");
  });
});

describe("the runner cannot write", () => {
  it("contains no DML", () => {
    const source = readFileSync(
      "scripts/creative-decision-center/native-ad-repair-differential-replay.ts",
      "utf8",
    );
    for (const dml of ["INSERT INTO", "UPDATE ", "DELETE FROM", "TRUNCATE", "CREATE TABLE"]) {
      expect(source).not.toContain(dml);
    }
  });

  it("refuses a session that is not read-only", async () => {
    await expect(
      assertSessionIsReadOnly(async () => [{ default_transaction_read_only: "off" }]),
    ).rejects.toThrow(/read-only session/);
    await expect(
      assertSessionIsReadOnly(async () => [{ default_transaction_read_only: "on" }]),
    ).resolves.toBeUndefined();
  });

  it("only writes an artifact when asked twice", () => {
    expect(parseDifferentialReplayArgs([...baseArgv()]).write).toBe(false);
    expect(parseDifferentialReplayArgs([...baseArgv(), "--write", "1"]).write).toBe(true);
  });
});

function baseArgv() {
  return [
    "--business", "biz-1",
    "--startDate", "2026-08-25",
    "--endDate", "2026-09-20",
  ];
}

describe("it is bounded", () => {
  it("fetches one row past the ceiling so a full page is not called truncated", () => {
    for (const sql of [REPLAY_AD_DAY_SQL, REPLAY_HELD_DECISION_SQL]) {
      expect(sql).toContain("LIMIT ($4::int + 1)");
    }
    const exactlyFull = buildDifferentialFromRows(
      [adDay(), adDay()],
      [],
      SCOPE,
      { maxRows: 2, queryTimeoutMs: 1_000 },
    );
    expect(exactlyFull.truncatedByMaxRows).toBe(false);
    expect(exactlyFull.adDaysExamined).toBe(2);

    const overflowing = buildDifferentialFromRows(
      [adDay(), adDay(), adDay()],
      [],
      SCOPE,
      { maxRows: 2, queryTimeoutMs: 1_000 },
    );
    expect(overflowing.truncatedByMaxRows).toBe(true);
    expect(overflowing.adDaysExamined).toBe(2);
  });

  it("takes the ad-grain creative baseline from meta_ad_dimensions", () => {
    /*
      meta_creative_daily.ad_id holds a synthetic creative slug, so it cannot
      join at ad grain: 0 of 610 live ad-days matched it. Using it as the
      baseline would credit the repair with resolving what the old reader never
      attempted.
    */
    expect(REPLAY_AD_DAY_SQL).toContain("FROM meta_ad_dimensions dim");
    // meta_creative_daily now appears only as the typed objective witness,
    // where it is anchored by real_ad_id — never as the creative baseline.
    const baselineBlock = REPLAY_AD_DAY_SQL.slice(
      0,
      REPLAY_AD_DAY_SQL.indexOf("typed_witness"),
    );
    expect(baselineBlock).not.toContain("FROM meta_creative_daily");
  });

  it("requires one business and refuses an unbounded run", () => {
    expect(() => parseDifferentialReplayArgs(["--startDate", "2026-01-01", "--endDate", "2026-01-02"]))
      .toThrow(/--business is required/);
  });

  it("refuses a date that only looks like one", () => {
    expect(() =>
      parseDifferentialReplayArgs(["--business", "b", "--startDate", "2026-02-31", "--endDate", "2026-03-01"]),
    ).toThrow(DifferentialReplayUsageError);
  });

  it("refuses a range past the ceiling and a row ceiling past its own", () => {
    expect(() =>
      parseDifferentialReplayArgs(["--business", "b", "--startDate", "2026-01-01", "--endDate", "2026-12-31"]),
    ).toThrow(/ceiling is 120/);
    expect(() =>
      parseDifferentialReplayArgs([...baseArgv(), "--maxRows", String(DIFFERENTIAL_REPLAY_BOUNDS.maxRowsCeiling + 1)]),
    ).toThrow(/--maxRows/);
  });

  it("anchors point-in-time on the ORIGINAL job run, not the wall clock", () => {
    expect(REPLAY_PIT_ANCHOR_SQL).toContain("engine_v3_native_ad_decisions_shadow_job");
    expect(REPLAY_PIT_ANCHOR_SQL).toContain("status = 'success'");
  });

  it("classifies against ONE named run, never a per-ad-day cutoff", () => {
    /*
      Runs for as_of_date D start ~03:06 UTC on D, before ad-day D exists, so
      anchoring D to the run stamped D would force exact_pit to 0 for everything
      read out of the payload — a zero that measures the join, not the repair.
      And a run reads its whole window in one pass, so the cutoff is a single
      value supplied by the caller.
    */
    expect(REPLAY_AD_DAY_SQL).not.toContain("pit ON pit.as_of_date = d.date");
    // The cutoff is not carried per row at all: one resolved anchor, one source.
    expect(REPLAY_AD_DAY_SQL).not.toContain("pit_cutoff");
    expect(REPLAY_PIT_ANCHOR_SQL).toContain("LIMIT 1");
    // The settling figure keeps its own, separate cutoff.
    expect(REPLAY_AD_DAY_SQL).toContain("r.as_of_date <= d.date + 90");
    expect(REPLAY_ENGINE_WINDOW_DAYS).toBe(90);
  });

  it("refuses an --asOf run that predates the ad-days it would judge", () => {
    expect(() =>
      parseDifferentialReplayArgs([...baseArgv(), "--asOf", "2026-09-10"]),
    ).toThrow(/never saw the later ad-days/);
    expect(parseDifferentialReplayArgs([...baseArgv(), "--asOf", "2026-09-21"]).asOf)
      .toBe("2026-09-21");
  });

  it("carries BOTH semantics in one query, so they cannot drift apart", () => {
    // Pre-repair expressions are kept verbatim; the repaired side comes from the
    // production contract builder.
    expect(REPLAY_AD_DAY_SQL).toContain("payload_json->>'landing_page_views'");
    expect(REPLAY_AD_DAY_SQL).toContain("jsonb_array_elements");
    expect(REPLAY_AD_DAY_SQL).toContain("AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone)");
    expect(REPLAY_HELD_DECISION_SQL).toContain("authority_blocker = 'campaign_context'");
    expect(REPLAY_OBJECTIVE_SOURCE_SQL).toContain("meta_raw_snapshot_observations");
    expect(REPLAY_OBJECTIVE_SOURCE_SQL).toContain("objective_source_readiness");
  });

  it("keeps EVERY SQL template free of backticks, which would end it early", () => {
    // Four separate times a prose backtick inside one of these blocks broke
    // parsing, so the guard covers all of them rather than one range.
    const source = readFileSync(
      "scripts/creative-decision-center/native-ad-repair-differential-replay.ts",
      "utf8",
    );
    for (const name of [
      "REPLAY_PIT_ANCHOR_SQL",
      "REPLAY_AD_DAY_SQL",
      "REPLAY_HELD_DECISION_SQL",
    ]) {
      const open = `export const ${name} = \``;
      const start = source.indexOf(open);
      expect(start, name).toBeGreaterThan(-1);
      const bodyStart = start + open.length;
      const body = source.slice(bodyStart, source.indexOf("`;", bodyStart));
      expect(body.split("`").length - 1, name).toBe(0);
    }
  });
});

describe("POSITIVE controls — the repair is credited only on retained evidence", () => {
  it("credits a funnel gain to exact_pit when the payload predates the run", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    const funnel = dim(receipt, "funnel_landing_page_view");
    expect(funnel.baselineResolved).toBe(0);
    expect(funnel.repairedResolved).toBe(1);
    expect(funnel.gained).toBe(1);
    expect(funnel.byEvidenceClass.admissible_at_cutoff).toBe(1);
  });

  it("keeps a positive stored link-click count as a measurement", () => {
    // D095: the legacy NOT NULL DEFAULT 0 writer never fabricated a positive.
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    const link = dim(receipt, "link_clicks");
    expect(link.baselineResolved).toBe(1);
    expect(link.repairedResolved).toBe(1);
    expect(link.byEvidenceClass.admissible_at_cutoff).toBe(1);
  });

  it("calls a payload that arrived after the run RESTATED, not a gain it had", () => {
    const receipt = buildDifferentialFromRows(
      [adDay({ row_updated_at: AFTER })],
      [],
      SCOPE,
      BOUNDS,
    );
    const funnel = dim(receipt, "funnel_landing_page_view");
    expect(funnel.gained).toBe(1);
    expect(funnel.byEvidenceClass.admissible_at_cutoff).toBe(0);
    expect(funnel.byEvidenceClass.restated_after_cutoff).toBe(1);
  });

  it("calls every row restated when no successful run covers the cohort", () => {
    const receipt = buildDifferentialFromRows(
      [adDay()],
      [],
      { ...SCOPE, pitAnchor: null },
      BOUNDS,
    );
    expect(receipt.pitAnchor).toBeNull();
    expect(dim(receipt, "funnel_landing_page_view").byEvidenceClass.restated_after_cutoff).toBe(1);
  });

  it("names the evaluation run the differential is a statement about", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    expect(receipt.pitAnchor).toEqual({ asOfDate: "2026-09-21", cutoff: CUTOFF });
    // The anchor is not silently folded into scope.
    expect(Object.keys(receipt.scope).sort()).toEqual(["businessId", "endDate", "startDate"]);
  });

  it("reports settling separately and never lets it change a class", () => {
    /*
      Meta restates a day's insights through its attribution window. That is
      ordinary settling, not a restatement relative to the evaluation run, so it
      is counted on its own and the row stays exact_pit.
    */
    const receipt = buildDifferentialFromRows(
      [adDay({ first_consuming_run_started_at: "2026-09-11T03:06:30.000Z", row_updated_at: "2026-09-11T09:00:00.000Z" })],
      [],
      { ...SCOPE, pitAnchor: { asOfDate: "2026-09-21", cutoff: AFTER } },
      BOUNDS,
    );
    expect(receipt.payloadSettling.restatedAfterFirstConsumingRun).toBe(1);
    expect(receipt.payloadSettling.finalAtFirstConsumingRun).toBe(0);
    expect(dim(receipt, "funnel_landing_page_view").byEvidenceClass.admissible_at_cutoff).toBe(1);
  });

  it("counts an ad-day no run has consumed yet", () => {
    const receipt = buildDifferentialFromRows(
      [adDay({ first_consuming_run_started_at: null })],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(receipt.payloadSettling.noConsumingRunFound).toBe(1);
  });
});

describe("NEGATIVE controls — missing data is reported, never filled", () => {
  it("counts an absent actions array as missing for funnel AND link clicks", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          actions_present: false,
          repaired_lpv: null,
          repaired_lpv_state: "unmeasurable",
          baseline_link_clicks: null,
          reader_link_clicks: null,
          raw_link_click_entries: [],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const funnel = dim(receipt, "funnel_landing_page_view");
    expect(funnel.gained).toBe(0);
    expect(funnel.byEvidenceClass.unresolved_by_reader).toBe(1);
    expect(funnel.missingDataControls.actions_array_absent).toBe(1);
    expect(
      dim(receipt, "link_clicks").missingDataControls
        .link_clicks_column_null_actions_absent,
    ).toBe(1);
  });

  it("WITHDRAWS an uncorroborated legacy link-click zero", () => {
    /*
      D095: a stored zero is a measurement only when the same row's actions
      corroborate it. The shipped effect of the repair in this dimension is
      mostly this withdrawal, not a gain.
    */
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: 0,
          reader_link_clicks: null,
          raw_link_click_entries: [{ action_type: "link_click", value: "41" }],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const link = dim(receipt, "link_clicks");
    expect(link.baselineResolved).toBe(1);
    expect(link.repairedResolved).toBe(0);
    expect(link.withdrawn).toBe(1);
    expect(
      link.missingDataControls.legacy_zero_uncorroborated_by_retained_actions,
    ).toBe(1);
  });

  it("reports raw-recoverable clicks as BACKFILL potential, never a reader gain", () => {
    /*
      The current reader does not recover a positive count from actions when the
      column is null; only the bounded DB repair will. Counting it as gained
      would report work that has not happened.
    */
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: null,
          reader_link_clicks: null,
          raw_link_click_entries: [{ action_type: "link_click", value: "227" }],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const link = dim(receipt, "link_clicks");
    expect(link.gained).toBe(0);
    expect(link.repairedResolved).toBe(0);
    expect(receipt.backfillPotential.linkClicks.wouldWrite).toBe(1);
    expect(receipt.backfillPotential.linkClicks.wouldWriteAndExactPit).toBe(1);
    expect(receipt.backfillPotential.linkClicks.byAction.fill_measured_count).toBe(1);
  });

  it("computes potential with the BACKFILL's contract, not a second opinion", () => {
    /*
      An actions array that was returned and does not list link_click is Meta's
      measured-zero encoding, so classifyAdDayLinkClick calls it a writable
      fill_measured_zero. A bare strict parse would call it unrecoverable, and
      the runner would then contradict the tool whose potential it reports.
    */
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: null,
          reader_link_clicks: null,
          actions_present: true,
          raw_link_click_entries: [],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const potential = receipt.backfillPotential.linkClicks;
    expect(potential.contract).toBe("classifyAdDayLinkClick");
    expect(potential.byAction.fill_measured_zero).toBe(1);
    expect(potential.wouldWrite).toBe(1);
  });

  it("counts a row the backfill cannot fix without a provider re-sync", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: null,
          reader_link_clicks: null,
          actions_present: false,
          raw_link_click_entries: [],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const potential = receipt.backfillPotential.linkClicks;
    expect(potential.byAction.unmeasurable_no_actions_payload).toBe(1);
    expect(potential.wouldWrite).toBe(0);
    expect(potential.requiresProviderResync).toBe(1);
  });

  it("names a malformed raw value as unrecoverable instead of a zero", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: null,
          reader_link_clicks: null,
          raw_link_click_entries: [{ action_type: "link_click", value: "12.7" }],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(
      receipt.backfillPotential.linkClicks.byAction.malformed_actions_value,
    ).toBe(1);
    expect(receipt.backfillPotential.linkClicks.wouldWrite).toBe(0);
  });

  it("flags a reader value the retained raw contradicts", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          baseline_link_clicks: 228,
          reader_link_clicks: 228,
          raw_link_click_entries: [{ action_type: "link_click", value: "227" }],
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(
      receipt.backfillPotential.linkClicks.byAction.conflict_stored_measurement,
    ).toBe(1);
    // A conflict is never written: the backfill does not lower a stored value.
    expect(receipt.backfillPotential.linkClicks.wouldWrite).toBe(0);
  });

  it("records the future-config leak as a WITHDRAWAL, not a loss of coverage", () => {
    // Baseline had an objective only because the newest config postdated the day.
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          objective_source_value: null,
          objective_source_tier: "unknown",
          objective_source_readiness: "none",
          objective_source_class: "none",
          objective_source_pit_class: "restated",
          asof_objective: null,
          asof_objective_source_kind: null,
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const objective = dim(receipt, "campaign_objective_field_source");
    expect(objective.withdrawn).toBe(1);
    expect(objective.gained).toBe(0);
    expect(objective.byEvidenceClass.unresolved_by_reader).toBe(1);
  });

  it("refuses an Insights-derived config value as objective evidence", () => {
    /*
      Live, every resolvable row in meta_campaign_config_history is
      source_kind 'warehouse_daily' restated from an ad_insights_bulk snapshot.
      Crediting it would be the fabrication this runner exists to avoid.
    */
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          objective_source_value: null,
          objective_source_tier: "unknown",
          objective_source_readiness: "none",
          objective_source_class: "none",
          objective_source_pit_class: "restated",
          asof_objective_source_kind: "warehouse_daily",
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const objective = dim(receipt, "campaign_objective_field_source");
    expect(objective.repairedResolved).toBe(0);
    expect(objective.byEvidenceClass.unresolved_by_reader).toBe(1);
    expect(
      objective.missingDataControls.objective_derived_history_unverified_warehouse_daily,
    ).toBe(1);
    // ...and it is NOT reported as the config having never been captured.
    expect(objective.missingDataControls.objective_no_admissible_field_source).toBeUndefined();
  });

  it("names exactly one source_kind as a config observation", () => {
    expect(CONFIG_RECEIPT_SOURCE_KIND).toBe("provider_config_receipt");
  });

  it("reports a value not admitted by the field-source contract as unresolved", () => {
    /*
      config_history is a change log: a later observation that finds the config
      unchanged coalesces into the existing row, so requiring a same-day capture
      would call healthy unchanged days unknown. But carrying an older receipt
      forward needs proof the config was observed again that day, which this
      table cannot give. So it resolves nothing AND is named.
    */
    const receipt = buildDifferentialFromRows(
      [adDay({
        objective_source_value: null,
        objective_source_tier: "unknown",
        objective_source_readiness: "none",
        objective_source_class: "none",
        objective_source_pit_class: "restated",
      })],
      [],
      SCOPE,
      BOUNDS,
    );
    const objective = dim(receipt, "campaign_objective_field_source");
    expect(objective.repairedResolved).toBe(0);
    expect(
      objective.missingDataControls.objective_no_admissible_field_source,
    ).toBe(1);
  });

  it("never returns a config value the source contract classifies as restated", () => {
    const lateWrite = buildDifferentialFromRows(
      [adDay({
        objective_source_value: null,
        objective_source_tier: "unknown",
        objective_source_readiness: "none",
        objective_source_class: "none",
        objective_source_pit_class: "restated",
      })],
      [],
      SCOPE,
      BOUNDS,
    );
    const objective = dim(lateWrite, "campaign_objective_field_source");
    expect(objective.repairedResolved).toBe(0);
    expect(objective.byEvidenceClass.unresolved_by_reader).toBe(1);

    const lateCapture = buildDifferentialFromRows(
      [adDay({ repaired_creative_captured_at: AFTER })],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(dim(lateCapture, "ad_creative_attribution").byEvidenceClass.restated_after_cutoff).toBe(1);
  });

  it("fails if a future objective ever crosses the source-contract boundary", () => {
    expect(() =>
      buildDifferentialFromRows(
        [adDay({ objective_source_pit_class: "restated" })],
        [],
        SCOPE,
        BOUNDS,
      ),
    ).toThrow(/inadmissible value/);
  });

  it("never resolves a creative from absence evidence", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          repaired_creative_presence: "absent_unconfirmed",
          repaired_creative_has_coverage: false,
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const creative = dim(receipt, "ad_creative_attribution");
    expect(creative.repairedResolved).toBe(0);
    expect(creative.withdrawn).toBe(1);
    expect(creative.missingDataControls.absence_evidence_only).toBe(1);
  });

  it("records a creative disagreement, which is the collapse being corrected", () => {
    const receipt = buildDifferentialFromRows(
      [adDay({ repaired_creative_id: "creative_b" })],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(dim(receipt, "ad_creative_attribution").disagreed).toBe(1);
  });

  it("fabricates nothing: no dimension gains on an ad-day with no retained input", () => {
    const barren = adDay({
      actions_present: false,
      repaired_lpv: null,
      repaired_lpv_state: "unmeasurable",
      baseline_link_clicks: null,
      reader_link_clicks: null,
      raw_link_click_entries: [],
      baseline_objective: null,
      objective_source_value: null,
      objective_source_tier: "unknown",
      objective_source_readiness: "none",
      objective_source_class: "none",
      objective_source_pit_class: "restated",
      receipt_objective: null,
      receipt_objective_captured_at: null,
      receipt_objective_created_at: null,
      receipt_objective_same_day: null,
      asof_objective: null,
      asof_objective_source_kind: null,
      baseline_creative_id: null,
      repaired_creative_id: null,
      repaired_creative_presence: null,
      repaired_creative_has_coverage: false,
    });
    const receipt = buildDifferentialFromRows([barren], [], SCOPE, BOUNDS);
    for (const entry of receipt.dimensions) {
      expect(entry.gained, entry.dimension).toBe(0);
      expect(entry.byEvidenceClass.unresolved_by_reader, entry.dimension).toBe(1);
    }
    expect(dim(receipt, "campaign_objective_field_source").missingDataControls
      .objective_no_admissible_field_source).toBe(1);
  });
});

describe("the decision-semantics differential grants no authority", () => {
  const held = (blocked: string, label: string) => ({
    label,
    blocked_action_type: blocked,
    authority_blocker: "campaign_context",
    authorized_action: null,
  });

  it("moves a held Cut to the action lane and leaves a held Scale held", () => {
    const receipt = buildDifferentialFromRows(
      [],
      [held("cut", "cut"), held("scale", "scale")],
      SCOPE,
      BOUNDS,
    );
    expect(receipt.decisionSemantics.repaired["held=cut lane=act code=apply_cut_manually"]).toBe(1);
    expect(
      receipt.decisionSemantics.repaired["held=scale lane=blocked code=resolve_campaign_role"],
    ).toBe(1);
    expect(
      receipt.decisionSemantics.baseline["held=cut lane=blocked code=resolve_campaign_role"],
    ).toBe(1);
  });

  it("offers no provider write and unblocks no decision state", () => {
    const receipt = buildDifferentialFromRows(
      [],
      [held("cut", "cut"), held("scale", "scale"), held("refresh", "keep")],
      SCOPE,
      BOUNDS,
    );
    expect(receipt.decisionSemantics.authorityUnchanged).toEqual({
      authorizedActionNonNullBefore: 0,
      providerMutationOfferedAfter: 0,
      decisionStateNotBlockedAfter: 0,
    });
  });
});

describe("it reports only semantics implemented in this tree", () => {
  it("uses the native objective field-source contract and reports readiness", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    const objective = dim(receipt, "campaign_objective_field_source");
    expect(objective.repairedSemantics).toBe("reader_implemented_in_tree");
    expect(objective.repairedResolved).toBe(1);
    expect(receipt.objectiveSourceReadiness).toEqual({
      decision_authority: 1,
      review_only: 0,
      none: 0,
    });
  });

  it("scopes the link-click dimension to the band reader it actually measures", () => {
    // The resolver cumulative total and native calibration still read the raw
    // column; a "repaired" link-click figure must not be read as every path.
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    expect(dim(receipt, "link_clicks").readerScope).toBe(
      "refresh_band_reader_only_resolver_cumulative_and_calibration_still_read_the_raw_column",
    );
    expect(REPLAY_AD_DAY_SQL).not.toContain("cannot classify one row two ways");
  });

  it("labels every dimension as a reader that exists in this tree", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    for (const entry of receipt.dimensions) {
      expect(entry.repairedSemantics, entry.dimension).toBe(
        "reader_implemented_in_tree",
      );
    }
  });

  it("states that nothing measured here is deployed", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    expect(receipt.claim.readerSemanticsDeployed).toBe(false);
  });
});

describe("the two axes stay independent", () => {
  it("counts timeliness and auditability separately", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    // The funnel comes out of the retained verbatim payload.
    const funnel = dim(receipt, "funnel_landing_page_view");
    expect(funnel.byEvidenceClass.admissible_at_cutoff).toBe(1);
    expect(funnel.byAuditability.exact_observation).toBe(1);
    // The creative is contemporaneous but has no row-level raw pointer.
    const creative = dim(receipt, "ad_creative_attribution");
    expect(creative.byEvidenceClass.admissible_at_cutoff).toBe(1);
    // Auditable one hop out, through the observation run, but bitemporal.
    expect(creative.byAuditability.bitemporal_observation).toBe(1);
    expect(creative.byAuditability.exact_observation).toBe(0);
  });

  it("puts a stored-positive link click with no actions on the typed side", () => {
    const receipt = buildDifferentialFromRows(
      [adDay({ actions_present: false, reader_link_clicks: 227, repaired_lpv_state: "unmeasurable", repaired_lpv: null })],
      [],
      SCOPE,
      BOUNDS,
    );
    const link = dim(receipt, "link_clicks");
    expect(link.repairedResolved).toBe(1);
    expect(link.byAuditability.persisted_input).toBe(1);
    expect(link.byAuditability.exact_observation).toBe(0);
  });

  it("gives an unresolved row no auditability at all", () => {
    const receipt = buildDifferentialFromRows(
      [adDay({ repaired_creative_presence: "absent_unconfirmed", repaired_creative_has_coverage: false })],
      [],
      SCOPE,
      BOUNDS,
    );
    expect(dim(receipt, "ad_creative_attribution").byAuditability.none).toBe(1);
  });

  it("reports a typed contemporaneous objective as review-only evidence", () => {
    const receipt = buildDifferentialFromRows(
      [
        adDay({
          objective_source_value: "OUTCOME_SALES",
          objective_source_tier: "typed_contemporaneous",
          objective_source_readiness: "review_only",
          objective_source_class: "typed_unlinked",
          objective_source_pit_class: "as_of_known",
          typed_witness_objective: "OUTCOME_SALES",
          typed_witness_observed_at: BEFORE,
        }),
      ],
      [],
      SCOPE,
      BOUNDS,
    );
    const objective = dim(receipt, "campaign_objective_field_source");
    expect(objective.repairedResolved).toBe(1);
    expect(objective.typedContemporaneousResolved).toBe(1);
    expect(receipt.objectiveSourceReadiness.review_only).toBe(1);
    expect(objective.byAuditability.persisted_input).toBe(1);
  });

  it("requires the strict guards in the typed witness SQL", () => {
    // Two clocks, single ad, and a real_ad_id anchored at ad grain.
    expect(REPLAY_AD_DAY_SQL).toContain("associated_ads_count");
    expect(REPLAY_AD_DAY_SQL).toContain("real_ad_id");
    expect(REPLAY_AD_DAY_SQL).toContain("anchor.campaign_id = d.campaign_id");
  });
});

describe("the receipt states what it is not", () => {
  it("refuses to be read as integrated-job or wall-clock PIT proof", () => {
    const receipt = buildDifferentialFromRows([adDay()], [], SCOPE, BOUNDS);
    expect(receipt.claim).toEqual({
      provesIntegratedNativeJob: false,
      provesPointInTimeValidity: "only_for_rows_admissible_at_cutoff",
      resolverChanged: false,
      readerSemanticsDeployed: false,
      evidenceLanes: {
        readerDimensions: "current_tree_readers_over_retained_rows",
        decisionSemantics:
          "current_tree_pure_transforms_over_persisted_held_rows_with_fixed_context",
        decisionsRecomputed: false,
        integratedPersistedJob: false,
        providerMutation: "none_no_provider_client_in_this_runner",
        databaseWrites: "none_read_only_transaction",
      },
      // Built from rows handed in directly: no snapshot to speak for.
      consistentSnapshot: false,
    });
    expect(receipt.snapshot).toBeNull();
    expect(receipt.mode).toBe("read_only_differential_replay");
  });

  it("imports no provider client, so no lane can mutate Meta", () => {
    const source = readFileSync(
      "scripts/creative-decision-center/native-ad-repair-differential-replay.ts",
      "utf8",
    );
    for (const client of ["graph.facebook.com", "ads-write", "launch-write", "fetch("]) {
      expect(source, client).not.toContain(client);
    }
  });
});

/*
  ── ONE SNAPSHOT FOR THE WHOLE DIFFERENTIAL ─────────────────────────────────

  The anchor run, the ad-days, their objective sources and the held decisions
  used to be read through the pool — one autocommit snapshot per statement,
  while the sync jobs kept writing. A fake query records the statement order
  and plays the database's part, so the ordering contract is asserted rather
  than described.
*/
function scriptedDb(overrides: {
  isolation?: string;
  transactionReadOnly?: string;
  sessionReadOnly?: string;
  anchor?: Record<string, unknown> | null;
  adDays?: Array<Record<string, unknown>>;
  objectives?: Array<Record<string, unknown>>;
  held?: Array<Record<string, unknown>>;
} = {}) {
  const statements: string[] = [];
  const query = async (text: string) => {
    statements.push(text.trim().split(/\s+/).slice(0, 4).join(" "));
    if (text.startsWith("SET TRANSACTION")) return [];
    if (text === "SHOW default_transaction_read_only") {
      return [{ default_transaction_read_only: overrides.sessionReadOnly ?? "on" }];
    }
    if (text === "SHOW transaction_isolation") {
      return [{ transaction_isolation: overrides.isolation ?? "repeatable read" }];
    }
    if (text === "SHOW transaction_read_only") {
      return [{ transaction_read_only: overrides.transactionReadOnly ?? "on" }];
    }
    if (text.includes("txid_current_snapshot")) {
      return [{ started_at: "2026-09-22T10:00:00.000Z", snapshot_id: "100:105:" }];
    }
    if (text === REPLAY_PIT_ANCHOR_SQL) {
      return overrides.anchor === null
        ? []
        : [overrides.anchor ?? { as_of_date: "2026-09-21", pit_cutoff: CUTOFF }];
    }
    if (text === REPLAY_AD_DAY_SQL) return overrides.adDays ?? [adDay()];
    if (text === REPLAY_OBJECTIVE_SOURCE_SQL) {
      return overrides.objectives ?? [{
        provider_account_id: "act_1", campaign_id: "cmp_1", ad_id: "ad_1", date: "2026-09-10",
        objective_source_value: "OUTCOME_SALES",
        objective_source_tier: "provider_receipt_day_bracketed",
        objective_source_readiness: "decision_authority",
        objective_source_class: "modern",
        objective_source_pit_class: "as_of_known",
      }];
    }
    if (text === REPLAY_HELD_DECISION_SQL) return overrides.held ?? [];
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  };
  return { query, statements };
}

const REPLAY_ARGS = parseDifferentialReplayArgs([
  "--business", "biz-1",
  "--startDate", "2026-08-25",
  "--endDate", "2026-09-20",
]);

describe("every read shares one pinned read-only snapshot", () => {
  it("pins REPEATABLE READ, READ ONLY before any snapshot-taking read", async () => {
    const db = scriptedDb();
    const receipt = await executeDifferentialReplay(db.query, REPLAY_ARGS);
    expect(db.statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL");
    // The identity read is the first statement that takes a snapshot; every
    // data read comes after it.
    const firstData = db.statements.findIndex((s) => s.startsWith("SELECT as_of_date"));
    const identity = db.statements.findIndex((s) => s.startsWith("SELECT transaction_timestamp()"));
    expect(identity).toBeGreaterThan(0);
    expect(firstData).toBeGreaterThan(identity);
    expect(receipt.claim.consistentSnapshot).toBe(true);
    expect(receipt.snapshot).toEqual({
      isolation: "repeatable read",
      transactionReadOnly: true,
      sessionDefaultReadOnly: true,
      transactionStartedAt: "2026-09-22T10:00:00.000Z",
      snapshotId: "100:105:",
    });
  });

  it("refuses to run when the transaction is not repeatable read", async () => {
    // NEGATIVE: a pooled autocommit statement reports read committed.
    const db = scriptedDb({ isolation: "read committed" });
    await expect(executeDifferentialReplay(db.query, REPLAY_ARGS))
      .rejects.toBeInstanceOf(ReadOnlySnapshotError);
    expect(db.statements.some((s) => s.startsWith("SELECT as_of_date"))).toBe(false);
  });

  it("refuses to run when the transaction or the session could write", async () => {
    await expect(
      executeDifferentialReplay(scriptedDb({ transactionReadOnly: "off" }).query, REPLAY_ARGS),
    ).rejects.toThrow(/not read only/);
    await expect(
      executeDifferentialReplay(scriptedDb({ sessionReadOnly: "off" }).query, REPLAY_ARGS),
    ).rejects.toThrow(/read-only session/);
  });

  it("throws a usage error instead of exiting inside the transaction", async () => {
    const db = scriptedDb({ anchor: { as_of_date: "2026-12-31", pit_cutoff: CUTOFF } });
    await expect(executeDifferentialReplay(db.query, REPLAY_ARGS))
      .rejects.toBeInstanceOf(DifferentialReplayUsageError);
  });

  it("main() runs the replay inside runDbTransaction, never through the bare pool", () => {
    const source = readFileSync(
      "scripts/creative-decision-center/native-ad-repair-differential-replay.ts",
      "utf8",
    );
    const main = source.slice(source.indexOf("async function main()"));
    expect(main).toContain("runDbTransaction(");
    expect(main).toContain("executeDifferentialReplay(");
    // The data reads live in executeDifferentialReplay, which main only calls
    // inside the transaction.
    expect(main).not.toContain("REPLAY_AD_DAY_SQL");
    expect(main).not.toContain("REPLAY_HELD_DECISION_SQL");
  });
});

describe("the held-decision population is deterministic and its ceiling is reported", () => {
  it("orders on a total key before the LIMIT", () => {
    const normalized = REPLAY_HELD_DECISION_SQL.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /ORDER BY as_of_date, provider_account_id, decision_entity_id, scope_type, scope_id, engine_version, id LIMIT \(\$4::int \+ 1\)/,
    );
  });

  const held = (label: string) => ({
    label,
    blocked_action_type: label,
    authority_blocker: "campaign_context",
    authorized_action: null,
    engine_version: "v3-ad-epoch-a",
  });

  it("NEGATIVE: a truncated held set is no longer reported as complete", () => {
    // Ad-days fit; held decisions overflow. The old flag read ad-days only.
    const receipt = buildDifferentialFromRows(
      [adDay()],
      [held("cut"), held("scale"), held("cut")],
      SCOPE,
      { maxRows: 2, queryTimeoutMs: 1_000 },
    );
    expect(receipt.truncation).toEqual({ adDays: false, heldDecisions: true });
    expect(receipt.truncatedByMaxRows).toBe(true);
    expect(receipt.decisionSemantics.heldRowsExamined).toBe(2);
  });

  it("POSITIVE: an exactly-full held set is not called truncated", () => {
    const receipt = buildDifferentialFromRows(
      [adDay()],
      [held("cut"), held("scale")],
      SCOPE,
      { maxRows: 2, queryTimeoutMs: 1_000 },
    );
    expect(receipt.truncation).toEqual({ adDays: false, heldDecisions: false });
    expect(receipt.truncatedByMaxRows).toBe(false);
  });

  it("reports which engine epoch persisted each examined held row", () => {
    const receipt = buildDifferentialFromRows(
      [],
      [held("cut"), { ...held("scale"), engine_version: "v3-ad-epoch-b" }],
      SCOPE,
      BOUNDS,
    );
    expect(receipt.decisionSemantics.heldRowsByEngineVersion).toEqual({
      "v3-ad-epoch-a": 1,
      "v3-ad-epoch-b": 1,
    });
  });
});
