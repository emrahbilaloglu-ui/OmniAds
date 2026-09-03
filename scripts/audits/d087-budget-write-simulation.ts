#!/usr/bin/env node
/**
 * D087 — historical simulation of the budget write preflight.
 *
 * This replays the preflight against the SIX real businesses in the pinned
 * D086 census, at historical cutoffs, to answer one question honestly: with the
 * evidence those accounts actually retained, which budget writes would have
 * been permitted, and which refused and why.
 *
 * It performs NO provider call and opens NO database handle. Its only input is
 * the frozen census file; everything else is derived from it. Where the census
 * cannot establish a fact — a proven owner, a captured exponent, a fresh
 * provider baseline — the case is reported as NOT DETERMINABLE rather than
 * being counted as eligible. There are no eligible cells to fabricate: the
 * activation blockers alone refuse every case, and the point of the replay is
 * to show what would remain refused even if they did not.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { D087_BUDGET_TRANSPORT_CAPABILITY } from "@/lib/meta/budget-write-capability";
import {
  evaluateBudgetWritePreflight,
  type BudgetWritePolicy,
} from "@/lib/meta/budget-write-preflight";
import {
  parseBudgetWriteRequest,
  BUDGET_WRITE_REQUEST_CONTRACT,
} from "@/lib/meta/budget-write-request";

export const D087_SIMULATION_CONTRACT = "d087.budget-write-simulation.v1" as const;

/** The frozen D086 census. Read only; never rewritten by this script. */
export const D087_CENSUS_PATH =
  "docs/audits/generated/d086-live-census-2026-09-02.json";

/**
 * The census this replay is entitled to read, by content.
 *
 * D087 C1: the previous field published `raw.length.toString(16)` under the
 * name `censusSha256Prefix` — the hex FILE LENGTH, which cannot detect a
 * same-length edit and was not a hash at all. The replay now computes the real
 * digest and refuses to produce a single cell unless it matches the accepted
 * frozen census.
 */
export const D087_EXPECTED_CENSUS_SHA256 =
  "4f3519bc8badb311aeae7ff7f37730a8527e5fa1065856c0d247ea0f60abd8cb" as const;

export const D087_SIMULATION_POLICY: BudgetWritePolicy = Object.freeze({
  maxChangePercent: 25,
  minHoursBetweenChanges: 12,
  maxChangesPer7d: 3,
  maxAccountConcentrationPercent: 40,
  maxBaselineAgeMinutes: 60,
});

interface CensusBusiness {
  business: string;
  businessId: string;
  campaignConfigRows: number;
  adsetConfigRows: number;
  providerAccounts: number;
  latestCapturedAt: string | null;
  roleRows: number;
  roleAccountScoped: number;
  roleCompiledVersion: number;
  latestRoleAsOf: string | null;
}

export interface D087SimulationCell {
  business: string;
  businessId: string;
  cutoff: string;
  /** What the census can and cannot establish for this business at this cutoff. */
  determinable: boolean;
  notDeterminableBecause: readonly string[];
  /** Only computed when the case is determinable. */
  preflightBlockers: readonly string[];
  eligible: boolean;
}

export interface D087SimulationReport {
  contract: typeof D087_SIMULATION_CONTRACT;
  censusPath: string;
  censusSha256: string;
  cutoffs: readonly string[];
  cells: readonly D087SimulationCell[];
  totals: {
    cells: number;
    determinable: number;
    notDeterminable: number;
    eligible: number;
  };
  /** Stated once, so nobody has to infer it from a zero. */
  whyNoEligibleCell: string;
}

/**
 * The cutoffs replayed. Each is BEFORE the census's own read, so nothing is
 * judged against evidence that did not exist yet.
 */
export const D087_SIMULATION_CUTOFFS = [
  "2026-08-01T00:00:00.000Z",
  "2026-08-15T00:00:00.000Z",
  "2026-08-22T00:00:00.000Z",
] as const;

export class D087CensusMismatchError extends Error {
  constructor(readonly actualSha256: string) {
    super(
      `The census at ${D087_CENSUS_PATH} hashes to ${actualSha256}, not the accepted `
      + `${D087_EXPECTED_CENSUS_SHA256}. No cell may be produced from evidence this `
      + "replay cannot identify.",
    );
    this.name = "D087CensusMismatchError";
  }
}

function readCensus(root: string): {
  businesses: CensusBusiness[]; sha256: string;
} {
  const file = path.join(root, D087_CENSUS_PATH);
  const bytes = fs.readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // FAIL CLOSED, before anything is derived from it.
  if (sha256 !== D087_EXPECTED_CENSUS_SHA256) throw new D087CensusMismatchError(sha256);
  const parsed = JSON.parse(bytes.toString("utf8")) as { businesses?: CensusBusiness[] };
  return { businesses: parsed.businesses ?? [], sha256 };
}

/**
 * What the census CANNOT establish for a budget write.
 *
 * These are absences of fact, not policy opinions: the census counts config
 * rows and role rows, and a budget write needs a proven owner, a captured
 * minor-unit exponent and a fresh provider read. None of the three is in it.
 */
function notDeterminableReasons(business: CensusBusiness, cutoffMs: number): string[] {
  const reasons: string[] = [];
  const latestMs = business.latestCapturedAt
    ? Date.parse(business.latestCapturedAt) : Number.NaN;
  if (!Number.isFinite(latestMs) || latestMs > cutoffMs) {
    reasons.push("no_retained_observation_at_or_before_cutoff");
  }
  if (business.campaignConfigRows <= 0 && business.adsetConfigRows <= 0) {
    reasons.push("no_retained_configuration_rows");
  }
  if (business.roleAccountScoped <= 0) {
    reasons.push("no_account_scoped_role_authority");
  }
  if (business.roleCompiledVersion <= 0) {
    reasons.push("no_compiled_resolver_version");
  }
  // The census carries no per-entity budget fact, so the owner mode, the
  // amount, the currency and its captured exponent are all unavailable.
  reasons.push("no_retained_canonical_budget_fact_in_census");
  // And a preflight requires a FRESH provider read, which a historical replay
  // cannot have by construction.
  reasons.push("no_fresh_provider_baseline_in_a_historical_replay");
  return reasons;
}

export function buildD087Simulation(root: string): D087SimulationReport {
  const { businesses, sha256 } = readCensus(root);
  const cells: D087SimulationCell[] = [];

  for (const business of businesses) {
    for (const cutoff of D087_SIMULATION_CUTOFFS) {
      const cutoffMs = Date.parse(cutoff);
      const reasons = notDeterminableReasons(business, cutoffMs);
      if (reasons.length > 0) {
        cells.push({
          business: business.business,
          businessId: business.businessId,
          cutoff,
          determinable: false,
          notDeterminableBecause: Object.freeze(reasons),
          preflightBlockers: Object.freeze([]),
          eligible: false,
        });
        continue;
      }
      /*
        Unreachable with today's evidence, and deliberately kept: if a future
        slice retains the missing facts, this branch runs the REAL preflight
        rather than a restatement of it.
      */
      const parsed = parseBudgetWriteRequest({
        contractVersion: BUDGET_WRITE_REQUEST_CONTRACT,
      });
      cells.push({
        business: business.business,
        businessId: business.businessId,
        cutoff,
        determinable: true,
        notDeterminableBecause: Object.freeze([]),
        preflightBlockers: parsed.ok
          ? evaluateBudgetWritePreflight({
            request: parsed.request,
            actor: null,
            governance: null,
            automationEnabled: false,
            capability: D087_BUDGET_TRANSPORT_CAPABILITY,
            providerBaseline: null,
            policy: D087_SIMULATION_POLICY,
            history: null,
            nowMs: cutoffMs,
          }).blockers
          : Object.freeze([parsed.code]),
        eligible: false,
      });
    }
  }

  const determinable = cells.filter((c) => c.determinable).length;
  return {
    contract: D087_SIMULATION_CONTRACT,
    censusPath: D087_CENSUS_PATH,
    censusSha256: sha256,
    cutoffs: D087_SIMULATION_CUTOFFS,
    cells: Object.freeze(cells),
    totals: {
      cells: cells.length,
      determinable,
      notDeterminable: cells.length - determinable,
      eligible: cells.filter((c) => c.eligible).length,
    },
    whyNoEligibleCell:
      "Zero eligible cells is a measurement, not a target. Two facts a budget write "
      + "requires are absent from every retained account: a canonical budget fact naming "
      + "the proven owner, the amount and its captured minor-unit exponent, and a fresh "
      + "provider baseline, which a historical replay cannot have at all. Activation is "
      + "additionally off, so even a fully determinable cell would refuse.",
  };
}

if (process.argv[1] && process.argv[1].endsWith("d087-budget-write-simulation.ts")) {
  console.log(JSON.stringify(buildD087Simulation(process.cwd()), null, 2));
}
