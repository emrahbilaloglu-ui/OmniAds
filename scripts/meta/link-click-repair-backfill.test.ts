/**
 * The link-click repair command's PLANNING and BOUNDING logic.
 *
 * This file deliberately does not prove that the repair repairs anything —
 * that claim is about rows a previous statement committed, so it is proved
 * against a real, migrated PostgreSQL in
 * `scripts/meta/link-click-repair-backfill.db.test.ts`, which the ephemeral
 * seam gate spawns.
 *
 * What is proved here is everything a database cannot answer: that the two
 * bands are equal, disjoint and directly adjacent; that no combination of flags
 * lets the command run away; that a dry run writes nothing; that ABSENT and
 * MEASURED ZERO are decided by the payload rather than by a default; and that a
 * truncated plan is refused instead of being applied to half a band pair.
 */
import { describe, expect, it } from "vitest";

import {
  LINK_CLICK_REPAIR_BOUNDS,
  LINK_CLICK_REPAIR_EXECUTE_ENV,
  LINK_CLICK_REPAIR_PAGE_SQL,
  LINK_CLICK_REPAIR_UPDATE_SQL,
  LinkClickRepairUsageError,
  assertPlanIsNotSilentlyPartial,
  assertSingleColumnRepairStatement,
  bandKeyForDate,
  classifyAdDayLinkClick,
  cursorAdvanced,
  isRetryableRepairError,
  maxPageCountFor,
  parseLinkClickRepairArgs,
  parseStoredLinkClicks,
  planLinkClickRepairScope,
  retryDelayMsFor,
  runLinkClickRepair,
  type LinkClickRepairDb,
  type LinkClickRepairOptions,
} from "./link-click-repair-backfill";

const MS_PER_DAY = 86_400_000;

function baseArgv(extra: string[] = []) {
  return ["--business", "biz-1", "--as-of", "2026-09-06", ...extra];
}

function optionsFor(overrides: Partial<LinkClickRepairOptions> = {}): LinkClickRepairOptions {
  return {
    businessId: "biz-1",
    providerAccountIds: null,
    asOfDate: "2026-09-06",
    bandDays: 14,
    // The repair reads as of the same instant a decision for this day reads.
    admissibilityCutoff: "2026-09-06T23:59:59.999Z",
    maxRows: LINK_CLICK_REPAIR_BOUNDS.maxRowsDefault,
    pageSize: LINK_CLICK_REPAIR_BOUNDS.pageSizeDefault,
    maxAttempts: LINK_CLICK_REPAIR_BOUNDS.maxAttemptsDefault,
    execute: false,
    allowPartial: false,
    skipMeasuredZero: false,
    receiptOutPath: null,
    ...overrides,
  };
}

interface RecordedQuery {
  text: string;
  values: unknown[];
}

/**
 * A stub client that records every statement.
 *
 * The point of the stub is to make the LOOP observable — how many pages it
 * asks for, with which cursor, and whether it ever reaches the UPDATE. A real
 * database would answer the same questions less precisely, and the questions
 * that genuinely need one are asked in the `.db.test.ts` sibling.
 */
function recordingDb(
  respond: (text: string, values: unknown[], callIndex: number) => unknown[],
) {
  const queries: RecordedQuery[] = [];
  const db: LinkClickRepairDb = {
    query: async <TRow,>(text: string, values: unknown[]) => {
      const callIndex = queries.length;
      queries.push({ text, values });
      return respond(text, values, callIndex) as TRow[];
    },
  };
  /*
    A faithful in-memory stand-in for the pinned transaction: the callback runs
    against the SAME handle, so the executor's contract ("everything inside one
    client") is expressible here. The real client pinning is proven against a
    real pool in the database seam, which is the only place it can be.
  */
  db.transaction = async <T,>(fn: (tx: LinkClickRepairDb) => Promise<T>) =>
    fn(db);

  return { db, queries };
}

function pageRow(input: {
  account?: string;
  date: string;
  adId: string;
  stored?: string | null;
  actionsPresent?: boolean;
  values?: string[];
}) {
  return {
    provider_account_id: input.account ?? "act_1",
    date: input.date,
    ad_id: input.adId,
    stored_link_clicks: input.stored === undefined ? null : input.stored,
    actions_present: input.actionsPresent ?? true,
    link_click_values: input.values ?? [],
  };
}

const noSleep = async () => {};

describe("band planning produces the equal, disjoint, directly adjacent pair", () => {
  it("splits the 28 days before the as-of day into two 14-day bands", () => {
    const scope = planLinkClickRepairScope({ asOfDate: "2026-09-06", bandDays: 14 });
    expect(scope.recent).toEqual({
      key: "recent14",
      startDate: "2026-08-24",
      endDate: "2026-09-06",
    });
    expect(scope.prior).toEqual({
      key: "prior14",
      startDate: "2026-08-10",
      endDate: "2026-08-23",
    });
    expect(scope.windowStartDate).toBe("2026-08-10");
    expect(scope.windowEndDate).toBe("2026-09-06");
  });

  it("makes the bands equal, non-overlapping and separated by no gap", () => {
    const scope = planLinkClickRepairScope({ asOfDate: "2026-03-01", bandDays: 14 });
    const span = (start: string, end: string) =>
      Math.round(
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY,
      ) + 1;
    expect(span(scope.recent.startDate, scope.recent.endDate)).toBe(14);
    expect(span(scope.prior.startDate, scope.prior.endDate)).toBe(14);
    // Directly adjacent: the prior band ends the calendar day before the
    // recent band starts. This is the arithmetic `admitCompositeBand` checks.
    expect(
      Date.parse(`${scope.recent.startDate}T00:00:00Z`) -
        Date.parse(`${scope.prior.endDate}T00:00:00Z`),
    ).toBe(MS_PER_DAY);
    // 2026 is not a leap year, so the pair must cross February at 28 days.
    expect(scope.prior.startDate).toBe("2026-02-02");
    expect(scope.recent.endDate).toBe("2026-03-01");
  });

  it("assigns every day in the window to exactly one band", () => {
    const scope = planLinkClickRepairScope({ asOfDate: "2026-09-06", bandDays: 14 });
    const seen: Record<string, number> = { prior14: 0, recent14: 0 };
    for (let offset = 0; offset < 28; offset += 1) {
      const day = new Date(
        Date.parse(`${scope.windowStartDate}T00:00:00Z`) + offset * MS_PER_DAY,
      )
        .toISOString()
        .slice(0, 10);
      const band = bandKeyForDate(scope, day);
      expect(band).not.toBeNull();
      seen[band!] += 1;
    }
    expect(seen).toEqual({ prior14: 14, recent14: 14 });
    expect(bandKeyForDate(scope, "2026-08-09")).toBeNull();
    expect(bandKeyForDate(scope, "2026-09-07")).toBeNull();
  });

  it("refuses a date that only looks like one", () => {
    // Date.parse("2026-02-31T00:00:00.000Z") succeeds and rolls to March 3rd,
    // which would silently move the whole 28-day window.
    expect(() => planLinkClickRepairScope({ asOfDate: "2026-02-31", bandDays: 14 })).toThrow(
      LinkClickRepairUsageError,
    );
    expect(() => planLinkClickRepairScope({ asOfDate: "not-a-date", bandDays: 14 })).toThrow(
      LinkClickRepairUsageError,
    );
  });

  it("refuses a band length outside the declared bounds", () => {
    expect(() => planLinkClickRepairScope({ asOfDate: "2026-09-06", bandDays: 0 })).toThrow(
      /--band-days/,
    );
    expect(() => planLinkClickRepairScope({ asOfDate: "2026-09-06", bandDays: 29 })).toThrow(
      /--band-days/,
    );
    expect(() => planLinkClickRepairScope({ asOfDate: "2026-09-06", bandDays: 1.5 })).toThrow(
      /--band-days/,
    );
  });
});

describe("argument parsing is strict, and every bound is enforced at the parser", () => {
  it("requires a business and never runs across all of them", () => {
    expect(() => parseLinkClickRepairArgs([], {})).toThrow(/--business/);
    expect(() => parseLinkClickRepairArgs(["--business", "   "], {})).toThrow(/--business/);
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    // A silently-ignored `--max-row` would let an operator believe a bound was
    // applied that was not.
    expect(() => parseLinkClickRepairArgs(baseArgv(["--max-row", "10"]), {})).toThrow(
      /Unknown argument/,
    );
  });

  it("rejects a flag with no value", () => {
    expect(() => parseLinkClickRepairArgs(["--business"], {})).toThrow(/requires a value/);
    expect(() =>
      parseLinkClickRepairArgs(["--business", "biz-1", "--max-rows", "--execute"], {}),
    ).toThrow(/requires a value/);
  });

  it("caps every numeric bound and rejects non-integers", () => {
    const { maxRowsCeiling, pageSizeCeiling, maxAttemptsCeiling } =
      LINK_CLICK_REPAIR_BOUNDS;
    expect(() =>
      parseLinkClickRepairArgs(baseArgv(["--max-rows", String(maxRowsCeiling + 1)]), {}),
    ).toThrow(/--max-rows must be in/);
    expect(() =>
      parseLinkClickRepairArgs(baseArgv(["--page-size", String(pageSizeCeiling + 1)]), {}),
    ).toThrow(/--page-size must be in/);
    expect(() =>
      parseLinkClickRepairArgs(
        baseArgv(["--max-attempts", String(maxAttemptsCeiling + 1)]),
        {},
      ),
    ).toThrow(/--max-attempts must be in/);
    expect(() => parseLinkClickRepairArgs(baseArgv(["--max-rows", "0"]), {})).toThrow(
      /--max-rows must be in/,
    );
    expect(() => parseLinkClickRepairArgs(baseArgv(["--max-rows", "1e3"]), {})).toThrow(
      /must be an integer/,
    );
  });

  it("clamps a page larger than the row ceiling so the first page cannot overshoot", () => {
    const parsed = parseLinkClickRepairArgs(
      baseArgv(["--max-rows", "10", "--page-size", "500"]),
      {},
    );
    expect(parsed.pageSize).toBe(10);
    expect(parsed.maxRows).toBe(10);
  });

  it("rejects a repeated account and caps how many may be named", () => {
    expect(() =>
      parseLinkClickRepairArgs(baseArgv(["--account", "act_1", "--account", "act_1"]), {}),
    ).toThrow(/was passed twice/);
    const many = Array.from(
      { length: LINK_CLICK_REPAIR_BOUNDS.maxAccounts + 1 },
      (_unused, index) => ["--account", `act_${index}`],
    ).flat();
    expect(() => parseLinkClickRepairArgs(baseArgv(many), {})).toThrow(
      /may be repeated at most/,
    );
  });

  it("defaults to a dry run and needs two independent gestures to write", () => {
    expect(parseLinkClickRepairArgs(baseArgv(), {}).execute).toBe(false);
    expect(() => parseLinkClickRepairArgs(baseArgv(["--execute"]), {})).toThrow(
      new RegExp(LINK_CLICK_REPAIR_EXECUTE_ENV),
    );
    expect(() =>
      parseLinkClickRepairArgs(baseArgv(["--execute"]), {
        [LINK_CLICK_REPAIR_EXECUTE_ENV]: "0",
      }),
    ).toThrow(new RegExp(LINK_CLICK_REPAIR_EXECUTE_ENV));
    expect(
      parseLinkClickRepairArgs(baseArgv(["--execute"]), {
        [LINK_CLICK_REPAIR_EXECUTE_ENV]: "1",
      }).execute,
    ).toBe(true);
  });

  it("validates --as-of at parse time, before anything opens a connection", () => {
    expect(() =>
      parseLinkClickRepairArgs(["--business", "biz-1", "--as-of", "2026-13-01"], {}),
    ).toThrow(LinkClickRepairUsageError);
  });

  it("falls back to today only when --as-of is omitted", () => {
    const parsed = parseLinkClickRepairArgs(["--business", "biz-1"], {}, () => "2026-09-06");
    expect(parsed.asOfDate).toBe("2026-09-06");
  });
});

describe("the page ceiling is derived from the row ceiling, never configured", () => {
  it("never buys more pages than rows", () => {
    expect(maxPageCountFor(5_000, 500)).toBe(11);
    expect(maxPageCountFor(10, 500)).toBe(2);
    expect(maxPageCountFor(1, 1)).toBe(2);
  });
});

describe("the keyset cursor must advance strictly", () => {
  it("treats a repeated key as no progress", () => {
    const cursor = { providerAccountId: "act_1", date: "2026-09-01", adId: "ad-2" };
    expect(cursorAdvanced(null, cursor)).toBe(true);
    expect(cursorAdvanced(cursor, cursor)).toBe(false);
  });

  it("orders by account, then date, then ad id — the unique index order", () => {
    const at = (providerAccountId: string, date: string, adId: string) => ({
      providerAccountId,
      date,
      adId,
    });
    expect(cursorAdvanced(at("act_1", "2026-09-01", "ad-2"), at("act_2", "2026-01-01", "ad-1"))).toBe(
      true,
    );
    expect(cursorAdvanced(at("act_2", "2026-01-01", "ad-1"), at("act_1", "2026-09-01", "ad-2"))).toBe(
      false,
    );
    expect(cursorAdvanced(at("act_1", "2026-09-01", "ad-2"), at("act_1", "2026-09-02", "ad-1"))).toBe(
      true,
    );
    expect(cursorAdvanced(at("act_1", "2026-09-01", "ad-2"), at("act_1", "2026-09-01", "ad-3"))).toBe(
      true,
    );
    expect(cursorAdvanced(at("act_1", "2026-09-01", "ad-3"), at("act_1", "2026-09-01", "ad-2"))).toBe(
      false,
    );
  });
});

describe("ABSENT and MEASURED ZERO are decided by the payload, never by a default", () => {
  it("leaves a NULL alone when the row carries no actions array", () => {
    // This is the invariant the whole repair rests on: writing 0 here would be
    // the same fabrication the repair exists to undo, one layer down.
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: null,
        actionsPresent: false,
        linkClickValues: [],
      }),
    ).toEqual({
      action: "unmeasurable_no_actions_payload",
      writeValue: null,
      derived: null,
    });
  });

  it("keeps a skip-measured-zero classification out of provider re-sync residuals", async () => {
    const { db } = recordingDb((_text, _values, callIndex) =>
      callIndex === 0
        ? [pageRow({ date: "2026-08-24", adId: "ad-measured-zero", values: [] })]
        : [],
    );

    const result = await runLinkClickRepair({
      db,
      options: optionsFor({
        pageSize: 10,
        maxRows: 100,
        skipMeasuredZero: true,
      }),
      sleep: noSleep,
    });

    expect(result.actions.skipped_measured_zero).toBe(1);
    expect(result.actions.unmeasurable_no_actions_payload).toBe(0);
    expect(result.residualNeedingProviderResync).toBe(0);
  });

  it("writes the payload's count over a NULL", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: null,
        actionsPresent: true,
        linkClickValues: ["141"],
      }),
    ).toEqual({ action: "fill_measured_count", writeValue: 141, derived: 141 });
  });

  it("writes a measured zero when the actions array was returned without the entry", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: null,
        actionsPresent: true,
        linkClickValues: [],
      }),
    ).toEqual({ action: "fill_measured_zero", writeValue: 0, derived: 0 });
  });

  it("holds that same row when --skip-measured-zero turns the inference off", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: null,
        actionsPresent: true,
        linkClickValues: [],
        skipMeasuredZero: true,
      }),
    ).toEqual({
      action: "skipped_measured_zero",
      writeValue: null,
      derived: 0,
    });
  });

  it("corrects a stored 0 the row's own payload disproves", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 0,
        actionsPresent: true,
        linkClickValues: ["12"],
      }),
    ).toEqual({ action: "correct_fabricated_zero", writeValue: 12, derived: 12 });
  });

  it("never lowers or overwrites a stored positive", () => {
    // A stored positive came from a writer that supplied a real count; the
    // payload disagreeing with it is a question for a human, not a write.
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 7,
        actionsPresent: true,
        linkClickValues: ["12"],
      }),
    ).toEqual({ action: "conflict_stored_measurement", writeValue: null, derived: 12 });
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 7,
        actionsPresent: true,
        linkClickValues: [],
      }),
    ).toEqual({ action: "conflict_stored_measurement", writeValue: null, derived: 0 });
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 7,
        actionsPresent: false,
        linkClickValues: [],
      }),
    ).toEqual({
      action: "stored_positive_unverifiable",
      writeValue: null,
      derived: null,
    });
  });

  it("names, but does not touch, an uncorroborated stored zero", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 0,
        actionsPresent: false,
        linkClickValues: [],
      }),
    ).toEqual({ action: "stored_zero_unprovable", writeValue: null, derived: null });
  });

  it("leaves an already-consistent row alone", () => {
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 12,
        actionsPresent: true,
        linkClickValues: ["12"],
      }).action,
    ).toBe("already_consistent");
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 0,
        actionsPresent: true,
        linkClickValues: ["0"],
      }).action,
    ).toBe("already_consistent");
    expect(
      classifyAdDayLinkClick({
        storedLinkClicks: 0,
        actionsPresent: true,
        linkClickValues: [],
      }).action,
    ).toBe("already_consistent");
  });

  it("refuses a value it cannot read as a non-negative integer", () => {
    for (const values of [
      ["12.5"],
      ["-3"],
      ["abc"],
      [""],
      ["9007199254740993"],
      ["1", "2"],
      [0],
      [null],
      [true],
      [{}],
    ]) {
      expect(
        classifyAdDayLinkClick({
          storedLinkClicks: null,
          actionsPresent: true,
          linkClickValues: values,
        }),
      ).toEqual({ action: "malformed_actions_value", writeValue: null, derived: null });
    }
  });

  it("reads the stored bigint strictly", () => {
    expect(parseStoredLinkClicks(null)).toBeNull();
    expect(parseStoredLinkClicks("0")).toBe(0);
    expect(parseStoredLinkClicks("141")).toBe(141);
    expect(() => parseStoredLinkClicks("12.0")).toThrow(/unparseable_stored_value/);
    expect(() => parseStoredLinkClicks("9007199254740993")).toThrow(
      /unsafe_stored_value/,
    );
  });
});

describe("the repair writes exactly one column", () => {
  it("accepts the shipped statement", () => {
    expect(() => assertSingleColumnRepairStatement(LINK_CLICK_REPAIR_UPDATE_SQL)).not.toThrow();
  });

  it("fails the run if a future edit widens the SET list", () => {
    // Adding a fact column here would turn a projection repair into a second
    // owner of meta_ad_daily, which D066 forbids.
    const widened = LINK_CLICK_REPAIR_UPDATE_SQL.replace(
      "SET link_clicks = v.new_link_clicks",
      "SET link_clicks = v.new_link_clicks,\n        truth_version = d.truth_version + 1",
    );
    expect(() => assertSingleColumnRepairStatement(widened)).toThrow(
      /writes_unexpected_columns/,
    );
  });

  /*
    CODEX B12 — the repair must not restamp the row's own clock.

    The statement used to SET `updated_at = now()`. Decision hydration admits an
    ad-day only when `created_at <= cutoff AND updated_at <= cutoff`, so a
    repaired row's clock jumping to now made it INVISIBLE at every earlier
    point-in-time cutoff: repairing history erased it. The repaired column is a
    projection of the row's own stored payload, not a new observation, so the
    source's freshness is left exactly as the provider set it and the repair's
    own provenance lives in the run receipt instead.
  */
  it("never restamps the source freshness clock", () => {
    expect(LINK_CLICK_REPAIR_UPDATE_SQL).not.toContain("updated_at");
    expect(() =>
      assertSingleColumnRepairStatement(
        LINK_CLICK_REPAIR_UPDATE_SQL.replace(
          "SET link_clicks = v.new_link_clicks",
          "SET link_clicks = v.new_link_clicks,\n        updated_at = now()",
        ),
      ),
    ).toThrow(/writes_unexpected_columns/);
  });

  /*
    CODEX B13 — the repair reads the population decision hydration reads.
  */
  it("applies hydration's admissibility contract to the scan", () => {
    for (const predicate of [
      "d.truth_state = 'finalized'",
      "d.validation_status = 'passed'",
      "d.created_at <= $9::timestamptz",
      "d.updated_at <= $9::timestamptz",
    ]) {
      expect(LINK_CLICK_REPAIR_PAGE_SQL).toContain(predicate);
    }
  });

  it("guards the pre-image so a concurrent authoritative write is never clobbered", () => {
    expect(LINK_CLICK_REPAIR_UPDATE_SQL).toContain(
      "d.link_clicks IS NOT DISTINCT FROM v.pre_image",
    );
  });

  it("never fetches a stored positive as a candidate", () => {
    expect(LINK_CLICK_REPAIR_PAGE_SQL).toContain(
      "(d.link_clicks IS NULL OR d.link_clicks = 0)",
    );
  });
});

describe("the run cannot run away", () => {
  it("stops at the row ceiling and reports the plan as truncated", async () => {
    // A page that is always full, with a cursor that always advances, is the
    // shape an unbounded scan takes.
    let day = 0;
    const { db, queries } = recordingDb((text) => {
      if (!text.includes("UPDATE meta_ad_daily")) {
        day += 1;
        return [
          pageRow({ date: "2026-08-24", adId: `ad-${day}-a`, values: ["1"] }),
          pageRow({ date: "2026-08-24", adId: `ad-${day}-b`, values: ["1"] }),
        ];
      }
      return [];
    });
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ maxRows: 6, pageSize: 2 }),
      sleep: noSleep,
    });
    expect(result.candidatesExamined).toBe(6);
    expect(result.truncatedByMaxRows).toBe(true);
    // Three pages of two, plus the single bounded truncation probe.
    expect(queries).toHaveLength(4);
    expect(queries[3]!.values[7]).toBe(1);
  });

  it("refuses to keep paging when the cursor stops advancing", async () => {
    const { db } = recordingDb(() => [
      pageRow({ date: "2026-08-24", adId: "ad-1", values: ["1"] }),
      pageRow({ date: "2026-08-24", adId: "ad-2", values: ["1"] }),
    ]);
    await expect(
      runLinkClickRepair({
        db,
        options: optionsFor({ maxRows: 100, pageSize: 2 }),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/cursor_did_not_advance/);
  });

  it("stops as soon as a short page says the window is exhausted", async () => {
    const { db, queries } = recordingDb((text, _values, callIndex) => {
      if (text.includes("UPDATE meta_ad_daily")) return [];
      return callIndex === 0
        ? [
            pageRow({ date: "2026-08-24", adId: "ad-1", values: ["3"] }),
            pageRow({ date: "2026-08-25", adId: "ad-2", values: ["4"] }),
          ]
        : [];
    });
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ maxRows: 100, pageSize: 3 }),
      sleep: noSleep,
    });
    expect(queries).toHaveLength(1);
    expect(result.pagesRead).toBe(1);
    expect(result.truncatedByMaxRows).toBe(false);
  });

  it("does not call the truncation probe truncated when the window ended exactly on the ceiling", async () => {
    const { db } = recordingDb((text, _values, callIndex) => {
      if (text.includes("UPDATE meta_ad_daily")) return [];
      return callIndex === 0
        ? [
            pageRow({ date: "2026-08-24", adId: "ad-1", values: ["3"] }),
            pageRow({ date: "2026-08-25", adId: "ad-2", values: ["4"] }),
          ]
        : [];
    });
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ maxRows: 2, pageSize: 2 }),
      sleep: noSleep,
    });
    expect(result.candidatesExamined).toBe(2);
    expect(result.truncatedByMaxRows).toBe(false);
  });
});

describe("a dry run writes nothing, and an execute writes only the planned rows", () => {
  const page = [
    pageRow({ date: "2026-08-24", adId: "ad-fill", values: ["141"] }),
    pageRow({ date: "2026-08-11", adId: "ad-zero", values: [] }),
    pageRow({ date: "2026-08-12", adId: "ad-absent", actionsPresent: false }),
    pageRow({ date: "2026-08-13", adId: "ad-fab", stored: "0", values: ["9"] }),
  ];

  it("issues no UPDATE at all in dry run", async () => {
    const { db, queries } = recordingDb((text, _values, callIndex) =>
      text.includes("UPDATE meta_ad_daily") || callIndex > 0 ? [] : page,
    );
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ pageSize: 10, maxRows: 100 }),
      sleep: noSleep,
    });
    expect(queries.every((query) => !query.text.includes("UPDATE meta_ad_daily"))).toBe(true);
    expect(result.mode).toBe("dry_run");
    expect(result.rowsPlanned).toBe(3);
    expect(result.rowsWritten).toBe(0);
    expect(result.residualNeedingProviderResync).toBe(1);
    expect(result.actions.fill_measured_count).toBe(1);
    expect(result.actions.fill_measured_zero).toBe(1);
    expect(result.actions.correct_fabricated_zero).toBe(1);
    expect(result.actions.unmeasurable_no_actions_payload).toBe(1);
  });

  it("counts every unrepairable payload classification as requiring provider resync", async () => {
    const residuals = [
      pageRow({ date: "2026-08-24", adId: "ad-absent", actionsPresent: false }),
      pageRow({
        date: "2026-08-25",
        adId: "ad-zero-unprovable",
        stored: "0",
        actionsPresent: false,
      }),
      pageRow({ date: "2026-08-26", adId: "ad-malformed", values: ["1.5"] }),
    ];
    const { db } = recordingDb((_text, _values, callIndex) =>
      callIndex === 0 ? residuals : [],
    );

    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ pageSize: 10, maxRows: 100 }),
      sleep: noSleep,
    });

    expect(result.residualNeedingProviderResync).toBe(3);
    expect(result.actions.unmeasurable_no_actions_payload).toBe(1);
    expect(result.actions.stored_zero_unprovable).toBe(1);
    expect(result.actions.malformed_actions_value).toBe(1);
  });

  it("counts both bands separately, so a one-band repair is visible", async () => {
    const { db } = recordingDb((text, _values, callIndex) =>
      text.includes("UPDATE meta_ad_daily") || callIndex > 0 ? [] : page,
    );
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ pageSize: 10, maxRows: 100 }),
      sleep: noSleep,
    });
    const account = result.accounts.find((entry) => entry.providerAccountId === "act_1")!;
    const recent = account.bands.find((band) => band.band === "recent14")!;
    const prior = account.bands.find((band) => band.band === "prior14")!;
    expect(recent.rowsPlanned).toBe(1);
    expect(prior.rowsPlanned).toBe(2);
    expect(prior.candidatesExamined).toBe(3);
    expect(recent.startDate).toBe("2026-08-24");
    expect(prior.endDate).toBe("2026-08-23");
  });

  it("binds the pre-image of every write, including a NULL", async () => {
    const { db, queries } = recordingDb((text, _values, callIndex) => {
      if (text.includes("UPDATE meta_ad_daily")) {
        return [
          { provider_account_id: "act_1", date: "2026-08-24", ad_id: "ad-fill" },
          { provider_account_id: "act_1", date: "2026-08-11", ad_id: "ad-zero" },
        ];
      }
      return callIndex > 0 ? [] : page;
    });
    const result = await runLinkClickRepair({
      db,
      options: optionsFor({ pageSize: 10, maxRows: 100, execute: true }),
      sleep: noSleep,
    });
    const update = queries.find((query) => query.text.includes("UPDATE meta_ad_daily"))!;
    expect(update.values[4]).toEqual([141, 0, 9]);
    expect(update.values[5]).toEqual([null, null, 0]);
    // The third planned row was not in RETURNING, so it is reported as skipped
    // by pre-image drift rather than silently counted as written.
    expect(result.rowsWritten).toBe(2);
    expect(result.rowsSkippedByPreImageDrift).toBe(1);
  });
});

describe("a truncated plan is refused rather than applied to half a band pair", () => {
  const truncated = {
    truncatedByMaxRows: true,
    candidatesExamined: 6,
  } as never;

  it("passes in dry run", () => {
    expect(() =>
      assertPlanIsNotSilentlyPartial(truncated, optionsFor({ maxRows: 6 })),
    ).not.toThrow();
  });

  it("refuses in execute mode", () => {
    expect(() =>
      assertPlanIsNotSilentlyPartial(truncated, optionsFor({ maxRows: 6, execute: true })),
    ).toThrow(/plan_truncated_by_max_rows/);
  });

  it("allows the deliberate override", () => {
    expect(() =>
      assertPlanIsNotSilentlyPartial(
        truncated,
        optionsFor({ maxRows: 6, execute: true, allowPartial: true }),
      ),
    ).not.toThrow();
  });
});

describe("retry is bounded and narrow", () => {
  it("retries a connection failure and gives up at the attempt ceiling", async () => {
    let attempts = 0;
    const db: LinkClickRepairDb = {
      query: async () => {
        attempts += 1;
        const error = new Error("Connection terminated unexpectedly");
        throw error;
      },
    };
    await expect(
      runLinkClickRepair({
        db,
        options: optionsFor({ maxAttempts: 3 }),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/page_read_failed_after_3_attempts/);
    expect(attempts).toBe(3);
  });

  it("does not retry an error that repeating cannot fix", async () => {
    let attempts = 0;
    const db: LinkClickRepairDb = {
      query: async () => {
        attempts += 1;
        throw Object.assign(new Error('column "nope" does not exist'), { code: "42703" });
      },
    };
    await expect(
      runLinkClickRepair({ db, options: optionsFor({ maxAttempts: 5 }), sleep: noSleep }),
    ).rejects.toThrow(/page_read_failed_after_5_attempts/);
    expect(attempts).toBe(1);
  });

  it("classifies only transient failures as retryable", () => {
    expect(isRetryableRepairError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
    expect(isRetryableRepairError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isRetryableRepairError(Object.assign(new Error("x"), { code: "23505" }))).toBe(
      false,
    );
    expect(isRetryableRepairError(new Error("syntax error at or near"))).toBe(false);
  });

  it("caps the backoff", () => {
    expect(retryDelayMsFor(1)).toBe(LINK_CLICK_REPAIR_BOUNDS.retryBaseDelayMs);
    expect(retryDelayMsFor(50)).toBe(LINK_CLICK_REPAIR_BOUNDS.retryMaxDelayMs);
  });
});
