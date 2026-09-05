import { describe, expect, it, vi } from "vitest";

import {
  META_ANOMALY_TYPES,
  deliveryConstrainedAdsetIdsFrom,
  detectAnomaliesForBusiness,
  detectAnomalyEvaluationForBusiness,
} from "@/lib/meta/anomalies";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  // The snapshot's calibration prologue wraps its write in a transaction. The
  // statements still land on the same mocked tag, which is what these suites read.
  runDbTransaction: vi.fn(async (work: () => Promise<unknown>) => work()),
}));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({
    ready: true,
    missingTables: [],
    checkedAt: "2026-09-04T00:00:00.000Z",
  })),
}));

const db = await import("@/lib/db");

/**
 * What a same-day rerun keeps, and what it must never close.
 *
 * ## The half the guide got right
 *
 * `docs/qa/decision-card-apply-harness.md` used to teach that a second
 * snapshot for the same day writes no new anomaly, so the constrained set
 * empties and the cap raise is withheld — and it offered two DELETE statements
 * as the way to "get the decision back". For the `delivery_stall` path that is
 * false, and both statements are gone. Driving `runMetaSnapshotForBusiness`
 * twice on byte-identical warehouse facts in an isolated migrated database
 * showed both runs reporting `anomaliesWritten: 1` and both leaving the ad set
 * carrying the same 1320 minor-unit bid intent.
 *
 * ## The half it then got wrong in the other direction
 *
 * The corrected text claimed the detector is "a pure function of
 * meta_campaign_daily, meta_adset_daily and meta_ad_daily", and this header
 * repeated it. That is true of FOUR of the seven families and false of three:
 *
 * | family | reads |
 * |---|---|
 * | `roas_drop_sudden` | the three warehouse tables only |
 * | `delivery_stall` | the three warehouse tables only |
 * | `policy_block` | the three warehouse tables only |
 * | `cpm_spike` | the three warehouse tables only |
 * | `pacing_failure` | + the wall clock (UTC day fraction) |
 * | `budget_exhausted_early` | + the wall clock AND the business timezone |
 * | `zero_conversions_with_spend` | + the business loss budget |
 *
 * `detectAnomalyEvaluationForBusiness` takes `now` from `input.now ?? new
 * Date()` and `lib/meta/snapshot.ts` passes none, so the wall clock is sampled
 * afresh on every run. A rerun at a different hour therefore puts the two
 * clock-gated families outside their gates — which is CORRECT for detection (a
 * pacing verdict at 02:00 is meaningless) and is exactly why the result
 * distinguishes `evaluatedTypes` from `skipped`.
 *
 * ## What these tests pin
 *
 * 1. The four pure families are stable across a rerun, and still drop out when
 *    the facts genuinely change.
 * 2. No detector reads what a previous run wrote. The day one consults
 *    `meta_decision_snapshots_daily` — a "don't repeat yesterday's anomaly"
 *    filter is the obvious way it would happen — the second run of a day
 *    starts silently dropping a decision the first run made.
 * 3. A family that could not be EVALUATED is reported as skipped rather than
 *    clean, and the writer's resolve step is scoped to the evaluated families
 *    only. Without that, a snapshot at 08:00 local writes a high-severity
 *    `budget_exhausted_early` row and a rerun at 22:00 on byte-identical facts
 *    stamps `resolved_at` on it, because 92% of the local day is outside the
 *    detector's window. The operator's open anomaly disappears with no fact
 *    change behind it.
 */
const SNAPSHOT_DATE = "2026-09-04";

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Twenty-eight ordinary days and a collapse on the newest one: 500 impressions
 * against a 4000 median is an 87.5% fall, which is a high-severity
 * `delivery_stall` and the only evidence in this product that a cap is holding
 * delivery back.
 */
function stalledAdsetRows() {
  return Array.from({ length: 28 }, (_, index) => {
    const age = 27 - index;
    return {
      provider_account_id: "act_1",
      date: addDays(SNAPSHOT_DATE, -age),
      campaign_id: "cmp_1",
      adset_id: "adset_1",
      adset_name: "Broad prospecting",
      adset_status: "ACTIVE",
      spend: age === 0 ? 40 : 80,
      impressions: age === 0 ? 500 : 4000,
      daily_budget: 50,
    };
  });
}

/**
 * The mock records every statement it is asked for, because the claim under
 * test is about which tables the detector reads — not only about what it
 * returns. `alreadyWritten` is the row a previous run left behind: if the
 * detector ever consults it, the recording is what catches it.
 */
function recordingSql(input: {
  adsetRows: Array<Record<string, unknown>>;
  alreadyWritten: Array<Record<string, unknown>>;
}) {
  const statements: string[] = [];
  const tag = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    statements.push(text);
    if (text.includes("FROM meta_adset_daily")) {
      return Promise.resolve(input.adsetRows);
    }
    if (text.includes("FROM meta_decision_snapshots_daily")) {
      return Promise.resolve(input.alreadyWritten);
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string) => {
    statements.push(text);
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>["query"];
  return { tag, statements };
}

describe("a same-day rerun keeps the delivery evidence", () => {
  it("detects the same stall on the second run, with the first run's row already written", async () => {
    const adsetRows = stalledAdsetRows();
    const first = recordingSql({ adsetRows, alreadyWritten: [] });
    vi.mocked(db.getDb).mockReturnValue(first.tag);
    const runOne = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: null,
    });

    /*
      The second run sees the identical facts AND the anomaly row the first run
      wrote. That row is the whole point: the deleted guidance said its presence
      is what suppresses the second detection.
    */
    const second = recordingSql({
      adsetRows,
      alreadyWritten: [
        {
          scope_type: "adset",
          scope_id: "adset_1",
          rec_type: "delivery_stall",
          kind: "anomaly",
          snapshot_date: SNAPSHOT_DATE,
        },
      ],
    });
    vi.mocked(db.getDb).mockReturnValue(second.tag);
    const runTwo = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: null,
    });

    expect(runOne).toHaveLength(1);
    expect(runOne[0]?.type).toBe("delivery_stall");
    expect(runOne[0]?.severity).toBe("high");
    // Byte-identical facts, byte-identical evidence — id included, because the
    // queue's dedupe and the card's key both hang off a stable identity.
    expect(runTwo.map((anomaly) => ({ ...anomaly, detectedAt: null })))
      .toEqual(runOne.map((anomaly) => ({ ...anomaly, detectedAt: null })));
  });

  it("reads the warehouse only — never what a previous run wrote", async () => {
    const second = recordingSql({
      adsetRows: stalledAdsetRows(),
      alreadyWritten: [
        { scope_id: "adset_1", rec_type: "delivery_stall", kind: "anomaly" },
      ],
    });
    vi.mocked(db.getDb).mockReturnValue(second.tag);
    await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: null,
    });

    const all = second.statements.join("\n");
    expect(all).toContain("FROM meta_campaign_daily");
    expect(all).toContain("FROM meta_adset_daily");
    expect(all).toContain("FROM meta_ad_daily");
    // The two tables a rerun-suppressing filter would have to consult.
    expect(all).not.toContain("meta_decision_snapshots_daily");
    expect(all).not.toContain("meta_automation_proposals");
  });

  it("hands the bid policy the same constrained ad set on both runs", async () => {
    const adsetRows = stalledAdsetRows();
    const constrained: Array<string[]> = [];
    for (const alreadyWritten of [[], [{ scope_id: "adset_1" }]]) {
      const sql = recordingSql({ adsetRows, alreadyWritten });
      vi.mocked(db.getDb).mockReturnValue(sql.tag);
      const anomalies = await detectAnomaliesForBusiness({
        businessId: "biz_1",
        snapshotDate: SNAPSHOT_DATE,
        calibrationContext: null,
        profile: null,
      });
      constrained.push([...deliveryConstrainedAdsetIdsFrom(anomalies)].sort());
    }
    expect(constrained[0]).toEqual(["adset_1"]);
    // Stable, not frozen: the third acceptance run in the harness probe moves
    // this set to empty the moment the impressions recover.
    expect(constrained[1]).toEqual(constrained[0]);
  });

  it("drops the evidence when the facts actually change", async () => {
    /*
      The falsifier for the two assertions above. Without it "stable" and
      "frozen" look identical, and a detector that returned a cached list would
      pass every test in this file.
    */
    const recovered = stalledAdsetRows().map((row) =>
      row.date === SNAPSHOT_DATE ? { ...row, impressions: 4000 } : row,
    );
    const sql = recordingSql({ adsetRows: recovered, alreadyWritten: [] });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: null,
    });
    expect(anomalies).toHaveLength(0);
    expect(deliveryConstrainedAdsetIdsFrom(anomalies).size).toBe(0);
  });
});

/**
 * A campaign that has spent 96 of a 100 daily budget on the snapshot date.
 *
 * One day only, and no history, so the four warehouse-pure families have
 * nothing to say about it: this fixture isolates `budget_exhausted_early`,
 * whose whole verdict is "that much, this early".
 */
function nearlyExhaustedCampaignRows(date = SNAPSHOT_DATE) {
  return [
    {
      provider_account_id: "act_1",
      date,
      campaign_id: "cmp_1",
      campaign_name: "Prospecting",
      campaign_status: "ACTIVE",
      spend: 96,
      revenue: 300,
      impressions: 10000,
      daily_budget: 100,
      purchases: 4,
    },
  ];
}

/** Reads the campaign warehouse table and nothing else. */
function campaignSql(rows: Array<Record<string, unknown>>) {
  const tag = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM meta_campaign_daily")) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>["query"];
  return tag;
}

/*
  Two wall clocks, one local day. Europe/Istanbul is UTC+3 with no DST, so
  05:00Z is 08:00 local (33% of the day, inside the gate) and 19:00Z is 22:00
  local (92%, outside it). Both are the SAME local date, which is what makes
  this a same-day rerun rather than two different days.
*/
const MORNING = new Date("2026-09-04T05:00:00.000Z");
const NIGHT = new Date("2026-09-04T19:00:00.000Z");
const ZONE = "Europe/Istanbul";

describe("a run reports which families it could evaluate", () => {
  it("evaluates budget_exhausted_early in the morning and declines at night, on identical facts", async () => {
    const rows = nearlyExhaustedCampaignRows();

    vi.mocked(db.getDb).mockReturnValue(campaignSql(rows));
    const morning = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: { lossBudgetSpend: null, timezone: ZONE },
      now: MORNING,
    });

    vi.mocked(db.getDb).mockReturnValue(campaignSql(rows));
    const night = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: { lossBudgetSpend: null, timezone: ZONE },
      now: NIGHT,
    });

    expect(morning.anomalies.map((anomaly) => anomaly.type))
      .toEqual(["budget_exhausted_early"]);
    expect(morning.anomalies[0]?.severity).toBe("high");
    expect(morning.evaluatedTypes).toContain("budget_exhausted_early");

    // Same facts, same day, later hour: nothing found AND nothing judged.
    expect(night.anomalies).toEqual([]);
    expect(night.evaluatedTypes).not.toContain("budget_exhausted_early");
    expect(night.skipped).toContainEqual(
      expect.objectContaining({
        type: "budget_exhausted_early",
        reason: "time_of_day_gate",
      }),
    );
  });

  it("declines budget_exhausted_early for a PAST snapshot date, whatever the hour", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      campaignSql(nearlyExhaustedCampaignRows("2026-09-01")),
    );
    const past = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-09-01",
      calibrationContext: null,
      profile: { lossBudgetSpend: null, timezone: ZONE },
      now: MORNING,
    });
    // localDayProgress returns 1 for any date behind the local one, so the
    // family is structurally un-re-detectable for a closed day.
    expect(past.evaluatedTypes).not.toContain("budget_exhausted_early");
    expect(past.skipped).toContainEqual(
      expect.objectContaining({
        type: "budget_exhausted_early",
        reason: "time_of_day_gate",
      }),
    );
  });

  it("declines the two profile-fed families when the profile is absent", async () => {
    vi.mocked(db.getDb).mockReturnValue(campaignSql(nearlyExhaustedCampaignRows()));
    const evaluation = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: null,
      now: MORNING,
    });
    expect(evaluation.skipped).toContainEqual(
      expect.objectContaining({
        type: "budget_exhausted_early",
        reason: "profile_input_unavailable",
      }),
    );
    expect(evaluation.skipped).toContainEqual(
      expect.objectContaining({
        type: "zero_conversions_with_spend",
        reason: "profile_input_unavailable",
      }),
    );
  });

  it("puts every family in exactly one of evaluatedTypes and skipped", async () => {
    /*
      The partition is what the writer's resolve step spends. A family in
      neither list would never be resolvable again — an anomaly stuck open for
      the life of the account — and one in both would resolve on a run that did
      not look.
    */
    vi.mocked(db.getDb).mockReturnValue(campaignSql(nearlyExhaustedCampaignRows()));
    const evaluation = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: SNAPSHOT_DATE,
      calibrationContext: null,
      profile: { lossBudgetSpend: 50, timezone: ZONE },
      now: MORNING,
    });
    const named = [
      ...evaluation.evaluatedTypes,
      ...evaluation.skipped.map((entry) => entry.type),
    ];
    expect([...named].sort()).toEqual([...META_ANOMALY_TYPES].sort());
    expect(new Set(named).size).toBe(META_ANOMALY_TYPES.length);
  });

  it("keeps the four warehouse-pure families evaluated at every hour", async () => {
    const pure = ["roas_drop_sudden", "delivery_stall", "policy_block", "cpm_spike"];
    for (const now of [MORNING, NIGHT, new Date("2026-09-04T02:00:00.000Z")]) {
      vi.mocked(db.getDb).mockReturnValue(campaignSql(nearlyExhaustedCampaignRows()));
      const evaluation = await detectAnomalyEvaluationForBusiness({
        businessId: "biz_1",
        snapshotDate: SNAPSHOT_DATE,
        calibrationContext: null,
        profile: null,
        now,
      });
      for (const type of pure) expect(evaluation.evaluatedTypes).toContain(type);
    }
  });
});

/**
 * The writer half, driven through the shipped `runMetaSnapshotForBusiness`.
 *
 * The detector can only REPORT that it did not look; the loss happened in the
 * writer, whose resolve step read "absent from this run's payload" as "no
 * longer true". These drive the real entry point with the wall clock moved
 * under it and read the statement it actually sent.
 */
describe("the writer resolves only the families this run evaluated", () => {
  /**
   * Records every statement AND its parameters, because the fix is a
   * parameter: the resolve predicate now names the evaluated families.
   */
  function snapshotSql(input: {
    campaignRows: Array<Record<string, unknown>>;
    timezone: string | null;
  }) {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      statements.push({ text, params: values });
      if (text.includes("FROM meta_campaign_daily")) {
        return Promise.resolve(input.campaignRows);
      }
      if (text.includes("SELECT timezone FROM businesses")) {
        return Promise.resolve([{ timezone: input.timezone }]);
      }
      return Promise.resolve([]);
    }) as unknown as ReturnType<typeof db.getDb>;
    tag.query = vi.fn((text: string, params?: unknown[]) => {
      statements.push({ text, params: params ?? [] });
      return Promise.resolve([]);
    }) as unknown as ReturnType<typeof db.getDb>["query"];
    return { tag, statements };
  }

  function resolveStatements(statements: Array<{ text: string; params: unknown[] }>) {
    return statements.filter(
      (entry) =>
        entry.text.includes("SET resolved_at = now()") &&
        entry.text.includes("kind = 'anomaly'"),
    );
  }

  async function runAt(now: Date, timezone: string | null) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const sql = snapshotSql({
        campaignRows: nearlyExhaustedCampaignRows(),
        timezone,
      });
      vi.mocked(db.getDb).mockReturnValue(sql.tag);
      const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");
      const run = await runMetaSnapshotForBusiness("biz_1", SNAPSHOT_DATE);
      return { run, statements: sql.statements };
    } finally {
      vi.useRealTimers();
    }
  }

  it("writes the anomaly in the morning and does NOT resolve it on the same day's night rerun", async () => {
    const morning = await runAt(MORNING, ZONE);
    expect(morning.run.anomaliesWritten).toBe(1);

    const night = await runAt(NIGHT, ZONE);
    // Byte-identical facts; the family simply cannot be judged at 22:00.
    expect(night.run.anomaliesWritten).toBe(0);

    const resolves = resolveStatements(night.statements);
    expect(resolves).toHaveLength(1);
    const [resolve] = resolves;
    expect(resolve?.text).toContain("rec_type = ANY(");
    const families = (resolve?.params ?? []).find(Array.isArray) as string[] | undefined;
    expect(families).toBeDefined();
    expect(families).not.toContain("budget_exhausted_early");
    // Not a blanket refusal to resolve: the families that DID look are named.
    expect(families).toEqual(
      expect.arrayContaining(["roas_drop_sudden", "delivery_stall", "policy_block", "cpm_spike"]),
    );
  });

  it("still resolves a family that looked and found nothing", async () => {
    /*
      The falsifier. Without it, "never resolves" and "resolves only what it
      evaluated" are indistinguishable, and simply deleting the resolve step
      would pass the test above.
    */
    const morning = await runAt(MORNING, ZONE);
    const resolves = resolveStatements(morning.statements);
    expect(resolves).toHaveLength(1);
    const families = (resolves[0]?.params ?? []).find(Array.isArray) as string[] | undefined;
    expect(families).toContain("budget_exhausted_early");
    expect(families).toContain("delivery_stall");
  });

  it("resolves nothing at all when the business has no timezone to measure the day in", async () => {
    const noZone = await runAt(MORNING, null);
    expect(noZone.run.anomaliesWritten).toBe(0);
    const families = (resolveStatements(noZone.statements)[0]?.params ?? [])
      .find(Array.isArray) as string[] | undefined;
    expect(families).not.toContain("budget_exhausted_early");
    expect(families).not.toContain("zero_conversions_with_spend");
  });
});
