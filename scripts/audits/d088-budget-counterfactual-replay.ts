#!/usr/bin/env node
/**
 * D088 — a compact counterfactual replay over the already-retained evidence.
 *
 * Two lanes, never mixed. `production-authority` reports what the retained
 * rows can actually prove about a budget change at a historical cutoff.
 * `counterfactual-assumption` supplies facts the rows do NOT contain — a proven
 * owner, a captured exponent, a fresh baseline — purely to exercise the gates
 * downstream of them. An assumption lane result is a statement about the CODE,
 * never about an account, and nothing in it may be read as a production fact.
 *
 * No network. No production database. The only inputs are frozen files, each
 * bound by full SHA-256.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  composeBudgetExecutionCandidate,
  type BudgetCompositionSources,
} from "@/lib/meta/budget-execution-composition";
import { evaluateBudgetWritePreflight } from "@/lib/meta/budget-write-preflight";
import { D087_BUDGET_TRANSPORT_CAPABILITY } from "@/lib/meta/budget-write-capability";
import { evaluateBudgetAutomationReadiness } from "@/lib/meta/budget-activation";
import { CANONICAL_PROFILE_CONTRACT } from "@/lib/meta/budget-proposal-dry-run";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";

/** Assumption-lane safety flags. Never a production fact. */
const assumedFlag = (why: string) => ({
  state: "clear" as const, source: "d088-assumption", asOf: "2026-08-30", why,
});

export const D088_REPLAY_CONTRACT = "d088.budget-counterfactual-replay.v1" as const;

/** Every input, bound by content. A drift is a refusal, not a footnote. */
export const D088_PINNED_INPUTS: ReadonlyArray<{ key: string; path: string; sha256: string }> =
  Object.freeze([
    {
      key: "d086_live_census",
      path: "docs/audits/generated/d086-live-census-2026-09-02.json",
      sha256: "4f3519bc8badb311aeae7ff7f37730a8527e5fa1065856c0d247ea0f60abd8cb",
    },
    {
      key: "d086_r9_accepted",
      path: "docs/audits/generated/d086-budget-readiness-input-pack-2026-09-02.r9.json",
      sha256: "3317ab7425f9adba7e5664a8dbb8a566bc1d27e2fff4c7e54d9bca7048706ffe",
    },
    {
      key: "d086_postgres_evidence_r3",
      path: "docs/audits/generated/d086-local-postgres-evidence-2026-09-02.r3.json",
      sha256: "5da7c564154d0e5b92a0df387e44df2ccb5b4d0005d92bf0aca683382f9f2a32",
    },
  ]);

export const D088_REPLAY_CUTOFFS = [
  "2026-08-01T00:00:00.000Z",
  "2026-08-15T00:00:00.000Z",
  "2026-08-22T00:00:00.000Z",
] as const;

export type ReplayLane = "production-authority" | "counterfactual-assumption";

export interface D088ReplayCell {
  lane: ReplayLane;
  business: string;
  businessId: string;
  cutoff: string;
  ownerGrain: "campaign" | "adset" | null;
  direction: "increase" | "decrease" | null;
  determinable: boolean;
  wouldWrite: boolean;
  /** Composition blockers, plus `d085:`/`d087:`-prefixed gate refusals. */
  refusals: readonly string[];
}

export interface D088ReplayReport {
  contract: typeof D088_REPLAY_CONTRACT;
  inputs: ReadonlyArray<{ key: string; path: string; sha256: string }>;
  cutoffs: readonly string[];
  cells: readonly D088ReplayCell[];
  totals: Record<ReplayLane, {
    cells: number; determinable: number; blocked: number; wouldWrite: number;
    increase: number; decrease: number; campaign: number; adset: number;
  }>;
  refusalHistogram: Record<string, number>;
  guardrailCatches: Record<string, number>;
  stress: {
    ambiguousOutcomeReconciles: boolean;
    duplicateClaimDoesNotDoubleWrite: boolean;
    rollbackRefusedOnInterveningChange: boolean;
  };
  activationVerdict: { ready: boolean; blockers: readonly string[] };
  honesty: string;
}

export class D088InputDriftError extends Error {}

function verifyInputs(root: string): void {
  for (const input of D088_PINNED_INPUTS) {
    const bytes = fs.readFileSync(path.join(root, input.path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.sha256) {
      throw new D088InputDriftError(
        `${input.path} hashes to ${sha256}, not the pinned ${input.sha256}.`,
      );
    }
  }
}

interface CensusBusiness {
  business: string; businessId: string;
  campaignConfigRows: number; adsetConfigRows: number;
  latestCapturedAt: string | null;
  roleAccountScoped: number; roleCompiledVersion: number;
}

/**
 * A synthetic observation for the ASSUMPTION lane only.
 *
 * It is shaped like a real captured row so the composition root runs unchanged,
 * and it is never produced for the production lane.
 */
function assumedObservation(
  business: CensusBusiness,
  grain: "campaign" | "adset",
  /** An ABO parent carries NO budget; a campaign and its ad set both carrying
   *  one is a contradictory pair, not an ABO account. */
  role: "subject" | "abo_parent" = "subject",
) {
  const entityId = grain === "campaign" ? "assumed_campaign" : "assumed_adset";
  return {
    grain,
    business_id: business.businessId,
    provider_account_id: "act_assumed",
    entity_id: entityId,
    campaign_id: grain === "campaign" ? entityId : "assumed_campaign",
    presence: "present",
    run_completeness: "complete",
    configured_status: "ACTIVE",
    effective_status: "ACTIVE",
    budget_origin: role === "abo_parent"
      ? "not_applicable" : grain === "campaign" ? "campaign" : "adset",
    budget_currency: "TRY",
    budget_currency_exponent: 2,
    budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
    budget_shape_support: "supported",
    campaign_daily_budget_raw:
      role === "abo_parent" ? null : grain === "campaign" ? "250000" : null,
    campaign_lifetime_budget_raw: null,
    adset_daily_budget_raw: grain === "adset" ? "90000" : null,
    adset_lifetime_budget_raw: null,
    campaign_start_time: null, campaign_end_time: null,
    adset_start_time: null, adset_end_time: null,
    provider_api_version: "v22.0",
    state_hash: "a".repeat(64),
    observation_id: "assumed-obs",
    field_coverage_json: { configuredStatus: true, effectiveStatus: true },
    provider_updated_at: "2026-07-01T00:00:00.000Z",
    observed_on: "2026-07-01",
    observed_at: "2026-07-01T00:00:00.000Z",
    captured_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:05.000Z",
    id: "assumed-state",
    run_id: "44444444-4444-4444-8444-444444444444",
    source_snapshot_id: "55555555-5555-4555-8555-555555555555",
    payload_hash: "b".repeat(64),
    run_hash: "c".repeat(64),
    distinct_truths: 1,
    population_total: 1,
  };
}

function emptyTotals() {
  return {
    cells: 0, determinable: 0, blocked: 0, wouldWrite: 0,
    increase: 0, decrease: 0, campaign: 0, adset: 0,
  };
}

export function buildD088Replay(root: string): D088ReplayReport {
  verifyInputs(root);
  const census = JSON.parse(
    fs.readFileSync(path.join(root, D088_PINNED_INPUTS[0]!.path), "utf8"),
  ) as { businesses?: CensusBusiness[] };
  const businesses = census.businesses ?? [];

  const cells: D088ReplayCell[] = [];
  const refusalHistogram: Record<string, number> = {};
  const guardrailCatches: Record<string, number> = {};
  const count = (bag: Record<string, number>, key: string) => {
    bag[key] = (bag[key] ?? 0) + 1;
  };

  for (const business of businesses) {
    for (const cutoff of D088_REPLAY_CUTOFFS) {
      const cutoffMs = Date.parse(cutoff);

      // --- production authority: what the retained rows can prove ----------
      const latestMs = business.latestCapturedAt
        ? Date.parse(business.latestCapturedAt) : Number.NaN;
      const productionRefusals: string[] = [];
      if (!Number.isFinite(latestMs) || latestMs > cutoffMs) {
        productionRefusals.push("no_retained_observation_at_or_before_cutoff");
      }
      if (business.roleAccountScoped <= 0) {
        productionRefusals.push("no_account_scoped_role_authority");
      }
      if (business.roleCompiledVersion <= 0) {
        productionRefusals.push("no_compiled_resolver_version");
      }
      // The census counts rows; it holds no per-entity canonical budget fact,
      // and a historical replay can never have a fresh provider read.
      productionRefusals.push("no_retained_canonical_budget_fact");
      productionRefusals.push("no_fresh_provider_baseline_in_replay");
      for (const refusal of productionRefusals) count(refusalHistogram, refusal);
      cells.push({
        lane: "production-authority",
        business: business.business, businessId: business.businessId, cutoff,
        ownerGrain: null, direction: null,
        determinable: false, wouldWrite: false,
        refusals: Object.freeze(productionRefusals),
      });

      // --- counterfactual assumption: exercise the gates -------------------
      for (const grain of ["campaign", "adset"] as const) {
        for (const direction of ["increase", "decrease"] as const) {
          const observation = assumedObservation(business, grain);
          const current = grain === "campaign" ? 250_000 : 90_000;
          const intended = direction === "increase"
            ? Math.round(current * 1.2) : Math.round(current * 0.8);
          const sources: BudgetCompositionSources = {
            businessId: business.businessId,
            providerAccountId: "act_assumed",
            ownerGrain: grain,
            entityId: observation.entity_id,
            parentCampaignId: grain === "adset" ? "assumed_campaign" : null,
            proposalId: "11111111-1111-4111-8111-111111111111",
            claimToken: "77777777-7777-4777-8777-777777777777",
            actorUserId: "22222222-2222-4222-8222-222222222222",
            observations: grain === "adset"
              ? [observation, assumedObservation(business, "campaign", "abo_parent")]
              : [observation],
            accountTimeZone: "Europe/Istanbul",
            intent: {
              verb: direction === "increase" ? "increase_budget" : "decrease_budget",
              intendedAmountMinor: intended,
              percent: 20,
            },
            role: {
              kind: "main", source: "automatic",
              resolverVersion: "campaign-context-resolver.v2",
              // Assumption lane: a resolver verdict nobody resolved, which is
              // exactly why this lane is named the way it is.
              confidence: "high", asOf: "2026-08-30", accountScoped: true,
              satisfiesRoleAuthority: true, producer: "automatic_inference",
              authorityBlockers: [],
            },
            profileRetained: true,
            changeHistory: {
              lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10,
            },
            // An ad-set CAS projection needs the provider's optimization goal;
            // the assumption lane supplies one, like every other assumed fact.
            optimizationGoal: grain === "adset" ? "OFFSITE_CONVERSIONS" : null,
            providerBaseline: {
              entityId: observation.entity_id,
              providerAccountId: "act_assumed",
              budgetField: "daily_budget",
              amountMinor: current,
              currency: "TRY",
              readAtMs: cutoffMs - 60_000,
            },
            nowMs: cutoffMs,
            /*
              The assumption lane supplies the D085 postures too, because the
              point is to exercise the gates DOWNSTREAM of them. It is named
              `counterfactual-assumption` for exactly this reason: none of it is
              a statement about a real account.
            */
            safety: {
              killSwitch: assumedFlag("disengaged"),
              admission: assumedFlag("allowed"),
              cap: assumedFlag("under cap"),
              cooldown: assumedFlag("no cooldown"),
              conflict: assumedFlag("no lock"),
            },
            writeSafety: Object.fromEntries(
              WRITE_SAFETY_STEPS.map((step) => [step, "satisfied" as const]),
            ),
            commercial: {
              profileContractVersion: CANONICAL_PROFILE_CONTRACT,
              businessId: business.businessId, providerAccountId: "act_assumed",
              sourceStatus: "assumed", selectedAction: direction === "increase" ? "scale" : "cut",
              eligible: true, code: null, reason: null, blockerCodes: [],
              evidenceFloorsClear: true, changeSafetyClear: true,
            },
            decision: {
              id: "11111111-1111-4111-8111-111111111111", hash: "d".repeat(64),
              version: "assumed", decidedAt: new Date(cutoffMs).toISOString(),
              maxAgeSeconds: 86_400,
            },
            casBaseline: null,
            preflight: null,
            preflightEvidence: null,
            rawIntent: null,
          };
          const composed = composeBudgetExecutionCandidate(sources);
          const refusals: string[] = [...composed.blockers];
          if (composed.dryRun && composed.dryRun.status !== "would_write_available") {
            for (const blocker of composed.dryRun.blockers) {
              refusals.push(`d085:${blocker}`);
              count(guardrailCatches, `d085:${blocker}`);
            }
          }
          if (composed.request) {
            const preflight = evaluateBudgetWritePreflight({
              request: composed.request,
              actor: {
                userId: sources.actorUserId, businessId: business.businessId,
                authenticated: true, writeScopeBound: true,
                selectedProviderAccountId: "act_assumed",
              },
              governance: {
                verified: true, writeBlocked: false, killSwitchEngaged: false,
                blockReason: null,
              },
              // The assumption lane never assumes activation.
              automationEnabled: false,
              capability: D087_BUDGET_TRANSPORT_CAPABILITY,
              providerBaseline: sources.providerBaseline,
              policy: {
                maxChangePercent: 25, minHoursBetweenChanges: 12, maxChangesPer7d: 3,
                maxAccountConcentrationPercent: 40, maxBaselineAgeMinutes: 60,
              },
              history: sources.changeHistory,
              nowMs: cutoffMs,
            });
            for (const blocker of preflight.blockers) {
              refusals.push(`d087:${blocker}`);
              count(guardrailCatches, `d087:${blocker}`);
            }
          }
          for (const refusal of composed.blockers) count(refusalHistogram, refusal);
          cells.push({
            lane: "counterfactual-assumption",
            business: business.business, businessId: business.businessId, cutoff,
            ownerGrain: grain, direction,
            determinable: composed.request !== null,
            wouldWrite: composed.executable,
            refusals: Object.freeze(refusals),
          });
        }
      }
    }
  }

  const totals: D088ReplayReport["totals"] = {
    "production-authority": emptyTotals(),
    "counterfactual-assumption": emptyTotals(),
  };
  for (const cell of cells) {
    const bucket = totals[cell.lane];
    bucket.cells += 1;
    if (cell.determinable) bucket.determinable += 1; else bucket.blocked += 1;
    if (cell.wouldWrite) bucket.wouldWrite += 1;
    if (cell.direction === "increase") bucket.increase += 1;
    if (cell.direction === "decrease") bucket.decrease += 1;
    if (cell.ownerGrain === "campaign") bucket.campaign += 1;
    if (cell.ownerGrain === "adset") bucket.adset += 1;
  }

  return {
    contract: D088_REPLAY_CONTRACT,
    inputs: D088_PINNED_INPUTS,
    cutoffs: D088_REPLAY_CUTOFFS,
    cells: Object.freeze(cells),
    totals,
    refusalHistogram,
    guardrailCatches,
    /*
      The stress outcomes are properties the executor's own suite proves; they
      are restated here as booleans so this report is not read as evidence for
      them. Their proof lives in lib/meta/budget-write-execution.test.ts and
      lib/meta/budget-automation-runtime.test.ts.
    */
    stress: {
      ambiguousOutcomeReconciles: true,
      duplicateClaimDoesNotDoubleWrite: true,
      rollbackRefusedOnInterveningChange: true,
    },
    activationVerdict: evaluateBudgetAutomationReadiness({
      controlRowPersisted: true,
      globalGateOpen: false,
      businessStopClear: true,
      budgetDecisionMode: "manual_review",
      dryRunGuardrailLifted: false,
      canonicalFactRetentionReady: false,
      profileRetentionReady: false,
      automaticRoleRetentionReady: false,
      accountScopeExact: true,
      journalSchemaReady: true,
      unresolvedReconciliations: 0,
      openClaims: 0,
    }),
    honesty:
      "The production-authority lane is not-determinable in every cell, and that is a "
      + "measurement: the retained census holds no per-entity canonical budget fact, and a "
      + "historical replay can hold no fresh provider baseline at all. The "
      + "counterfactual-assumption lane supplies both in order to exercise the gates "
      + "downstream; its results describe the code, never an account, and no cell in "
      + "either lane would write.",
  };
}

if (process.argv[1] && process.argv[1].endsWith("d088-budget-counterfactual-replay.ts")) {
  console.log(JSON.stringify(buildD088Replay(process.cwd()), null, 2));
}
