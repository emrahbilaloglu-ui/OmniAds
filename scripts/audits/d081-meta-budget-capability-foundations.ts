/**
 * D081-D — historical capability replay.
 *
 * D080B's accepted real-data replay found zero authorised budget actions across
 * 247,050 proposals, with three capability blockers hitting 100% of them. D081
 * closes those three as local application capabilities. This script measures
 * what that actually buys, against the same frozen snapshot, without pretending
 * anything became executable.
 *
 * It reads the pinned D080B artifact and NOTHING else: no database, no
 * provider, no write. The 10 MB raw snapshot is not duplicated — it is pinned
 * by hash and only compact derived counts are emitted.
 *
 * Every row carries a truth label:
 *   verified_fact          — observed in the frozen D080B snapshot.
 *   capability_overlay     — a counterfactual: what the new capability WOULD
 *                            resolve. Never evidence that an action is allowed.
 *   inference              — supported but not directly observed.
 *   unknown                — absent, and left absent.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  resolveMinorUnitExponent,
  ISO_4217_REGISTRY_VERSION,
} from "@/lib/currency/iso-4217-minor-units";
import {
  META_BUDGET_INTENT_CONTRACT_VERSION,
  budgetIntentIsExecutable,
  validateBudgetIntent,
  type BudgetIntentInput,
} from "@/lib/meta/budget-intent-contract";
import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";
import {
  CANONICAL_ROLE_AUTHORITY_RULE,
  resolveCampaignRoleAuthority,
  type AutomaticRoleEvidenceRow,
  type ObservedCampaignIdentity,
} from "@/lib/meta/campaign-role-authority";
import {
  D080_PINNED_BINDINGS,
  canonicalJson,
  sha256Canonical,
} from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  analyse as analyseD080B,
  materialiseSnapshot,
  type MaterialisedRead,
} from "@/scripts/audits/d080b-meta-budget-policy-simulation";

export const D081_CONTRACT_ID = "adsecute.meta.d081-budget-capability-foundations.v1" as const;
export const D081_JSON_OUT =
  "docs/audits/generated/d081-meta-budget-capability-foundations-2026-09-01.json";

/** The accepted D080B package this replay is pinned to. Verified before use. */
export const D081_PINNED_INPUTS = {
  d080bArtifactPath: "docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json",
  d080bArtifactSha256: "b46e6aa80c75aec0ebc724f2b8fcc288cda611353e9924a85504d3e498d155df",
  d080bSnapshotHash: "d9d73c69b9e034377bd37b374b5710adbb2e6614b5fb9cbe4c2fc02cae7ffa97",
  d080bAnalysisHash: "c7df163691dd23f7017901b6bf78d7f6df523e7fc4176a045a0f1dcb0bd10d10",
  d080bArtifactHash: "314a90cdb7ac589d271e2b8de82e02318ec81485da75e86ebee28ab15ab0552e",
  d080aArtifactSha256: "d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69",
} as const;

/** The three blockers D081 sets out to close, and nothing else. */
export const D081_TARGET_BLOCKERS = [
  "decision_vocabulary_absent",
  "role_authority_absent",
  "unit_exponent_unknown",
] as const;
export type D081TargetBlocker = (typeof D081_TARGET_BLOCKERS)[number];

export const TRUTH_LABELS = ["verified_fact", "capability_overlay", "inference", "unknown"] as const;
export type TruthLabel = (typeof TRUTH_LABELS)[number];

/** How fresh automatic role evidence must be to carry authority here. */
export const ROLE_EVIDENCE_MAX_AGE_DAYS = 14;

/**
 * The approved resolver build. The replay defers to the same rule the runtime
 * uses: a row may only carry authority when its resolver version is the
 * approved one. The frozen snapshot retains no resolver version at all, so
 * every row fails closed here — which is the honest outcome, not a bug.
 */
export const CANONICAL_RESOLVER_VERSION_VALIDATOR = isCampaignContextResolverAuthorityValidated;

type Row = Record<string, unknown>;
const text = (v: unknown): string | null =>
  typeof v === "string" ? (v.trim() || null) : v === null || v === undefined ? null : String(v);

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sumRows(map: Map<string, { rows: number }>): number {
  return [...map.values()].reduce((n, b) => n + b.rows, 0);
}

function dimensionRows(
  map: Map<string, { rows: number; vocabulary: number; unit: number; role: number; residualZero: number }>,
  keyName: string,
): Row[] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, c]) => ({
    [keyName]: key, proposals: c.rows, vocabulary_resolvable: c.vocabulary,
    unit_resolvable: c.unit, role_resolvable: c.role,
    no_residual_blocker: c.residualZero, truth: "capability_overlay" as TruthLabel,
  }));
}

export interface CapabilityReplayResult {
  denominators: Record<string, number>;
  before: Record<string, number>;
  resolvable: Record<string, unknown>;
  residual: Record<string, unknown>;
  perBusiness: Row[];
  perAccount: Row[];
  perGrain: Row[];
  perFold: Row[];
  reconciliation: Record<string, unknown>;
  roleDiagnostics: Record<string, unknown>;
  currencyDiagnostics: Record<string, unknown>;
  intentDiagnostics: Record<string, unknown>;
  leakage: Row[];
  accountIsolation: Row[];
}

/**
 * Applies the three new capabilities to the frozen D080B proposals.
 *
 * A blocker is only counted as resolvable when the new code genuinely resolves
 * it for that row. `decision_vocabulary_absent` is the one capability that is
 * row-independent — the type either exists or it does not — and it is labelled
 * as such rather than being spread across rows as if it were measured.
 */
export function replayCapabilities(reads: MaterialisedRead[]): CapabilityReplayResult {
  const mat = materialiseSnapshot(reads);
  const snapshotHash = sha256Canonical(reads.map((r) => r.invocationKey).sort());
  const analysis = analyseD080B({ ...mat, snapshotHash });
  const proposals = analysis.proposals;

  // --- currency, per account: verified fact from the snapshot --------------
  const currencyByAccount = new Map<string, string | null>();
  for (const row of mat.accountCurrency ?? []) {
    const acct = text(row.provider_account_id);
    if (acct && !currencyByAccount.has(acct)) currencyByAccount.set(acct, text(row.account_currency));
  }
  const exponentByAccount = new Map<string, ReturnType<typeof resolveMinorUnitExponent>>();
  for (const [acct, currency] of currencyByAccount) {
    exponentByAccount.set(acct, resolveMinorUnitExponent(currency));
  }

  // --- observed campaign/account identities, for role account-scoping ------
  const identities: ObservedCampaignIdentity[] = [];
  for (const row of mat.ownerStates ?? []) {
    const acct = text(row.provider_account_id);
    const biz = text(row.business_id);
    const campaign = text(row.entity_type) === "campaign" ? text(row.entity_id) : text(row.campaign_id);
    const observedOn = text(row.observed_on)?.slice(0, 10) ?? null;
    if (acct && biz && campaign && observedOn) {
      identities.push({ businessId: biz, providerAccountId: acct, campaignId: campaign, observedOn });
    }
  }
  // Keyed by business AND campaign: a campaign id is only unique inside an
  // account, so a campaign-only index is a cross-business join waiting to
  // happen.
  const identityByCampaign = new Map<string, ObservedCampaignIdentity[]>();
  for (const id of identities) {
    const key = `${id.businessId}|${id.campaignId}`;
    const list = identityByCampaign.get(key) ?? [];
    list.push(id);
    identityByCampaign.set(key, list);
  }

  // --- automatic role evidence, exactly as retained ------------------------
  const roleByCampaign = new Map<string, AutomaticRoleEvidenceRow[]>();
  for (const row of mat.roleContext ?? []) {
    const campaign = text(row.campaign_id);
    const business = text(row.business_id);
    if (!campaign || !business) continue;
    const list = roleByCampaign.get(`${business}|${campaign}`) ?? [];
    list.push({
      businessId: String(text(row.business_id)),
      // The historical gap: this is null on every retained row.
      providerAccountId: text(row.provider_account_id),
      campaignId: campaign,
      asOfDate: String(text(row.as_of_date)?.slice(0, 10)),
      inferredKind: text(row.inferred_kind),
      confidenceClass: text(row.confidence_class),
      // The frozen snapshot retains neither kind_source nor resolver_version:
      // its roleContext read selects campaign_id, as_of_date, inferred_kind,
      // confidence_class and provider_account_id only. Both absences are
      // reported as absent, never assumed to be the automatic value.
      kindSource: text(row.kind_source),
      // The frozen D080B snapshot does NOT retain resolver_version: its
      // roleContext read selects campaign_id, as_of_date, inferred_kind,
      // confidence_class and provider_account_id only. Absent provenance is
      // reported as absent, never assumed to be the approved build.
      resolverVersion: text(row.resolver_version),
    });
    roleByCampaign.set(`${business}|${campaign}`, list);
  }

  const before = tally(proposals.flatMap((p) => p.blockers));
  const roleCache = new Map<string, boolean>();
  const roleStatusCache = new Map<string, string>();

  let unitResolvable = 0;
  let roleResolvable = 0;
  const residualBlockers: string[] = [];
  type Bucket = { rows: number; vocabulary: number; unit: number; role: number; residualZero: number };
  const blank = (): Bucket => ({ rows: 0, vocabulary: 0, unit: 0, role: 0, residualZero: 0 });
  const perBusinessCounts = new Map<string, Bucket>();
  const perAccountCounts = new Map<string, Bucket>();
  const perGrainCounts = new Map<string, Bucket>();
  const perFoldCounts = new Map<string, Bucket>();
  const foldOfOrigin = new Map<string, number>(
    analysis.origins.map((o) => [o.origin, o.fold]),
  );
  const roleStatusCensus: string[] = [];

  for (const p of proposals) {
    const acct = p.providerAccountId;
    const exponent = exponentByAccount.get(acct);
    const unitOk = exponent?.status === "resolved";
    if (unitOk) unitResolvable += 1;

    const campaignId = p.campaignId;
    const roleKey = `${acct}|${campaignId ?? ""}|${p.originDate}`;
    let roleOk = roleCache.get(roleKey);
    if (roleOk === undefined) {
      if (!campaignId) {
        roleOk = false;
        roleStatusCache.set(roleKey, "no_campaign_identity");
      } else {
        const resolution = resolveCampaignRoleAuthority({
          request: {
            businessId: p.businessId, providerAccountId: acct, campaignId,
            asOfDate: p.originDate, maxEvidenceAgeDays: ROLE_EVIDENCE_MAX_AGE_DAYS,
          },
          // Indexed by the FULL composite scope. Indexing by campaign id alone
          // would hand this business's request a different business's rows.
          evidence: roleByCampaign.get(`${p.businessId}|${campaignId}`) ?? [],
          identities: identityByCampaign.get(`${p.businessId}|${campaignId}`) ?? [],
          isResolverVersionValidated: CANONICAL_RESOLVER_VERSION_VALIDATOR,
        });
        roleOk = resolution.satisfiesRoleAuthority;
        roleStatusCache.set(roleKey, roleOk ? "resolved" : (resolution.blockers[0] ?? resolution.status));
      }
      roleCache.set(roleKey, roleOk);
    }
    if (roleOk) roleResolvable += 1;
    roleStatusCensus.push(roleStatusCache.get(roleKey) ?? "unknown");

    // The residual: every blocker D080B found, minus only the ones this slice
    // genuinely closes for THIS row.
    const residual = p.blockers.filter((b) => {
      if (b === "decision_vocabulary_absent") return false;      // the type now exists
      if (b === "unit_exponent_unknown") return !unitOk;         // per-account
      if (b === "role_authority_absent") return !roleOk;         // per-campaign-origin
      return true;
    });
    residualBlockers.push(...residual);

    // Every dimension is advanced from the SAME row, so the four breakdowns
    // reconcile to the headline by construction rather than by coincidence.
    for (const [map, key] of [
      [perBusinessCounts, p.business],
      [perAccountCounts, p.providerAccountId],
      [perGrainCounts, p.entityGrain],
      [perFoldCounts, `fold_${foldOfOrigin.get(p.originDate) ?? 0}`],
    ] as Array<[Map<string, Bucket>, string]>) {
      const bucket = map.get(key) ?? blank();
      bucket.rows += 1;
      bucket.vocabulary += 1;
      if (unitOk) bucket.unit += 1;
      if (roleOk) bucket.role += 1;
      if (residual.length === 0) bucket.residualZero += 1;
      map.set(key, bucket);
    }
  }

  const residual = tally(residualBlockers);
  const clearedAll = proposals.filter((p) => {
    const acct = p.providerAccountId;
    const unitOk = exponentByAccount.get(acct)?.status === "resolved";
    const roleOk = roleCache.get(`${acct}|${p.campaignId ?? ""}|${p.originDate}`) === true;
    return p.blockers.every((b) =>
      b === "decision_vocabulary_absent" ||
      (b === "unit_exponent_unknown" && unitOk) ||
      (b === "role_authority_absent" && roleOk));
  }).length;

  // --- account isolation: the deselected reference account stays out -------
  const accountIsolation = D080_PINNED_BINDINGS.map((b) => ({
    business: b.business, provider_account_id: b.providerAccountId, is_selected: b.isSelected,
    proposals: proposals.filter((p) => p.providerAccountId === b.providerAccountId).length,
    scope_blocked: proposals.filter(
      (p) => p.providerAccountId === b.providerAccountId && p.blockers.includes("account_not_selected"),
    ).length,
    truth: "verified_fact" as TruthLabel,
  }));

  // --- no future leakage, at the real selector boundary -------------------
  const leakage = buildRoleLeakageChecks();

  return {
    denominators: {
      proposals: proposals.length,
      origins: analysis.origins.length,
      entities: analysis.entityUniverse.length,
      accounts: D080_PINNED_BINDINGS.length,
      businesses: new Set(D080_PINNED_BINDINGS.map((b) => b.business)).size,
    },
    before,
    resolvable: {
      decision_vocabulary_absent: {
        closure: "implemented_and_integrated_canonical_capability",
        rows: proposals.length,
        basis: "canonical_vocabulary_membership",
        truth: "verified_fact" as TruthLabel,
        evidence: `A budget intent is a discriminated member of MetaOsDecisionAction via MetaOsBudgetIntentPayload, produced by toCanonicalDecisionAction. The blocker is closed application-wide because the canonical output vocabulary can now carry the intent, not because a standalone type exists. It remains non-dispatchable: providerMutation is null and no endpoint was added.`,
      },
      unit_exponent_unknown: {
        closure: "implemented_and_integrated_canonical_capability",
        rows: unitResolvable,
        basis: "per_account_currency_lookup_against_a_versioned_registry",
        truth: "capability_overlay" as TruthLabel,
        registryVersion: ISO_4217_REGISTRY_VERSION,
        evidence: "Every account currency observed in the frozen snapshot resolves to a transcribed ISO exponent. This is a frozen-data resolution, not a claim that any change is permitted.",
      },
      role_authority_absent: {
        closure: roleResolvable > 0
          ? "frozen_data_resolvable_under_exact_canonical_authority"
          : "residual_data_gap",
        rows: roleResolvable,
        basis: "canonical_rule_system_inferred_plus_high_confidence_plus_validated_resolver_version",
        truth: "capability_overlay" as TruthLabel,
        evidence: "The capability is implemented and wired into the canonical decision-authority read path, but the frozen D080B snapshot retains NEITHER kind_source NOR resolver_version: its roleContext read selects campaign_id, as_of_date, inferred_kind, confidence_class and provider_account_id only. The canonical rule requires source === 'system_inferred' AND confidence 'high' AND a validated resolver version; two of those three provenances were never captured. Both absences fail closed rather than being assumed, so no row resolves. This is a data-retention gap, not a code gap.",
        missingProvenance: ["kind_source", "resolver_version"],
        firstGateObserved: "role_source_not_system_inferred",
        firstGateNote: "Both provenances are absent. The source gate is earlier in the ladder, so it is the blocker the census records; fixing only resolver_version would not resolve a single row.",
      },
    },
    residual: {
      blockerCensus: residual,
      proposalsWithNoResidualBlocker: clearedAll,
      state: clearedAll === 0 ? "no_row_reaches_preview" : "preview_only_non_executable",
      note: "A row with no residual blocker would be preview-only and still non-executable: no provider write path exists, and D081 adds none.",
      truth: "capability_overlay" as TruthLabel,
    },
    perBusiness: dimensionRows(perBusinessCounts, "business"),
    perAccount: [...perAccountCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, c]) => {
      const binding = D080_PINNED_BINDINGS.find((b) => b.providerAccountId === key);
      return {
        provider_account_id: key, business: binding?.business ?? null,
        is_selected: binding?.isSelected ?? null,
        proposals: c.rows, vocabulary_resolvable: c.vocabulary, unit_resolvable: c.unit,
        role_resolvable: c.role, no_residual_blocker: c.residualZero,
        truth: "capability_overlay" as TruthLabel,
      };
    }),
    perGrain: dimensionRows(perGrainCounts, "grain"),
    perFold: dimensionRows(perFoldCounts, "fold"),
    reconciliation: {
      // Each dimension must sum to the headline. A breakdown that does not is
      // a different population being reported as the same one.
      proposals: proposals.length,
      perBusinessTotal: sumRows(perBusinessCounts),
      perAccountTotal: sumRows(perAccountCounts),
      perGrainTotal: sumRows(perGrainCounts),
      perFoldTotal: sumRows(perFoldCounts),
      vocabularyResolvableTotal: proposals.length,
      unitResolvableTotal: unitResolvable,
      roleResolvableTotal: roleResolvable,
      reconciles:
        sumRows(perBusinessCounts) === proposals.length &&
        sumRows(perAccountCounts) === proposals.length &&
        sumRows(perGrainCounts) === proposals.length &&
        sumRows(perFoldCounts) === proposals.length,
      truth: "verified_fact" as TruthLabel,
    },
    roleDiagnostics: {
      retainedRoleRows: (mat.roleContext ?? []).length,
      retainedRoleRowsWithAccount: (mat.roleContext ?? []).filter((r) => text(r.provider_account_id) !== null).length,
      observedIdentities: identities.length,
      distinctCampaignsWithIdentity: identityByCampaign.size,
      outcomeCensus: tally(roleStatusCensus),
      truth: "verified_fact" as TruthLabel,
      note: "Account scope can only come from an observed campaign/account identity, because every retained role row has a null provider account.",
    },
    currencyDiagnostics: {
      observedCurrencies: tally([...currencyByAccount.values()].map((c) => c ?? "unknown")),
      perAccount: [...exponentByAccount.entries()].sort().map(([acct, r]) => ({
        provider_account_id: acct, currency: currencyByAccount.get(acct) ?? null,
        status: r.status, exponent: r.status === "resolved" ? r.exponent : null,
        truth: "verified_fact" as TruthLabel,
      })),
    },
    intentDiagnostics: {
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      executable: budgetIntentIsExecutable(),
      note: "The contract validates a shape. Validation is the ceiling; the highest execution state reachable is validated_only.",
      truth: "verified_fact" as TruthLabel,
    },
    leakage,
    accountIsolation,
  };
}

/**
 * Future-leakage proof at the real selector boundary, for the role capability.
 * The negative control proves the same fact becomes visible once the origin
 * advances past it, so a passing check is not simply a broken lookup.
 */
export function buildRoleLeakageChecks(): Row[] {
  const biz = "leak-biz";
  const acct = "act_leak";
  const campaign = "leak-campaign";
  // The fixture carries a resolver version and a stub validator: this check is
  // about the SELECTOR boundary, so the authority rule must be satisfiable or
  // the negative control could never show the fact becoming visible.
  const FIXTURE_RESOLVER = "d081-leakage-fixture-resolver";
  const fixtureValidator = (v: string | null | undefined) => v === FIXTURE_RESOLVER;
  const evidence: AutomaticRoleEvidenceRow[] = [
    { businessId: biz, providerAccountId: acct, campaignId: campaign, asOfDate: "2026-08-15", inferredKind: "main", confidenceClass: "high", resolverVersion: FIXTURE_RESOLVER, kindSource: "system_inferred" },
  ];
  const identitiesLater: ObservedCampaignIdentity[] = [
    { businessId: biz, providerAccountId: acct, campaignId: campaign, observedOn: "2026-08-15" },
  ];
  const at = (asOfDate: string, ids: ObservedCampaignIdentity[] = []) =>
    resolveCampaignRoleAuthority({
      request: { businessId: biz, providerAccountId: acct, campaignId: campaign, asOfDate, maxEvidenceAgeDays: ROLE_EVIDENCE_MAX_AGE_DAYS },
      evidence, identities: ids, isResolverVersionValidated: fixtureValidator,
    });
  const earlier = at("2026-08-01");
  const later = at("2026-08-20");
  const earlierIdentity = resolveCampaignRoleAuthority({
    request: { businessId: biz, providerAccountId: acct, campaignId: campaign, asOfDate: "2026-08-01", maxEvidenceAgeDays: ROLE_EVIDENCE_MAX_AGE_DAYS },
    evidence: [{ ...evidence[0]!, providerAccountId: null, asOfDate: "2026-07-28" }],
    identities: identitiesLater,
    isResolverVersionValidated: fixtureValidator,
  });
  return [
    {
      check: "later_role_evidence_not_selected_at_earlier_origin",
      authority_at_origin: earlier.satisfiesRoleAuthority,
      blocker_at_origin: earlier.blockers[0] ?? null,
      authority_after_origin_advances: later.satisfiesRoleAuthority,
      negative_control_passes: earlier.satisfiesRoleAuthority === false && later.satisfiesRoleAuthority === true,
      truth: "verified_fact" as TruthLabel,
    },
    {
      check: "later_identity_join_cannot_scope_an_earlier_origin",
      authority_at_origin: earlierIdentity.satisfiesRoleAuthority,
      blocker_at_origin: earlierIdentity.blockers[0] ?? null,
      negative_control_passes: earlierIdentity.satisfiesRoleAuthority === false,
      truth: "verified_fact" as TruthLabel,
    },
  ];
}

/** A worked typed intent, so the report shows the shape rather than describing it. */
export function buildWorkedIntentExample(): Row {
  const known = D080_PINNED_BINDINGS.map((b) => ({ businessId: b.businessId, providerAccountId: b.providerAccountId }));
  const binding = D080_PINNED_BINDINGS[0]!;
  const input: BudgetIntentInput = {
    contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
    scope: {
      businessId: binding.businessId, providerAccountId: binding.providerAccountId,
      entityGrain: "campaign", entityId: "worked-example-campaign", parentCampaignId: null,
    },
    ownerMode: "campaign_budget_optimization",
    budgetField: "daily_budget",
    observedDailyMinorUnits: 300_000,
    observedLifetimeMinorUnits: null,
    lifetimeSchedule: null,
    direction: "decrease",
    percent: 10,
    accountCurrency: "USD",
    originDate: "2026-08-01",
    effectiveAsOf: "2026-08-01",
    knowledgeAsOf: "2026-08-01",
    authorityEvidenceAsOf: "2026-07-28",
    maxAuthorityEvidenceAgeDays: ROLE_EVIDENCE_MAX_AGE_DAYS,
    sourceFingerprints: {
      configStateHash: createHash("sha256").update("worked-config").digest("hex"),
      ownerStateHash: createHash("sha256").update("worked-owner").digest("hex"),
      roleAuthorityHash: createHash("sha256").update("worked-role").digest("hex"),
    },
    evidenceWindow: { from: "2026-07-25", to: "2026-07-31" },
    targetSource: { source: "business_target_pack_history", version: "2026-07-20" },
    authorityStatus: "not_determinable",
    blockerCodes: ["owner_evidence_absent"],
  };
  const result = validateBudgetIntent(input, known);
  return {
    status: result.status,
    intent: result.status === "valid" ? result.intent : null,
    rejections: result.status === "rejected" ? result.rejections : [],
    truth: "verified_fact" as TruthLabel,
    note: "A validated SHAPE, not an authorised action: authorityStatus is not_determinable and executionState is validated_only.",
  };
}

export function sealArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  return { ...body, artifactHash: sha256Canonical(body) };
}

/**
 * Builds the compact D081 artifact from the pinned D080B package.
 *
 * The raw snapshot is never copied: only its hash and compact derived counts
 * are emitted, so this artifact is independently reproducible from the pinned
 * D080B file plus this repository's code.
 */
export function buildArtifact(d080bArtifact: Record<string, unknown>): Record<string, unknown> {
  const snapshot = d080bArtifact.snapshot as { reads?: MaterialisedRead[] } | undefined;
  if (!snapshot?.reads) throw new Error("D081: the pinned D080B artifact carries no frozen reads");
  const replay = replayCapabilities(snapshot.reads);
  return sealArtifact({
    contract: D081_CONTRACT_ID,
    truthLabels: TRUTH_LABELS,
    pinnedInputs: D081_PINNED_INPUTS,
    capabilities: {
      typedBudgetIntent: {
        module: "lib/meta/budget-intent-contract",
        contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
        implemented: true, executable: false,
        canonicalIntegration: {
          contract: "lib/meta/decisions-os-contract",
          member: "MetaOsDecisionAction.budgetIntent (MetaOsBudgetIntentPayload)",
          adapter: "toCanonicalDecisionAction",
          runtimeConsumer: "app/api/meta/decisions-workspace/route.ts calls buildMetaOsDecisionsPresentation, which calls toCanonicalDecisionAction and serves the action in its budgetReview block",
          payloadLossless: true,
          discriminatedUnion: "MetaOsLegacyDecisionAction | MetaOsBudgetDecisionAction",
          servedIntent: "review",
          providerMutation: null,
          dispatchVerbAdded: false,
          proposalQueueWidened: false,
        },
        truth: "verified_fact",
      },
      accountScopedRoleAuthority: {
        module: "lib/meta/campaign-role-authority",
        implemented: true, manualLabelInput: false, readsCampaignName: false,
        canonicalRule: CANONICAL_ROLE_AUTHORITY_RULE,
        boundToCanonicalValidator: "isCampaignContextResolverAuthorityValidated",
        runtimeConsumer: "lib/meta/decisions-workspace-read-model.ts calls evaluateAccountScopedRoleAuthority to compute trustedForAction",
        truth: "verified_fact",
      },
      currencyExponentAuthority: {
        module: "lib/currency/iso-4217-minor-units",
        registryVersion: ISO_4217_REGISTRY_VERSION, implemented: true, truth: "verified_fact",
      },
    },
    replay,
    workedIntentExample: buildWorkedIntentExample(),
    nameAuthority: {
      status: "closed_at_the_resolver_boundary",
      change: "the high-confidence gate now counts only non-naming agreeing families AND is evaluated on a naming-free score, for every kind",
      previously: "for Main and Mixed a human-authored campaign name could be one of the two agreeing families that yielded high confidence, and its weight could carry topScore/margin over the threshold",
      manualLabelsRestored: false,
      truth: "verified_fact",
    },
    limits: {
      executable: false,
      causalClaims: { roasLift: null, revenueLift: null, purchaseLift: null, profitLift: null },
      note: "Closing these three blockers does not make any proposal executable. Every evidence, delivery, commercial, cooldown, concentration, idempotency, read-back and kill-switch gate proven in D080B still applies, no provider write path exists, and D081 adds none.",
      historicalTransitions: "observational only; no causal lift is claimed anywhere",
      truth: "verified_fact",
    },
  });
}

export function runBuild(): void {
  const path = resolvePath(D081_PINNED_INPUTS.d080bArtifactPath);
  const bytes = readFileSync(path);
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== D081_PINNED_INPUTS.d080bArtifactSha256) {
    throw new Error(`D081 refuses to run: the pinned D080B artifact hash is ${observed}, expected ${D081_PINNED_INPUTS.d080bArtifactSha256}`);
  }
  const d080b = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const artifact = buildArtifact(d080b);
  writeFileSync(resolvePath(D081_JSON_OUT), JSON.stringify(artifact, null, 1));
  const replay = (artifact.replay ?? {}) as CapabilityReplayResult;
  console.log(JSON.stringify({
    phase: "d081-build",
    artifactHash: artifact.artifactHash,
    denominators: replay.denominators,
    resolvable: Object.fromEntries(
      Object.entries(replay.resolvable).map(([k, v]) => [k, (v as Row).rows]),
    ),
    proposalsWithNoResidualBlocker: (replay.residual as Row).proposalsWithNoResidualBlocker,
  }, null, 1));
}

/** Verifies the compact artifact by rebuilding it from the pinned D080B file. */
export function runVerify(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const stored = JSON.parse(readFileSync(resolvePath(D081_JSON_OUT), "utf8")) as Record<string, unknown>;
  const bytes = readFileSync(resolvePath(D081_PINNED_INPUTS.d080bArtifactPath));
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== D081_PINNED_INPUTS.d080bArtifactSha256) {
    failures.push(`pinnedInputs: the D080B artifact hash is ${observed}, not the pinned value`);
  }
  const rebuilt = buildArtifact(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
  // No self-authored hash is the sole check: the whole body is rebuilt.
  if (canonicalJson(stored) !== canonicalJson(rebuilt)) {
    const storedKeys = Object.keys(stored);
    for (const key of storedKeys) {
      if (canonicalJson(stored[key] ?? null) !== canonicalJson(rebuilt[key] ?? null)) {
        failures.push(`${key}: does not match a rebuild from the pinned D080B artifact and this repository's code`);
      }
    }
    if (failures.length === 0) failures.push("artifact: differs from its rebuild in an unnamed way");
  }
  if (stored.contract !== D081_CONTRACT_ID) failures.push(`contract: expected ${D081_CONTRACT_ID}`);
  const result = { ok: failures.length === 0, failures };
  console.log(JSON.stringify({ phase: "d081-verify", ...result }, null, 1));
  return result;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d081-meta-budget-capability-foundations")) {
  const mode = process.argv[2] ?? "build";
  if (mode === "build") runBuild();
  else if (mode === "verify") { if (!runVerify().ok) process.exitCode = 1; }
  else { console.error(`unknown mode ${mode}`); process.exitCode = 2; }
}
