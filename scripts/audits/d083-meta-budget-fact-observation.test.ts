import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assertRequestIsInScope,
  buildRequest,
  computeCoverage,
  computeLaneFacts,
  expectedInvocationKeys,
  D083_CONTRACT_ID,
  D083_JSON_OUT,
  D083_PINNED_INPUTS,
  D083_QUERIES,
  observationsByBinding,
  proposalCampaignIdentity,
  recomputeTemporalControl,
  scopeOriginKey,
  toBudgetObservation,
  verifyArtifact,
  type D083MaterialisedRead,
  D083_PER_BINDING_PLAN,
  coverageBit,
  coverageSource,
  ADMITTED_COVERAGE_SOURCES,
  BASELINE_LOOKBACK_DAYS,
} from "./d083-meta-budget-fact-observation";
import { BUDGET_FACT_CONTRACT_VERSION, pitCutoffMs } from "@/lib/meta/budget-fact";
import { D080_PINNED_BINDINGS } from "@/scripts/audits/d080-meta-budget-edit-evidence";

type Row = Record<string, unknown>;

const IWA = { businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", account: "act_1087566732415606" };
const GRANDMIX = { businessId: "5dbc7147-f051-4681-a4d6-20617170074f", account: "act_805150454596350" };
const SWAF_SELECTED = { businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", account: "act_822913786458311" };
const SWAF_UNSELECTED = { businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", account: "act_921275999286619" };

const ORIGINS = ["2026-07-20", "2026-07-27"];

function dbRow(over: Row = {}): Row {
  return {
    observation_id: "00000000-0000-4000-8000-000000000001",
    entity_type: "adset",
    entity_id: "adset-1",
    campaign_id: "campaign-1",
    observed_at: "2026-07-18 02:00:00+00",
    observed_on: "2026-07-18",
    captured_at: "2026-07-18 03:00:00+00",
    run_id: "00000000-0000-4000-8000-0000000000ff",
    run_completeness: "complete",
    presence: "present",
    configured_status: "ACTIVE",
    effective_status: "ACTIVE",
    budget_origin: "adset",
    budget_currency: "USD",
    campaign_daily_budget_raw: null,
    campaign_lifetime_budget_raw: null,
    adset_daily_budget_raw: "30000",
    adset_lifetime_budget_raw: "0",
    state_hash: "a".repeat(64),
    source_snapshot_id: "snap-1",
    payload_hash: "payload-1",
    run_hash: "run-1",
    provider_api_version: "v25.0",
    field_coverage_json: { configuredStatus: true, effectiveStatus: true },
    ...over,
  };
}

const campaignRow = (over: Row = {}) =>
  dbRow({
    observation_id: "00000000-0000-4000-8000-000000000002",
    entity_type: "campaign",
    entity_id: "campaign-1",
    campaign_id: "campaign-1",
    budget_origin: "not_applicable",
    campaign_daily_budget_raw: "0",
    campaign_lifetime_budget_raw: "0",
    adset_daily_budget_raw: null,
    adset_lifetime_budget_raw: null,
    state_hash: "b".repeat(64),
    ...over,
  });

const read = (
  scope: { businessId: string; account: string },
  rows: Row[],
  planKey = "budgetObservationPitWinners",
  source = "meta_entity_state_history",
): D083MaterialisedRead => ({
  invocationKey: `${planKey}:${source}#${scope.businessId}|${scope.account}`,
  planKey,
  businessId: scope.businessId,
  providerAccountId: scope.account,
  source,
  lane: "strict_pit_authority",
  effectiveFrom: "2026-04-30",
  effectiveTo: "2026-08-20",
  rows,
});

const tzRead = (scope: { businessId: string; account: string }, zone = "America/Los_Angeles") =>
  read(scope, [{ account_timezone: zone, rows: 100 }], "accountTimezone", "meta_campaign_daily");

const snapshotOf = (reads: D083MaterialisedRead[]) => {
  const out: Record<string, D083MaterialisedRead[]> = {};
  for (const r of reads) (out[r.planKey] ??= []).push(r);
  return out;
};

const entity = (scope: { businessId: string; account: string }, grain: string, id: string): Row => ({
  business_id: scope.businessId,
  provider_account_id: scope.account,
  grain,
  entity_id: id,
});

describe("the D083 read plan is SELECT-only and scope-pinned", () => {
  it("contains no mutation statement and no provider call", () => {
    const mutation = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|GRANT|REVOKE|COPY|VACUUM|REFRESH)\b/i;
    for (const [key, statement] of Object.entries(D083_QUERIES)) {
      expect(
        statement.trim().toUpperCase().startsWith("SELECT") ||
          statement.trim().toUpperCase().startsWith("WITH"),
        key,
      ).toBe(true);
      expect(mutation.test(statement), key).toBe(false);
    }
    const source = readFileSync(
      new URL("./d083-meta-budget-fact-observation.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [/graph\.facebook\.com/i, /\bfetch\s*\(/, /\bINSERT\s+INTO\b/i]) {
      expect(forbidden.test(source), String(forbidden)).toBe(false);
    }
  });

  it("refuses an unpinned business, a cross-paired binding and a foreign statement", () => {
    const bad = (over: Record<string, unknown>) =>
      buildRequest({
        planKey: "budgetObservationPitWinners",
        statement: D083_QUERIES.budgetObservationPitWinners,
        params: [IWA.businessId, IWA.account, "2026-04-30T07:00:00.000Z", "adset", true],
        source: "meta_entity_state_history",
        lane: "strict_pit_authority",
        businessId: IWA.businessId,
        providerAccountId: IWA.account,
        ...over,
      });
    expect(() => assertRequestIsInScope(bad({ businessId: "nope" }))).toThrow(/charter businesses/);
    expect(() => assertRequestIsInScope(bad({ providerAccountId: GRANDMIX.account }))).toThrow(
      /not a pinned binding/,
    );
    expect(() => assertRequestIsInScope(bad({ statement: "SELECT 1" }))).toThrow(
      /not a member of the pinned query contract/,
    );
  });

  it("declares one deterministic invocation-key set", () => {
    const keys = expectedInvocationKeys();
    expect(keys.length).toBe(2 + D083_PER_BINDING_PLAN.length * D080_PINNED_BINDINGS.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const binding of [IWA, GRANDMIX, SWAF_SELECTED, SWAF_UNSELECTED]) {
      expect(
        keys.some((k) => k.includes(`${binding.businessId}|${binding.account}`)),
        `${binding.account}`,
      ).toBe(true);
    }
  });
});

describe("scope isolation across bindings", () => {
  const laneFor = (reads: D083MaterialisedRead[], entities: Row[]) =>
    computeLaneFacts({
      snapshot: snapshotOf(reads),
      entities,
      origins: ORIGINS,
      lane: "retrospective_finalized_conditional",
    });

  it("never cross-pairs the same entity id in two businesses", () => {
    const lane = laneFor(
      [
        read(IWA, [dbRow({ adset_daily_budget_raw: "111" }), campaignRow()]),
        tzRead(IWA),
        read(GRANDMIX, [dbRow({ adset_daily_budget_raw: "222" }), campaignRow()]),
        tzRead(GRANDMIX),
      ],
      [entity(IWA, "adset", "adset-1"), entity(GRANDMIX, "adset", "adset-1")],
    );
    const iwa = lane.ownerResolvedScopeOriginKeys.filter((k) => k.startsWith(IWA.businessId));
    const gm = lane.ownerResolvedScopeOriginKeys.filter((k) => k.startsWith(GRANDMIX.businessId));
    expect(iwa.length).toBeGreaterThan(0);
    expect(gm.length).toBeGreaterThan(0);
    expect(new Set([...iwa, ...gm]).size).toBe(iwa.length + gm.length);
    for (const key of iwa) expect(key).not.toContain(GRANDMIX.account);
  });

  it("keeps TheSwaf's deselected account out of the selected account's facts", () => {
    const lane = laneFor(
      [
        read(SWAF_SELECTED, [dbRow({ adset_daily_budget_raw: "111" }), campaignRow()]),
        tzRead(SWAF_SELECTED),
        read(SWAF_UNSELECTED, [dbRow({ adset_daily_budget_raw: "222" }), campaignRow()]),
        tzRead(SWAF_UNSELECTED),
      ],
      [entity(SWAF_SELECTED, "adset", "adset-1"), entity(SWAF_UNSELECTED, "adset", "adset-1")],
    );
    const selected = lane.ownerResolvedScopeOriginKeys.filter((k) => k.includes(SWAF_SELECTED.account));
    const unselected = lane.ownerResolvedScopeOriginKeys.filter((k) => k.includes(SWAF_UNSELECTED.account));
    expect(selected.length).toBeGreaterThan(0);
    expect(unselected.length).toBeGreaterThan(0);
    expect(selected.some((k) => unselected.includes(k))).toBe(false);
  });

  it("refuses an ABO ad set whose parent was never observed", () => {
    const lane = laneFor(
      [read(IWA, [dbRow()]), tzRead(IWA)],
      [entity(IWA, "adset", "adset-1")],
    );
    expect(lane.ownerResolvedFacts).toBe(0);
    expect(Object.keys(lane.blockerCensus)).toContain("parent_not_observed");
  });

  it("fails closed when the account timezone is not resolvable", () => {
    const lane = laneFor(
      [read(IWA, [dbRow(), campaignRow()])],
      [entity(IWA, "adset", "adset-1")],
    );
    expect(lane.ownerResolvedFacts).toBe(0);
  });

  it("refuses a binding whose timezone changed inside the window", () => {
    const lane = laneFor(
      [
        read(IWA, [dbRow(), campaignRow()]),
        read(IWA, [{ account_timezone: "America/Los_Angeles", rows: 5 }, { account_timezone: "Europe/Istanbul", rows: 5 }], "accountTimezone", "meta_campaign_daily"),
      ],
      [entity(IWA, "adset", "adset-1")],
    );
    expect(lane.ownerResolvedFacts).toBe(0);
    expect(lane.timezoneProvenance.some((t) => t.stableOverWindow === false)).toBe(true);
  });
});

describe("point-in-time at the audit boundary", () => {
  const laneFor = (rows: Row[], lane: "strict_pit_authority" | "retrospective_finalized_conditional") =>
    computeLaneFacts({
      snapshot: snapshotOf([read(IWA, rows), tzRead(IWA)]),
      entities: [entity(IWA, "adset", "adset-1")],
      origins: ORIGINS,
      lane,
    });

  const pair = (over: Row = {}) => [dbRow(over), campaignRow(over)];
  const key = (origin: string) => scopeOriginKey(IWA.businessId, IWA.account, "adset", "adset-1", origin);

  it("hides a fact effective after the local cutoff, and shows it at the next origin", () => {
    // 2026-07-20T08:00Z is one hour after the Los Angeles day start.
    const lane = laneFor(
      pair({ observed_at: "2026-07-20 08:00:00+00", observed_on: "2026-07-20", captured_at: "2026-07-20 09:00:00+00" }),
      "retrospective_finalized_conditional",
    );
    expect(lane.ownerResolvedScopeOriginKeys).not.toContain(key("2026-07-20"));
    expect(lane.ownerResolvedScopeOriginKeys).toContain(key("2026-07-27"));
  });

  it("excludes a fact recorded after the cutoff from the strict lane only", () => {
    const rows = pair({ captured_at: "2026-07-25 00:00:00+00" });
    expect(laneFor(rows, "strict_pit_authority").ownerResolvedScopeOriginKeys).not.toContain(key("2026-07-20"));
    expect(
      laneFor(rows, "retrospective_finalized_conditional").ownerResolvedScopeOriginKeys,
    ).toContain(key("2026-07-20"));
  });

  it("selects a predecessor from years before the window, with no horizon", () => {
    // Correction 2's 120-day floor would have deleted this row outright.
    const lane = computeLaneFacts({
      snapshot: snapshotOf([
        read(
          IWA,
          pair({ observed_at: "2023-03-29 00:00:00+00", observed_on: "2023-03-29", captured_at: "2023-03-29 01:00:00+00" }),
          "budgetObservationPitWinners",
        ),
        tzRead(IWA),
      ]),
      entities: [entity(IWA, "adset", "adset-1")],
      origins: ORIGINS,
      lane: "strict_pit_authority",
    });
    expect(lane.ownerResolvedScopeOriginKeys).toContain(key("2026-07-20"));
  });

  it("cannot learn a parent identity from a future row", () => {
    const lane = computeLaneFacts({
      snapshot: snapshotOf([
        read(IWA, [
          // The only row that names a parent is effective AFTER the first origin.
          dbRow({ observed_at: "2026-07-25 00:00:00+00", observed_on: "2026-07-25", captured_at: "2026-07-25 01:00:00+00" }),
          campaignRow({ observed_at: "2026-07-25 00:00:00+00", observed_on: "2026-07-25", captured_at: "2026-07-25 01:00:00+00" }),
        ]),
        tzRead(IWA),
      ]),
      entities: [entity(IWA, "adset", "adset-1")],
      origins: ORIGINS,
      lane: "retrospective_finalized_conditional",
    });
    expect(lane.parentResolvedScopeOriginKeys).not.toContain(key("2026-07-20"));
    expect(lane.parentResolvedScopeOriginKeys).toContain(key("2026-07-27"));
  });

  it("does not turn an incomplete run into zero coverage", () => {
    const lane = laneFor(pair({ run_completeness: "point_lookup" }), "retrospective_finalized_conditional");
    expect(lane.ownerResolvedFacts).toBe(0);
    expect(Object.keys(lane.blockerCensus)).toContain("observation_not_complete_scope");
    expect(lane.budgetFieldCensus.none ?? 0).toBe(0);
  });
});

describe("mapping retained rows", () => {
  it("keeps raw amounts verbatim, carries provenance and never invents a shape or API version", () => {
    const mapped = toBudgetObservation(dbRow(), {
      businessId: IWA.businessId,
      providerAccountId: IWA.account,
    });
    expect(mapped?.adsetDailyRaw).toBe("30000");
    expect(mapped?.adsetLifetimeRaw).toBe("0");
    expect(mapped?.observedAtMs).toBe(Date.parse("2026-07-18T02:00:00Z"));
    expect(mapped?.observationId).toBe("00000000-0000-4000-8000-000000000001");
    expect(mapped?.sourceSnapshotId).toBe("snap-1");
    // Two distinct facts, never substituted for one another.
    expect(mapped?.runHash).toBe("run-1");
    expect(mapped?.payloadHash).toBe("payload-1");
    expect(mapped?.statusFieldCoverage).toEqual({ configuredStatus: true, effectiveStatus: true });
    expect(mapped?.shapeSupport).toBe("shape_not_observed");
    expect(mapped?.budgetCurrencyExponent).toBeNull();
  });

  it("normalises a campaign observation's parent to null", () => {
    const mapped = toBudgetObservation(campaignRow(), {
      businessId: IWA.businessId,
      providerAccountId: IWA.account,
    });
    expect(mapped?.entityGrain).toBe("campaign");
    // The stored row carries its own id in campaign_id; a campaign has no parent.
    expect(mapped?.parentCampaignId).toBeNull();
  });

  it("scopes observations to the binding that read them", () => {
    const byBinding = observationsByBinding(snapshotOf([read(IWA, [dbRow()]), read(GRANDMIX, [dbRow()])]));
    expect(byBinding.size).toBe(2);
    for (const [k, rows] of byBinding) {
      for (const row of rows) expect(`${row.businessId}|${row.providerAccountId}`).toBe(k);
    }
  });
});

describe("the proposal join key", () => {
  it("uses the entity id for a campaign and the parent for an ad set", () => {
    expect(proposalCampaignIdentity({ entityGrain: "campaign", entityId: "c-1", campaignId: null } as never)).toBe("c-1");
    expect(proposalCampaignIdentity({ entityGrain: "adset", entityId: "a-1", campaignId: "c-9" } as never)).toBe("c-9");
  });
});

// Verification re-derives the whole analysis from two frozen ten-megabyte
// artifacts, which is the point of it; the happy path is given room to do that.
describe("the produced artifact", () => {
  const artifact = JSON.parse(readFileSync(D083_JSON_OUT, "utf8")) as Record<string, unknown>;

  it(
    "verifies",
    () => {
      const result = verifyArtifact(artifact);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    },
    300_000,
  );

  it("carries a server-asserted read-only, repeatable-read proof", () => {
    const provenance = artifact.provenance as Row;
    expect(provenance.transactionReadOnly).toBe("on");
    expect(provenance.transactionIsolation).toBe("repeatable read");
    expect(artifact.contract).toBe(D083_CONTRACT_ID);
    expect(artifact.budgetFactContractVersion).toBe(BUDGET_FACT_CONTRACT_VERSION);
  });

  it("carries exactly the expected invocation-key set", () => {
    const reads = (artifact.snapshot as Row).reads as D083MaterialisedRead[];
    expect(reads.map((r) => r.invocationKey).sort()).toEqual(expectedInvocationKeys());
    expect((artifact.provenance as Row).readFailures).toEqual([]);
  });

  it("is rejected when any one expected read is deleted", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const reads = (clone.snapshot as Row).reads as D083MaterialisedRead[];
    const dropped = reads.pop()!;
    const ledger = (clone.provenance as Row).readLedger as Row[];
    (clone.provenance as Row).readLedger = ledger.filter((e) => e.invocationKey !== dropped.invocationKey);
    const failures = verifyArtifact(clone).failures.join(" ");
    expect(failures).toMatch(/required read missing/);
  });

  it("is rejected when a whole binding is dropped consistently", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const reads = (clone.snapshot as Row).reads as D083MaterialisedRead[];
    const victim = SWAF_UNSELECTED.account;
    (clone.snapshot as Row).reads = reads.filter((r) => r.providerAccountId !== victim);
    const ledger = (clone.provenance as Row).readLedger as Row[];
    (clone.provenance as Row).readLedger = ledger.filter((e) => e.providerAccountId !== victim);
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/required read missing/);
  });

  it("is rejected when a read failed", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const ledger = (clone.provenance as Row).readLedger as Row[];
    ledger[0]!.status = "unknown/source_read_failed";
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/did not succeed|invocation_set_mismatch/);
  });

  it("is rejected when the read-only proof is forged", () => {
    const forged = { ...artifact, provenance: { ...(artifact.provenance as Row), transactionReadOnly: "off" } };
    expect(verifyArtifact(forged).ok).toBe(false);
  });

  it("is rejected when a stored row is mutated", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const reads = (clone.snapshot as Row).reads as D083MaterialisedRead[];
    const target = reads.find((r) => r.rows.length > 0)!;
    target.rows[0] = { ...target.rows[0], entity_id: "forged" };
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/snapshot_hash_mismatch|slice_hash_mismatch/);
  });

  it("is rejected when the query contract drifts", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (clone.provenance as Row).queryContractSha256 = "0".repeat(64);
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/query_contract_mismatch/);
  });

  // This one passes every structural check, so it must actually re-derive the
  // analysis to notice — which is the point, and takes as long as verification.
  it(
    "is rejected when a derived headline is edited",
    () => {
      const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
      (clone.coverage as Row).genuinelyAmbiguousRows = 999;
      expect(verifyArtifact(clone).failures.join(" ")).toMatch(/coverage: derived_output_mismatch/);
    },
    300_000,
  );

  it("keeps every temporal control non-vacuous", () => {
    const controls = artifact.temporalControls as Row[];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const control of controls) {
      expect(control.pass, String(control.control)).toBe(true);
      expect(control.nonVacuous, String(control.control)).toBe(true);
    }
  });

  it("proves the account cutoff is not UTC for any binding", () => {
    const lanes = artifact.lanes as Row[];
    const zones = (lanes[0]!.timezoneProvenance as Row[]) ?? [];
    expect(zones.length).toBe(7);
    for (const zone of zones) {
      expect(zone.stableOverWindow, String(zone.providerAccountId)).toBe(true);
      expect(zone.timeZone).not.toBe("UTC");
    }
  });

  it("reconciles every published denominator", () => {
    for (const row of artifact.reconciliation as Row[]) {
      expect(row.balances, String(row.check)).toBe(true);
    }
    expect((artifact.reconciliation as Row[]).length).toBeGreaterThan(15);
  });

  it("keeps the four frozen predecessor artifacts byte-identical", () => {
    for (const [path, expected] of [
      [D083_PINNED_INPUTS.d080aArtifactPath, D083_PINNED_INPUTS.d080aArtifactSha256],
      [D083_PINNED_INPUTS.d080bArtifactPath, D083_PINNED_INPUTS.d080bArtifactSha256],
      [D083_PINNED_INPUTS.d081ArtifactPath, D083_PINNED_INPUTS.d081ArtifactSha256],
      [D083_PINNED_INPUTS.d082ArtifactPath, D083_PINNED_INPUTS.d082ArtifactSha256],
    ] as const) {
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), path).toBe(expected);
    }
  });

  it("claims no execution, no migration applied and no causal effect", () => {
    const limits = artifact.limits as Row;
    expect(limits.executable).toBe(false);
    expect(limits.migrationApplied).toBe(false);
    for (const value of Object.values(limits.causalClaims as Row)) expect(value).toBeNull();
  });

  it("reports zero intent-ready facts, because shape and exponent were never observed", () => {
    for (const lane of artifact.lanes as Row[]) {
      expect(lane.intentReadyFacts).toBe(0);
      expect(Object.keys(lane.blockerCensus as Row)).toContain("budget_shape_not_observed");
      expect(Number(lane.ownerResolvedFacts)).toBeGreaterThan(0);
    }
  });

  it("publishes a canonical funnel that terminates at its own gate", () => {
    const funnel = (artifact.proposalImpact as Row).canonicalIntentReadinessFunnel as Row[];
    expect(funnel.length).toBeGreaterThan(5);
    expect(funnel[funnel.length - 1]!.stage).toBe("intent-ready");
    expect(funnel[funnel.length - 1]!.survivors).toBe(0);
    // and the legacy overlay is labelled as what it is
    expect(String((artifact.proposalImpact as Row).funnelAfterOverlayLabel)).toMatch(
      /owner\/amount counterfactual over the legacy/,
    );
  });

  it("recomputes every temporal control from its own raw fields", () => {
    const controls = artifact.temporalControls as Row[];
    for (const control of controls) {
      const recomputed = recomputeTemporalControl(control);
      expect(recomputed, String(control.control)).not.toBeNull();
      expect(recomputed, String(control.control)).toBe(control.pass);
    }
    // At least one real-data control must have found a qualifying case.
    const real = controls.filter((c) => "realCaseFound" in c);
    expect(real.some((c) => c.realCaseFound === true)).toBe(true);
  });

  it("proves the candidate set was selected over full history", () => {
    const control = (artifact.temporalControls as Row[]).find(
      (c) => c.control === "winners_selected_over_full_history",
    );
    expect(control?.lookbackHorizonDays).toBeNull();
    // Non-vacuous only because real rows precede the first origin: this is the
    // history Correction 2's 120-day floor deleted.
    expect(Number(control?.rowsBeforeFirstOrigin ?? 0)).toBeGreaterThan(0);
    expect(control?.nonVacuous).toBe(true);
    expect(control?.pass).toBe(true);
  });

  it("keeps every collapsed frontier read reconciled with its executions", () => {
    const reads = ((artifact.snapshot as Row).reads ?? []) as Row[];
    const frontier = reads.filter((r) => r.planKey === "budgetObservationPitWinners");
    expect(frontier.length).toBeGreaterThan(0);
    for (const read of frontier) {
      const executions = Number(read.executions ?? 0);
      // 17 origins x 2 grains x 2 lanes.
      expect(executions, String(read.invocationKey)).toBe(
        ((artifact.window as Row).origins as string[]).length * 2 * 2,
      );
      expect((read.executionKeys as string[]).length).toBe(executions);
      expect(new Set(read.executionKeys as string[]).size).toBe(executions);
      // Deduplication may only shrink the set, never invent a row.
      expect(Number(read.rowsBeforeDeduplication ?? 0)).toBeGreaterThanOrEqual(
        (read.rows as Row[]).length,
      );
      const ids = new Set((read.rows as Row[]).map((r) => String(r.observation_id)));
      expect(ids.size).toBe((read.rows as Row[]).length);
    }
  });

  it("finds no genuinely ambiguous budget row in the whole retained history", () => {
    const coverage = artifact.coverage as Row;
    expect(coverage.genuinelyAmbiguousRows).toBe(0);
    const shape = coverage.configBudgetShape as Row[];
    expect(shape.reduce((a, r) => a + Number(r.bothPresent ?? 0), 0)).toBeGreaterThan(0);
  });

  it("publishes the configuration and run censuses the first report omitted", () => {
    const coverage = artifact.coverage as Row;
    expect((coverage.configurationCensus as Row[]).length).toBe(7);
    expect((coverage.observationRunManifest as Row[]).length).toBeGreaterThan(0);
    for (const row of coverage.configurationCensus as Row[]) {
      expect(row.advantagePlusOrSharedBudgetIndicator).toBeNull();
    }
  });
});

describe("coverage never reads a name or a manual label", () => {
  it("has no campaign-name or label input in the D083 path", () => {
    const source = readFileSync(
      new URL("./d083-meta-budget-fact-observation.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of ["campaign_name", "meta_campaign_labels", "campaign_kind", "manualKind"]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("computes coverage without any lane or owner input from a name", () => {
    const coverage = computeCoverage(snapshotOf([read(IWA, [dbRow()])]));
    expect(coverage.truth).toBe("verified_fact");
    expect(coverage.perBinding.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// D083 Correction 3 — coverage cannot be manufactured out of a stored string.

describe("field coverage decoding", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", false],
    ["false", false],
    ["", false],
    ["  ", false],
    [1, false],
    [0, false],
    ["1", false],
    ["yes", false],
    [null, false],
    [undefined, false],
    [{}, false],
    [[], false],
  ])("decodes %j as %s", (stored, expected) => {
    // Only the exact admitted representation counts. Correction 2 used a
    // truthiness test, so "false" and "0" read as covered.
    expect(coverageBit({ configuredStatus: stored }, "configuredStatus")).toBe(expected);
  });

  it("does not read a bit off a non-object or a missing field", () => {
    for (const bad of [null, undefined, "true", 1, [], "client_registry"]) {
      expect(coverageBit(bad, "configuredStatus")).toBe(false);
    }
    expect(coverageBit({ effectiveStatus: true }, "configuredStatus")).toBe(false);
  });

  it.each(ADMITTED_COVERAGE_SOURCES)("admits the source string %s", (source) => {
    expect(coverageSource({ currencySource: source }, "currencySource")).toBe(source);
  });

  it.each(["", "  ", "banana", "CLIENT_REGISTRY", " client_registry", "client", true, 1, null])(
    "refuses the source value %j",
    (value) => {
      expect(coverageSource({ currencySource: value }, "currencySource")).toBeNull();
    },
  );
});

describe("the PIT candidate set has no horizon", () => {
  it("applies no lookback floor", () => {
    // Correction 2 read a 120-day floor. 808,506 retained rows precede it, so
    // any non-null value here silently deletes real PIT candidates.
    expect(BASELINE_LOOKBACK_DAYS).toBeNull();
  });

  it("asks for the exact top-clock rows at one cutoff, per lane", () => {
    const sql = D083_QUERIES.budgetObservationPitWinners;
    // The lane predicate, and nothing cleverer.
    expect(sql).toMatch(/\$5::bool IS FALSE OR h\.captured_at <= \$3::timestamptz/i);
    expect(sql).toMatch(/RANK\(\)\s+OVER/i);
    expect(sql).toMatch(/ORDER BY observed_at DESC, captured_at DESC/i);
    expect(sql).toMatch(/clock_rank = 1/i);
    // Correction 3's reduction is gone: no running-minimum frontier, and no
    // RANGE frame that made equal-observed_at rows peers.
    expect(sql).not.toMatch(/MIN\(captured_at\)/i);
    expect(sql).not.toMatch(/best_captured/i);
    expect(sql).not.toMatch(/RANGE BETWEEN/i);
    // No floor, cap, or sampling of any kind.
    expect(sql).not.toMatch(/INTERVAL\s*'\s*\d+\s*day/i);
    expect(sql).not.toMatch(/\bobserved_at\s*>=/i);
    expect(sql).not.toMatch(/\bLIMIT\b/i);
    expect(sql).not.toMatch(/TABLESAMPLE/i);
  });
});
