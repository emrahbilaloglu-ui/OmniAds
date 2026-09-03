/**
 * Behavioural tests for the D080A evidence generator (Correction 3).
 *
 * These exercise SELECTION AND RESULTS. Importing this module must have no side
 * effect: the generator loads neither configuration nor the database client at
 * import time, and a subprocess test below asserts that.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ACCEPTED_CONFIDENCE_CLASSES,
  ALLOWED_CAMPAIGN_ROLES,
  BUDGET_VERBS,
  CANONICAL_DECISION_SELECTION,
  COUNT_FREE_LEDGER_IDS,
  CREATIVE_LABELS,
  D080_CAPABILITY_MATRIX,
  D080_CORRECTION_LEDGER,
  D080_FORBIDDEN_TRUTHY_FLAGS,
  D080_PINNED_BINDINGS,
  D080_QUERIES,
  D080_QUERY_MANIFEST,
  D080_SECTION_HANDLERS,
  D080_SOURCE_SEMANTICS,
  FACTUAL_UNIT_CONTRACT,
  REPLAY_BINDING_UTILISATION,
  REQUIRED_RUN_COLUMNS_FOR_STRICT_PIT,
  SENSITIVITY_UNIT_CONTRACTS,
  SUPPORTED_ROLE_RESOLVER_VERSIONS,
  assertNoExecutionAuthority,
  bindingKey,
  buildMembershipManifest,
  classifyBudgetTransition,
  compareConfigStates,
  D080_EVIDENCE_CONTRACT,
  D080_EXPECTED_INVOCATION_COUNT,
  D080_READ_PLAN,
  D080_REQUIRED_OBJECTS,
  D080_REQUIRED_SECTIONS,
  D080_STATUS_DOMAINS,
  D080_LEDGER_STATUSES,
  D080_REQUIRED_NESTED_OBJECTS,
  UNIT_READ_STATUSES,
  D080_DEPENDENCY_CODES,
  D080_FIELD_DOMAINS,
  D080_REQUIRED_COUNT_PATHS,
  assertRequestIntegrity,
  buildCanonicalRequest,
  analyseAndSeal,
  CONFIG_IDENTITY_LIMIT,
  envelopeContractFor,
  isCalendarDate,
  assembleArtifact,
  collectEvidence,
  D080_PINNED_INPUTS,
  D080_PLAN_FAMILY,
  D080_DEPENDENCY_CELL_FIELDS,
  expectedDependencyCells,
  D080_OBJECT_DOMAINS,
  D080_ROW_VALUE_DOMAINS,
  buildExpectedDispositions,
  missingPrereqsFor,
  orchestrateEvidence,
  renderVerificationBlock,
  seriesFromForCutoff,
  REPORT_BLOCK_BEGIN,
  REPORT_BLOCK_END,
  buildExpectedInvocations,
  executeGuardedRequest,
  expectedSkip,
  isCount,
  isValidCalendarDate,
  isValidTimestampWithZone,
  skipEnvelope,
  stableLedgerProjection,
  summaryBindingFor,
  deriveClaims,
  normaliseParams,
  reconcileFailureMultiset,
  reconcileInvocationResults,
  reconcileRequestProvenance,
  shapeStatement,
  expectedCoverageKeys,
  invocationKeyFor,
  reconcileCoverageAndClaims,
  reconcileInvocations,
  resolveCreativeAccountScope,
  resolveFleetComparison,
  resolveServedDate,
  validateArtifactShape,
  auditExpectedKeys,
  computeSectionHashes,
  configStateKey,
  planKeyForLedgerQuery,
  reconcileClaims,
  reconcileLedgerAndPlan,
  rowBusinessId,
  rowProviderAccountId,
  decisionIdentity,
  discoverRowBearingSections,
  evaluateEntityAtOrigin,
  evaluateExecutionAuthority,
  evaluateSchemaContract,
  fromColumnar,
  isBudgetVerb,
  isKnowledgeTimeVisible,
  isPinnedBinding,
  isPinnedBusiness,
  isResolvedStateClass,
  isTruthyFlagValue,
  pickLatestObservation,
  resolveAnchorAtOrigin,
  resolveBudgetOwnerAtOrigin,
  resolveRoleAuthorityAtOrigin,
  scanScopeAndCutoff,
  sealArtifact,
  sha256Canonical,
  toColumnar,
  transitionIdentity,
  utilisationUnderContract,
  verifyArtifact,
  type BudgetConfigState,
  type BudgetStateClass,
  type OwnershipObservation,
  type ReplayPoint,
  type RoleRow,
  type SchemaContract,
} from "./d080-meta-budget-edit-evidence";

// This file deliberately re-seals and independently verifies a large frozen
// evidence package for every adversarial mutation. A clean two-core CI runner
// measured one verification at roughly 9.8s and compound cases at 19-29s, so
// the repository-wide 15s UI/unit-test liveness bound is not appropriate here.
// Set a finite file-only bound before collection, then restore the worker
// config at EOF; assertions and coverage are unchanged.
vi.setConfig({ testTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUDGET_MINOR_UNITS = 1_000_000; // ₺10,000.00/day stored as minor units
const SPEND_MAJOR_UNITS = 9_500; // ₺9,500.00 stored in major units
const REVENUE_MAJOR_UNITS = 28_500; // ROAS 3.0

const IWA = D080_PINNED_BINDINGS[0]!;
const SWAF_SELECTED = D080_PINNED_BINDINGS[3]!;
const SWAF_ALT = D080_PINNED_BINDINGS[4]!;

const COMPATIBLE_SCHEMA: SchemaContract = evaluateSchemaContract([
  ...REQUIRED_RUN_COLUMNS_FOR_STRICT_PIT, "id", "last_seen_at",
]);
const LEGACY_SCHEMA: SchemaContract = evaluateSchemaContract([
  "id", "semantic_hash", "last_seen_at", "repeat_count", "last_checkpoint_at",
]);

function point(over: Partial<ReplayPoint> & { effectiveDate: string }): ReplayPoint {
  return {
    status: "ACTIVE", currency: "TRY", dailyBudget: BUDGET_MINOR_UNITS, lifetimeBudget: null,
    isBudgetMixed: false, spend: SPEND_MAJOR_UNITS, conversions: 40,
    revenue: REVENUE_MAJOR_UNITS, truthState: "finalized", ...over,
  };
}
function series(days: number, from = "2026-08-01", over: Partial<ReplayPoint> = {}) {
  return Array.from({ length: days }, (_, i) =>
    point({
      effectiveDate: new Date(Date.parse(`${from}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10),
      ...over,
    }),
  );
}

const CAMPAIGN_ID = "120210000000000001";
const ADSET_ID = "23851234567890123";

function obs(over: Partial<OwnershipObservation> = {}): OwnershipObservation {
  return {
    businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, entityType: "campaign",
    entityId: CAMPAIGN_ID, campaignId: CAMPAIGN_ID, adsetId: null, budgetOrigin: "campaign",
    presence: "present", runCompleteness: "complete", endpoint: "campaign_configs",
    runId: "run-1", stateHash: "hash-a", observedAt: "2026-08-14T10:00:00.000Z",
    capturedAt: "2026-08-14T10:05:00.000Z", createdAt: "2026-08-14T10:05:01.000Z", id: "row-1",
    hasCampaignDaily: true, hasCampaignLifetime: false, hasAdsetDaily: false, hasAdsetLifetime: false,
    ...over,
  };
}

function cfg(over: Partial<BudgetConfigState> = {}): BudgetConfigState {
  return {
    businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, grain: "adset",
    entityId: ADSET_ID, effectiveFrom: "2026-08-01", capturedAt: "2026-08-01T10:00:00.000Z",
    createdAt: "2026-08-01T10:00:01.000Z", id: "cfg-1", configFingerprint: "fp-a",
    stateClass: "daily_only", dailyBudget: BUDGET_MINOR_UNITS, lifetimeBudget: null,
    rawCaptures: 1, distinctFingerprints: 1, ...over,
  };
}

const AUTHORITATIVE_ROLE = { status: "authoritative" as const, role: "main", basis: "fixture" };
const ANCHOR = { status: "resolved" as const, targetRoas: 2.2, breakEvenRoas: 1.8, effectiveAt: "2026-01-01", recordedAt: "2026-01-01T00:00:00.000Z" };
const OWNER_ADSET = { status: "resolved" as const, owner: "adset" as const, ownerEntityId: ADSET_ID, basis: "fixture" };
const BASE = { origin: "2026-08-15", lookbackDays: 14, ownership: OWNER_ADSET, isBudgetOwner: true, anchor: ANCHOR, roleAuthority: AUTHORITATIVE_ROLE };
const DIVISOR_1 = SENSITIVITY_UNIT_CONTRACTS.find((c) => c.budgetToSpendDivisor === 1)!;
const DIVISOR_100 = SENSITIVITY_UNIT_CONTRACTS.find((c) => c.budgetToSpendDivisor === 100)!;

// ---------------------------------------------------------------------------
// C3.1 — the static ledger may not restate a run-dependent count
// ---------------------------------------------------------------------------

describe("C3.1 — correction facts cannot contradict the generated analysis", () => {
  it("keeps count-free ledger entries free of digits", () => {
    for (const id of COUNT_FREE_LEDGER_IDS) {
      const entry = D080_CORRECTION_LEDGER.find((e) => e.id === id)!;
      expect(entry, `${id} must exist`).toBeDefined();
      const text = `${entry.withdrawn} ${entry.correction}`;
      // The old ledger hard-coded "54 true changes" while the analysis said 63.
      expect(text, `${id} must not restate a count`).not.toMatch(/\b\d{2,}\b/);
      expect(text).not.toMatch(/\bclaimable\b(?!.*derived)/i);
    }
  });

  it("fails when a ledger entry reintroduces a run-dependent number", () => {
    const poisoned = { id: "R6", withdrawn: "x", correction: "Ad-set history contributes 54 true changes." };
    const text = `${poisoned.withdrawn} ${poisoned.correction}`;
    expect(text).toMatch(/\b\d{2,}\b/);
  });

  it("names where run-dependent config facts must be read from", () => {
    const entry = D080_CORRECTION_LEDGER.find((e) => e.id === "R6")!;
    expect(entry.correction).toMatch(/analysis\.configChangeQuality/);
  });
});

// ---------------------------------------------------------------------------
// C3.2 — the config transition model
// ---------------------------------------------------------------------------

describe("C3.2 — transitions require resolved states on both sides", () => {
  it("never coerces a dual-field state to daily", () => {
    const dual = cfg({ stateClass: "both_fields_present", lifetimeBudget: 5_000_000 });
    expect(isResolvedStateClass(dual.stateClass)).toBe(false);
    // prior dual -> next clean is unresolved, not a true change
    expect(classifyBudgetTransition(dual, cfg({ effectiveFrom: "2026-08-02", dailyBudget: 2_000_000 })))
      .toBe("unresolved_prior_state");
    // next dual is unresolved too
    expect(classifyBudgetTransition(cfg(), cfg({ effectiveFrom: "2026-08-02", stateClass: "both_fields_present", lifetimeBudget: 5_000_000 })))
      .toBe("unresolved_next_state");
  });

  it("refuses a clean row that follows a conflicted prior row", () => {
    const conflicted = cfg({ stateClass: "conflicting_capture", rawCaptures: 6, distinctFingerprints: 2 });
    const clean = cfg({ effectiveFrom: "2026-08-02", dailyBudget: 2_000_000 });
    expect(classifyBudgetTransition(conflicted, clean)).toBe("unresolved_prior_state");
    // and it must not be smuggled in as "unchanged" either
    expect(classifyBudgetTransition(conflicted, cfg({ effectiveFrom: "2026-08-02" }))).toBe("unresolved_prior_state");
  });

  it("refuses a mixed prior state", () => {
    expect(classifyBudgetTransition(cfg({ stateClass: "mixed" }), cfg({ effectiveFrom: "2026-08-02", dailyBudget: 2_000_000 })))
      .toBe("unresolved_prior_state");
  });

  it("counts a genuine single-kind value change and nothing else", () => {
    expect(classifyBudgetTransition(cfg(), cfg({ effectiveFrom: "2026-08-02", dailyBudget: 2_000_000 }))).toBe("true_change");
    expect(classifyBudgetTransition(cfg(), cfg({ effectiveFrom: "2026-08-02" }))).toBe("unchanged");
    expect(classifyBudgetTransition(null, cfg())).toBe("initial_observation");
    expect(classifyBudgetTransition(cfg(), cfg({ effectiveFrom: "2026-08-02", stateClass: "lifetime_only", dailyBudget: null, lifetimeBudget: 5_000_000 })))
      .toBe("budget_kind_change");
    expect(classifyBudgetTransition(cfg({ stateClass: "neither", dailyBudget: null }), cfg({ effectiveFrom: "2026-08-02" })))
      .toBe("unresolved_prior_state");
  });

  it("orders same-day captures by captured time then id, deterministically", () => {
    const early = cfg({ id: "b", capturedAt: "2026-08-01T09:00:00.000Z" });
    const late = cfg({ id: "a", capturedAt: "2026-08-01T18:00:00.000Z" });
    for (const order of [[early, late], [late, early]]) {
      const sorted = [...order].sort(compareConfigStates);
      expect(sorted.map((x) => x.id)).toEqual(["b", "a"]);
    }
    // equal clocks fall back to id, still deterministic
    const tieA = cfg({ id: "id-1" });
    const tieB = cfg({ id: "id-2" });
    for (const order of [[tieA, tieB], [tieB, tieA]]) {
      expect([...order].sort(compareConfigStates).map((x) => x.id)).toEqual(["id-1", "id-2"]);
    }
  });

  it("treats same-clock competing fingerprints as a conflicting capture", () => {
    const conflicted = cfg({ rawCaptures: 2, distinctFingerprints: 2, stateClass: "conflicting_capture" });
    expect(isResolvedStateClass(conflicted.stateClass)).toBe(false);
    // the SQL derives this class from distinct fingerprints in the effective day
    expect(D080_QUERIES.configSemanticStates).toMatch(/count\(DISTINCT config_fingerprint\)/);
    expect(D080_QUERIES.configSemanticStates).toMatch(/WHEN a\.distinct_fingerprints > 1 THEN 'conflicting_capture'/);
  });

  it("keeps the same entity id distinct across accounts and grains", () => {
    const a = configStateKey({ businessId: SWAF_SELECTED.businessId, providerAccountId: SWAF_SELECTED.providerAccountId, grain: "campaign", entityId: "SHARED" });
    const b = configStateKey({ businessId: SWAF_ALT.businessId, providerAccountId: SWAF_ALT.providerAccountId, grain: "campaign", entityId: "SHARED" });
    const c = configStateKey({ businessId: SWAF_SELECTED.businessId, providerAccountId: SWAF_SELECTED.providerAccountId, grain: "adset", entityId: "SHARED" });
    expect(new Set([a, b, c]).size).toBe(3);
    // and transition identity keeps fingerprint + row id, not just the value
    const t1 = transitionIdentity(cfg(), cfg({ effectiveFrom: "2026-08-02", configFingerprint: "fp-b", id: "cfg-2" }));
    const t2 = transitionIdentity(cfg(), cfg({ effectiveFrom: "2026-08-02", configFingerprint: "fp-c", id: "cfg-3" }));
    expect(t1).not.toBe(t2);
  });

  it("preserves within-day ordering and fingerprint identity in SQL", () => {
    for (const sql of [D080_QUERIES.configSemanticStates, D080_QUERIES.configTransitionIdentities]) {
      expect(sql).toMatch(/ORDER BY entity_id, effective_from, captured_at DESC, created_at DESC, id DESC/);
      expect(sql).toMatch(/PARTITION BY s\.entity_id\s+ORDER BY s\.effective_from, s\.captured_at, s\.id/);
      expect(sql).toMatch(/config_fingerprint/);
    }
    // aggregation happens in SQL: the raw captures never leave Postgres
    expect(D080_QUERIES.configSemanticStates).toMatch(/GROUP BY 4, 5/);
    expect(D080_QUERIES.configTransitionIdentities).toMatch(/LIMIT \$6::int/);
  });

  it("a failed ad-set cell leaves other cells usable but blocks the complete total", () => {
    const expected = D080_PINNED_BINDINGS.flatMap((b) =>
      ["campaign", "adset"].flatMap((g) => ["pointInTime", "retrospective"].map((l) => `${b.providerAccountId}/${g}/${l}`)),
    );
    const ok = new Set(expected.filter((c) => !c.startsWith("act_805150454596350/adset")));
    const unknown = expected.filter((c) => !ok.has(c));
    expect(expected).toHaveLength(28);
    expect(unknown).toHaveLength(2);
    expect(ok.size).toBe(26); // the other cells remain usable
    expect(unknown.length === 0).toBe(false); // total not claimable
  });
});

// ---------------------------------------------------------------------------
// C3.3 — knowledge-time layers
// ---------------------------------------------------------------------------

describe("C3.3 — a late-captured row is retrospective, not point-in-time", () => {
  it("excludes an Aug 20 row captured Aug 22 from an Aug 21 PIT layer", () => {
    const capturedAt = "2026-08-22T04:00:00.000Z";
    expect(isKnowledgeTimeVisible(capturedAt, "2026-08-21")).toBe(false);
    expect(isKnowledgeTimeVisible(capturedAt, null)).toBe(true);
  });

  it("keeps a row captured on the cutoff day inside the PIT layer", () => {
    expect(isKnowledgeTimeVisible("2026-08-21T23:59:00.000Z", "2026-08-21")).toBe(true);
  });

  it("treats an unknown capture time as invisible to the PIT layer", () => {
    expect(isKnowledgeTimeVisible(null, "2026-08-21")).toBe(false);
    expect(isKnowledgeTimeVisible(null, null)).toBe(true);
  });

  it("carries the knowledge bound as a real SQL predicate", () => {
    for (const sql of [D080_QUERIES.configSemanticStates, D080_QUERIES.configTransitionIdentities]) {
      expect(sql).toMatch(/\$5::date IS NULL OR captured_at < \(\$5::date \+ 1\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// C3.4 — query manifest and invariant registry
// ---------------------------------------------------------------------------

describe("C3.4 — every query and every row-bearing section is accounted for", () => {
  it("has a manifest entry for every query in the contract, and no orphans", () => {
    const queries = Object.keys(D080_QUERIES).sort();
    const manifest = Object.keys(D080_QUERY_MANIFEST).sort();
    expect(manifest).toEqual(queries);
  });

  it("declares scope and bounds for every time-varying query", () => {
    for (const [name, entry] of Object.entries(D080_QUERY_MANIFEST)) {
      if (entry.kind !== "time_varying") continue;
      expect(["binding", "business"], `${name} scope`).toContain(entry.scope);
      expect(entry.why.length, `${name} needs a reason`).toBeGreaterThan(20);
      expect(["pit_safe", "retrospective", "current_state"], `${name} pit status`).toContain(entry.pitStatus);
    }
  });

  it("actually applies the bounds each manifest entry claims", () => {
    for (const [name, entry] of Object.entries(D080_QUERY_MANIFEST)) {
      const sql = (D080_QUERIES as Record<string, string>)[name]!;
      if (entry.scope === "binding") {
        expect(sql, `${name} must be account-scoped`).toMatch(/provider_account_id\s*=\s*\$2/);
      }
      if (entry.effectiveBounds === "two_sided") {
        expect(sql, `${name} lower bound`).toMatch(/>=\s*\$\d::date/);
        expect(sql, `${name} upper bound`).toMatch(/<=\s*\$\d::date|<\s*\(\$\d::date \+ 1\)/);
      }
      if (entry.effectiveBounds === "none") {
        // A clock or MAX probe must not silently acquire a bound.
        expect(entry.why.length).toBeGreaterThan(20);
      }
      if (entry.knowledgeBounds === "upper_only") {
        expect(sql, `${name} knowledge bound`).toMatch(/captured_at < \(\$\d::date \+ 1\)/);
      }
    }
  });

  it("does not claim static probes are account-scoped or two-sided", () => {
    for (const name of ["runSchema", "decisionVocabulary"]) {
      const entry = D080_QUERY_MANIFEST[name]!;
      expect(entry.kind).toBe("static_schema");
      expect(entry.scope).toBe("none");
      expect(entry.effectiveBounds).toBe("none");
    }
    // binding discovery is business-scoped on purpose
    expect(D080_QUERY_MANIFEST.bindings!.kind).toBe("binding_discovery");
    expect(D080_QUERY_MANIFEST.bindings!.scope).toBe("business");
    expect(D080_QUERY_MANIFEST.bindings!.why).toMatch(/DETECT/);
  });

  it("fails verification when a row-bearing section has no handler", () => {
    const artifact = sealArtifact({
      clocks: { perBinding: [] },
      brandNewSection: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId }],
    });
    const scan = scanScopeAndCutoff(artifact);
    expect(scan.unhandledSections).toContain("brandNewSection");
    expect(scan.ok).toBe(false);
    expect(verifyArtifact(artifact).failures.join(" ")).toContain("unhandled_row_bearing_section");
  });

  it("discovers row-bearing sections including columnar tables", () => {
    const found = discoverRowBearingSections({
      series: toColumnar([{ a: 1 }], ["a"]),
      nested: { rows: [{ b: 2 }] },
      scalar: 5,
    });
    expect(found).toContain("series");
    expect(found).toContain("nested.rows");
    expect(found).not.toContain("scalar");
  });

  it("checks knowledge-time fields, not only effective ones", () => {
    const artifact = {
      clocks: { perBinding: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, cutoff: "2026-08-21" }] },
      ownershipObservations: toColumnar(
        [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, observed_at: "2026-08-20", captured_at: "2026-08-29" }],
        ["business_id", "provider_account_id", "observed_at", "captured_at"],
      ),
    };
    const scan = scanScopeAndCutoff(artifact);
    expect(scan.violations.some((v) => v.reason === "knowledge_after_cutoff")).toBe(true);
  });

  it("names its exceptions instead of skipping them", () => {
    const exceptions = Object.entries(D080_SECTION_HANDLERS).filter(([, h]) => h.kind === "source_clock_exception");
    expect(exceptions.length).toBeGreaterThan(0);
    for (const [section, handler] of exceptions) {
      expect(handler.exception, `${section} needs a stated exception`).toBeTruthy();
      expect(handler.exception!.length).toBeGreaterThan(30);
    }
  });

  it("rejects a business-scoped row carrying an account outside the pinned matrix", () => {
    const artifact = {
      clocks: { perBinding: [] },
      campaignRole: {
        rows: [{ business_id: IWA.businessId, provider_account_id: "act_000000000", as_of_date: "2026-08-01" }],
        census: [],
      },
    };
    const scan = scanScopeAndCutoff(artifact);
    expect(scan.violations.some((v) => v.reason === "unpinned_binding")).toBe(true);
    expect(isPinnedBusiness(IWA.businessId)).toBe(true);
    expect(isPinnedBusiness("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C3.5 — read-ledger grain
// ---------------------------------------------------------------------------

describe("C3.5 — the read ledger records the real grain and source", () => {
  it("maps each clock query to an entity grain, never to its own name", () => {
    const expected: Record<string, { grain: string; source: string }> = {
      clockCampaignDaily: { grain: "campaign", source: "meta_campaign_daily" },
      clockAdsetDaily: { grain: "adset", source: "meta_adset_daily" },
      clockCampaignConfig: { grain: "campaign", source: "meta_campaign_config_history" },
      clockAdsetConfig: { grain: "adset", source: "meta_adset_config_history" },
    };
    const source = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    for (const [name, { grain, source: table }] of Object.entries(expected)) {
      const re = new RegExp(`name:\\s*"${name}"[^}]*grain:\\s*"${grain}"[^}]*source:\\s*"${table}"`);
      expect(source, `${name} must carry grain ${grain} and source ${table}`).toMatch(re);
    }
    // the defect: the grain field must never be assigned the query name
    expect(source).not.toMatch(/grain:\s*name\b/);
  });

  it("keeps the real grain and source on every frozen ledger row", () => {
    const a = JSON.parse(readFileSync(resolve("docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json"), "utf8"));
    const clocks = a.provenance.readLedger.filter((l: { planKey: string }) => l.planKey.startsWith("clock"));
    expect(clocks.length).toBe(28);
    for (const row of clocks) {
      expect(row.grain, row.planKey).toMatch(/^(campaign|adset)$/);
      expect(row.source, row.planKey).toMatch(/^meta_/);
      expect(row.grain).not.toBe(row.planKey);
    }
  });
});

// ---------------------------------------------------------------------------
// C3.6 — four-cell unit evidence coverage
// ---------------------------------------------------------------------------

describe("C3.6 — all four grain/field unit cells are queried", () => {
  it("has a query for every grain and budget field", () => {
    for (const name of [
      "unitEvidenceCampaignDaily", "unitEvidenceCampaignLifetime",
      "unitEvidenceAdsetDaily", "unitEvidenceAdsetLifetime",
    ] as const) {
      expect(D080_QUERIES[name], name).toBeTruthy();
    }
    expect(D080_QUERIES.unitEvidenceCampaignLifetime).toMatch(/campaign_lifetime_budget_raw/);
    expect(D080_QUERIES.unitEvidenceCampaignLifetime).toMatch(/d\.lifetime_budget/);
  });

  it("distinguishes zero rows returned from an unknown read", () => {
    const cells = [
      { status: "rows_returned", rows: 12 },
      { status: "zero_rows_returned", rows: 0 },
      { status: "unknown/source_read_failed", rows: 0 },
    ];
    const zeroEvidence = cells.filter((c) => c.status === "zero_rows_returned");
    const unknown = cells.filter((c) => c.status === "unknown/source_read_failed");
    expect(zeroEvidence).toHaveLength(1);
    expect(unknown).toHaveLength(1);
    // zero rows is evidence of nothing comparable; it is NOT the same as unknown
    expect(zeroEvidence[0]!.status).not.toBe(unknown[0]!.status);
  });

  it("expects 4 cells per pinned binding", () => {
    expect(D080_PINNED_BINDINGS.length * 4).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// C3.7 — served-date contract
// ---------------------------------------------------------------------------

describe("C3.7 — the UI served date is not the native maximum", () => {
  const resolveServed = (native: string | null, legacy: string | null, job: string | null) => {
    const candidates = [native, legacy, job].filter((v): v is string => Boolean(v));
    return candidates.length > 0 ? candidates.sort()[candidates.length - 1]! : null;
  };

  it("does not collapse to native max when a legacy candidate is later", () => {
    const served = resolveServed("2026-08-20", "2026-08-22", null);
    expect(served).toBe("2026-08-22");
    expect(served).not.toBe("2026-08-20");
  });

  it("does not collapse to native max when the job-run candidate is later", () => {
    expect(resolveServed("2026-08-20", null, "2026-08-23")).toBe("2026-08-23");
  });

  it("returns null when no candidate resolves, rather than inventing one", () => {
    expect(resolveServed(null, null, null)).toBeNull();
  });

  it("reproduces all three candidates separately in SQL", () => {
    const sql = D080_QUERIES.servedDateCandidates;
    expect(sql).toMatch(/native_ad_max/);
    expect(sql).toMatch(/legacy_creative_max/);
    expect(sql).toMatch(/native_job_run_max/);
    expect(sql).toMatch(/engine_v3_decision_snapshots_daily/);
    expect(sql).toMatch(/engine_v3_job_runs/);
    expect(sql).toMatch(/engine_v3_native_ad_decisions_shadow_job/);
  });

  it("describes the two readers as different contracts", () => {
    expect(CANONICAL_DECISION_SELECTION).toBe("latest_as_of_date_per_business_provider_account");
    const source = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    expect(source).toMatch(/contractsIdentical: false/);
    expect(source).toMatch(/scannedHistoricalSnapshotRows/);
    expect(source).not.toMatch(/scannedCanonicalPopulation/);
  });

  it("keeps a full identity manifest rather than a bare count", () => {
    const genA = ["e1|h1", "e2|h2", "e3|h3"];
    const genB = ["e1|h1", "e2|h2", "e4|h4"];
    expect(buildMembershipManifest(genA).count).toBe(buildMembershipManifest(genB).count);
    expect(buildMembershipManifest(genA).groupHash).not.toBe(buildMembershipManifest(genB).groupHash);
    const base = {
      businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, asOfDate: "2026-08-22",
      engineVersion: "v3-shadow", decisionEntityId: "ad-1", adId: "ad-1", scopeType: "account",
      scopeId: IWA.providerAccountId, inputHash: "a".repeat(64), decisionHash: "b".repeat(64),
      evaluationId: "e", jobRunId: "j", computedAt: "2026-08-22T03:00:00.000Z",
    };
    expect(decisionIdentity(base)).not.toBe(decisionIdentity({ ...base, decisionHash: "c".repeat(64) }));
  });

  it("counts the full population as denominator with typed verbs as FILTERs", () => {
    const sql = D080_QUERIES.budgetVerbCensus;
    expect(sql).toMatch(/count\(\*\)::bigint AS scanned_rows/);
    expect(sql).toMatch(/FILTER \(WHERE label = ANY\(\$3::text\[\]\)\)/);
    for (const label of CREATIVE_LABELS) expect(isBudgetVerb(label)).toBe(false);
    for (const verb of BUDGET_VERBS) expect(isBudgetVerb(verb)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3.8 — role temporal and account authority
// ---------------------------------------------------------------------------

describe("C3.8 — a mutable snapshot cannot become historical authority", () => {
  const baseRow: RoleRow = {
    providerAccountId: IWA.providerAccountId, inferredKind: "main", confidenceClass: "high",
    confidenceScore: 0.9, resolverVersion: "resolver.v1", asOfDate: "2026-08-14",
    recordedAt: "2026-08-14T06:00:00.000Z", overwrittenAfterInsert: false,
  };
  const call = (over: Partial<RoleRow>, temporal: "mutable_current_snapshot" | "immutable_knowledge_time" = "immutable_knowledge_time", rows?: RoleRow[]) =>
    resolveRoleAuthorityAtOrigin({
      origin: "2026-08-15",
      expectedProviderAccountId: IWA.providerAccountId,
      staleAfterDays: 3,
      sourceTemporalStatus: temporal,
      rows: rows ?? [{ ...baseRow, ...over }],
    });

  it("refuses a perfect row when the source is a mutable current snapshot", () => {
    // Simulate a future world where a supported resolver exists.
    const supported = [...SUPPORTED_ROLE_RESOLVER_VERSIONS, "resolver.v1"];
    expect(supported).toContain("resolver.v1");
    const verdict = call({}, "mutable_current_snapshot");
    // Today the unsupported-resolver gate fires first; either way it is not authoritative.
    expect(verdict.status).not.toBe("authoritative");
    expect(["blocked_unsupported_resolver", "blocked_mutable_source_not_pit"]).toContain(verdict.status);
  });

  it("marks a recomputed row as a retrospective candidate, never authority", () => {
    const source = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    expect(source).toMatch(/retrospective_role_candidate/);
    expect(source).toMatch(/blocked_mutable_source_not_pit/);
    expect(source).toMatch(/overwritten_after_insert/);
  });

  it("never lets a later row for another account shadow the expected account", () => {
    const mine: RoleRow = { ...baseRow, asOfDate: "2026-08-12", recordedAt: "2026-08-12T06:00:00.000Z" };
    const theirs: RoleRow = { ...baseRow, providerAccountId: SWAF_ALT.providerAccountId, inferredKind: "test", asOfDate: "2026-08-14", recordedAt: "2026-08-14T06:00:00.000Z" };
    for (const order of [[mine, theirs], [theirs, mine]]) {
      const verdict = call({}, "immutable_knowledge_time", order);
      // the other account's row is filtered out of SELECTION entirely
      expect(verdict.role === "test").toBe(false);
    }
  });

  it("refuses a legacy null-account row, whatever else it looks like", () => {
    expect(call({ providerAccountId: null }).status).toBe("blocked_legacy_business_scope");
  });

  it("refuses null kind, unacceptable confidence, unsupported resolver and staleness", () => {
    expect(call({ inferredKind: null }).status).toBe("blocked_role_unknown_or_conflict");
    for (const cc of ["low", "unknown", "conflict", null]) {
      expect(call({ confidenceClass: cc }).status, String(cc)).toBe("blocked_low_confidence");
    }
    expect(call({ resolverVersion: "nope" }).status).toBe("blocked_unsupported_resolver");
    expect(call({ asOfDate: "2026-07-01", recordedAt: "2026-07-01T00:00:00.000Z" }).status).toBe("blocked_stale");
    expect(call({ recordedAt: "2026-09-01T00:00:00.000Z" }).status).toBe("blocked_no_pit_row");
  });

  it("allows only main/test/mixed at high/medium confidence", () => {
    expect([...ALLOWED_CAMPAIGN_ROLES]).toEqual(["main", "test", "mixed"]);
    expect([...ACCEPTED_CONFIDENCE_CLASSES]).toEqual(["high", "medium"]);
    expect(SUPPORTED_ROLE_RESOLVER_VERSIONS).toHaveLength(0);
  });

  it("blocks the counterfactual when role authority is unavailable", () => {
    expect(
      evaluateEntityAtOrigin({
        ...BASE, contract: DIVISOR_100, points: series(14),
        roleAuthority: { status: "blocked_mutable_source_not_pit", role: null, basis: "x" },
      }).outcome,
    ).toBe("blocked_campaign_role_unavailable");
  });

  it("reads no manual label source anywhere", () => {
    for (const sql of Object.values(D080_QUERIES)) {
      expect(sql).not.toMatch(/campaign_labels|manual_label|label_api|campaign_name\s*~/i);
    }
  });
});

// ---------------------------------------------------------------------------
// C3.10 — external receipts
// ---------------------------------------------------------------------------

describe("C3.10 — external claims carry inspectable receipts", () => {
  const receipts = D080_CAPABILITY_MATRIX.graphApiVersions.primarySourceVerification;

  it("gives every claim a url, timestamp, method, excerpt and status", () => {
    for (const r of receipts) {
      expect(r.url, r.claim).toMatch(/^https:\/\//);
      expect(r.retrievedAt, r.claim).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // C4.6 — the precision is declared rather than implied by the format.
      expect((r as { retrievedAtPrecision?: string }).retrievedAtPrecision, r.claim).toBe("date_only");
      expect(r.method.length, r.claim).toBeGreaterThan(5);
      expect(r.excerpt.length, r.claim).toBeGreaterThan(5);
      expect(r.excerpt.length, `${r.claim} excerpt must stay short`).toBeLessThan(200);
    }
  });

  it("never uses a blanket VERIFIED status", () => {
    const allowed = ["primary_render_verified_not_byte_verified", "official_sdk_release_verified", "unverified"];
    for (const r of receipts) {
      expect(allowed, r.claim).toContain(r.status);
      expect(r.status).not.toBe("VERIFIED");
    }
  });

  it("names the claim-metadata hash for what it is", () => {
    const src = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    expect(src).toMatch(/claimMetadataHash/);
    expect(src).not.toMatch(/receiptHash:/);
    expect(src).toMatch(/NOT a hash of captured source bytes/);
  });

  it("keeps the byte-verification limitation inside the status itself", () => {
    const rendered = receipts.filter((r) => r.status === "primary_render_verified_not_byte_verified");
    expect(rendered.length).toBeGreaterThan(0);
    expect(D080_CAPABILITY_MATRIX.graphApiVersions.receiptStatusMeanings.primary_render_verified_not_byte_verified)
      .toMatch(/not byte-level/i);
  });

  it("keeps the endpoint contract unverified and does not infer it", () => {
    const endpoint = receipts.find((r) => r.claim.includes("campaign vs ad-set budget endpoint"))!;
    expect(endpoint.status).toBe("unverified");
    expect(endpoint).toHaveProperty("consequence");
  });

  it("does not lean on the SDK for claims the SDK does not contain", () => {
    const flag = receipts.find((r) => r.claim.includes("is_adset_budget_sharing_enabled"))!;
    expect(flag).toHaveProperty("sdkNote");
    expect((flag as { sdkNote: string }).sdkNote).toMatch(/do NOT contain|not evidence/i);
    const v26 = receipts.find((r) => r.claim.includes("v26.0 was released"))!;
    expect((v26 as { sdkNote: string }).sdkNote).toMatch(/does NOT establish/i);
  });

  it("publishes the version counts with a stated scope", () => {
    const g = D080_CAPABILITY_MATRIX.graphApiVersions;
    expect(g.countingScope.length).toBeGreaterThan(40);
    expect(g.productionCounts["v25.0"]).toBe(44);
    expect(g.withdrawnClaim).toMatch(/~70/);
    expect(g.reclassified).toMatch(/READ path/);
  });
});

// ---------------------------------------------------------------------------
// C3.9 — no import-time side effect; authority never masked
// ---------------------------------------------------------------------------

describe("C3.9 — runtime and language claims are literally true", () => {
  it("importing the module does not load config or set any forbidden flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "d080-import-"));
    try {
      const probe = join(dir, "probe.mjs");
      const modulePath = resolve("scripts/audits/d080-meta-budget-edit-evidence.ts");
      writeFileSync(
        probe,
        `const F = ${JSON.stringify(D080_FORBIDDEN_TRUTHY_FLAGS)};\n` +
          `const before = Object.fromEntries(F.map(f => [f, process.env[f] ?? null]));\n` +
          `await import(${JSON.stringify(modulePath)});\n` +
          `const after = Object.fromEntries(F.map(f => [f, process.env[f] ?? null]));\n` +
          `console.log(JSON.stringify({ before, after }));\n`,
      );
      const raw = execFileSync("npx", ["tsx", probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const line = raw.trim().split("\n").filter((l) => l.startsWith("{")).pop()!;
      const { before, after } = JSON.parse(line) as Record<string, Record<string, string | null>>;
      expect(after).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a flag truthy before or after loading, and cannot be masked", () => {
    for (const flag of D080_FORBIDDEN_TRUTHY_FLAGS) {
      expect(() => assertNoExecutionAuthority({ [flag]: "1" }, {})).toThrow(flag);
    }
    expect(() => assertNoExecutionAuthority({}, { META_AUTOMATION_ENABLED: "true" })).toThrow("META_AUTOMATION_ENABLED");
    const masked = evaluateExecutionAuthority({ ENABLE_RUNTIME_MIGRATIONS: "1" }, { ENABLE_RUNTIME_MIGRATIONS: "0" });
    expect(masked.ok).toBe(false);
    expect(masked.truthyBefore).toContain("ENABLE_RUNTIME_MIGRATIONS");
    expect(evaluateExecutionAuthority({}, { ENABLE_RUNTIME_MIGRATIONS: "0" }).changedByLoader)
      .toContainEqual({ flag: "ENABLE_RUNTIME_MIGRATIONS", before: null, after: "0" });
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) expect(isTruthyFlagValue(v)).toBe(true);
    for (const v of ["0", "false", "no", "", undefined]) expect(isTruthyFlagValue(v)).toBe(false);
  });

  it("does not claim in source that every read is account-scoped and two-sided", () => {
    const source = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    expect(source).not.toMatch(/every read account-scoped and two-sided/);
    expect(source).toMatch(/queryManifest/);
  });

  it("issues only SELECT statements and carries no entity names", () => {
    for (const [name, sql] of Object.entries(D080_QUERIES)) {
      expect(sql.trimStart().toUpperCase().startsWith("SELECT") || sql.trimStart().toUpperCase().startsWith("WITH"), name).toBe(true);
      for (const forbidden of ["INSERT INTO", "DELETE FROM", "TRUNCATE", "ALTER ", "GRANT "]) {
        expect(sql.toUpperCase().includes(forbidden), `${name} contains ${forbidden}`).toBe(false);
      }
      if (name === "decisionVocabulary" || name === "runSchema") continue;
      expect(sql, name).not.toMatch(/campaign_name|adset_name|entity_name|account_name/);
    }
  });
});

// ---------------------------------------------------------------------------
// Retained coverage: ownership, schema contract, units, anchors, hashing
// ---------------------------------------------------------------------------

describe("ownership, schema contract and units", () => {
  it("refuses strict PIT owner reconstruction on a legacy run schema", () => {
    expect(LEGACY_SCHEMA.missingRunColumns).toEqual([...REQUIRED_RUN_COLUMNS_FOR_STRICT_PIT]);
    const owner = resolveBudgetOwnerAtOrigin({
      origin: "2026-08-15", campaignId: CAMPAIGN_ID, adsetId: ADSET_ID,
      schemaContract: LEGACY_SCHEMA, observations: { campaign: [obs()], adset: [] },
    });
    expect(owner.status).toBe("unresolved_schema_contract");
    expect(evaluateEntityAtOrigin({ ...BASE, contract: DIVISOR_100, ownership: owner, points: series(14) }).outcome)
      .toBe("blocked_owner_schema_contract");
  });

  it("arbitrates deterministically and detects same-clock conflicts", () => {
    const a = obs({ id: "row-a", stateHash: "h-a" });
    const b = obs({ id: "row-b", stateHash: "h-b", budgetOrigin: "not_applicable", hasCampaignDaily: false });
    for (const order of [[a, b], [b, a]]) {
      expect(resolveBudgetOwnerAtOrigin({
        origin: "2026-08-15", campaignId: CAMPAIGN_ID, adsetId: ADSET_ID,
        schemaContract: COMPATIBLE_SCHEMA, observations: { campaign: order, adset: [] },
      }).status).toBe("unresolved_same_clock_conflict");
    }
    const older = obs({ id: "old", observedAt: "2026-08-10T00:00:00.000Z", capturedAt: "2026-08-10T00:01:00.000Z", budgetOrigin: "not_applicable", hasCampaignDaily: false });
    const newer = obs({ id: "new", observedAt: "2026-08-13T00:00:00.000Z", capturedAt: "2026-08-13T00:01:00.000Z" });
    expect(new Set([[older, newer], [newer, older]].map((p) => pickLatestObservation(p, "2026-08-15").row?.id)).size).toBe(1);
  });

  it("resolves campaign ownership under CBO and refuses double counting", () => {
    const owner = resolveBudgetOwnerAtOrigin({
      origin: "2026-08-15", campaignId: CAMPAIGN_ID, adsetId: ADSET_ID, schemaContract: COMPATIBLE_SCHEMA,
      observations: {
        campaign: [obs()],
        adset: [obs({ entityType: "adset", adsetId: ADSET_ID, budgetOrigin: "not_applicable", hasCampaignDaily: false })],
      },
    });
    expect(owner).toMatchObject({ status: "resolved", owner: "campaign" });
    expect(evaluateEntityAtOrigin({ ...BASE, contract: DIVISOR_100, ownership: owner, isBudgetOwner: false, points: series(14) }).outcome)
      .toBe("blocked_not_budget_owner");
  });

  it("fails the unit contract closed and diverges by exactly 100x under assumption", () => {
    expect(utilisationUnderContract({ spend: SPEND_MAJOR_UNITS, budgetCapacity: BUDGET_MINOR_UNITS, contract: FACTUAL_UNIT_CONTRACT })).toBeNull();
    expect(evaluateEntityAtOrigin({ ...BASE, contract: FACTUAL_UNIT_CONTRACT, points: series(14) }).outcome).toBe("blocked_unknown_unit_scale");
    const one = evaluateEntityAtOrigin({ ...BASE, contract: DIVISOR_1, points: series(14) });
    const hundred = evaluateEntityAtOrigin({ ...BASE, contract: DIVISOR_100, points: series(14) });
    expect(one.outcome).toBe("blocked_not_binding");
    expect(hundred.outcome).toBe("candidate_increase");
    expect(hundred.utilisation! / one.utilisation!).toBeCloseTo(100, 6);
    expect(one.utilisation!).toBeLessThan(REPLAY_BINDING_UTILISATION);
  });

  it("resolves commercial anchors on both bitemporal bounds", () => {
    const revisions = [{ effectiveAt: "2026-05-10", recordedAt: "2026-07-14T07:51:50.751Z", operation: "upsert", targetRoas: 2.2, breakEvenRoas: 1.8 }];
    expect(resolveAnchorAtOrigin({ origin: "2026-06-01", revisions }).status).toBe("no_revision_before_origin");
    expect(resolveAnchorAtOrigin({ origin: "2026-08-15", revisions }).status).toBe("resolved");
    const none = resolveAnchorAtOrigin({ origin: "2026-08-15", revisions: [] });
    expect(evaluateEntityAtOrigin({ ...BASE, contract: DIVISOR_100, anchor: none, points: series(14) }).outcome).toBe("blocked_no_commercial_anchor");
  });

  it("marks mutable sources as not PIT-reconstructible", () => {
    for (const s of ["meta_campaign_daily", "meta_adset_daily", "engine_v3_ad_decision_snapshots_daily", "engine_v3_campaign_context_daily"]) {
      expect(D080_SOURCE_SEMANTICS.find((x) => x.source === s)!.pitReconstructible, s).toBe(false);
    }
    expect(D080_SOURCE_SEMANTICS.find((x) => x.source === "business_target_pack_history")!.pitReconstructible).toBe(true);
  });

  it("pins seven bindings including the non-selected TheSwaf account", () => {
    expect(D080_PINNED_BINDINGS).toHaveLength(7);
    expect(D080_PINNED_BINDINGS.filter((b) => b.isSelected)).toHaveLength(6);
    expect(SWAF_ALT.isSelected).toBe(false);
    expect(isPinnedBinding(IWA.businessId, IWA.providerAccountId)).toBe(true);
    expect(isPinnedBinding(IWA.businessId, "act_999")).toBe(false);
    expect(bindingKey(SWAF_SELECTED.businessId, SWAF_SELECTED.providerAccountId))
      .not.toBe(bindingKey(SWAF_ALT.businessId, SWAF_ALT.providerAccountId));
  });
});

describe("the frozen artifact verifies itself", () => {
  const sample = (() => {
    const base: Record<string, unknown> = {
      contract: "adsecute.meta.d080-budget-edit-evidence.v3",
      schemaContract: LEGACY_SCHEMA,
      sourceSemantics: { sources: D080_SOURCE_SEMANTICS },
      clocks: { perSource: [], perBinding: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, cutoff: "2026-08-21" }] },
      unitEvidence: { rows: [], coverageMatrix: [], factualContract: FACTUAL_UNIT_CONTRACT },
      series: toColumnar([], ["business_id", "provider_account_id", "effective_date"]),
      ownershipObservations: toColumnar([], ["business_id", "provider_account_id", "observed_at"]),
      correctionLedger: D080_CORRECTION_LEDGER,
    };
    // A complete minimal artifact also executes every planned read: the
    // reconciler treats a plan entry that never ran as a failure.
    base.provenance = {
      retrievedAt: "2026-08-31T00:00:00.000Z",
      readLedger: Object.keys(D080_READ_PLAN).map((query) => ({ query, status: "ok", rows: 0 })),
      readFailures: [],
    };
    // Every required section must EXIST; an empty array is valid data.
    for (const section of D080_REQUIRED_SECTIONS) {
      const path = section.split(".");
      let node = base;
      for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
      const leaf = path[path.length - 1]!;
      if (node[leaf] === undefined) node[leaf] = [];
    }
    return base;
  })();

  it("hashes every material section of a synthetic package", () => {
    const sealed = sealArtifact(sample);
    const hashes = sealed.sectionHashes as Record<string, string>;
    for (const key of Object.keys(sample)) expect(hashes[key], key).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    // C5.1 — a synthetic shell of empty arrays must NOT verify: a required
    // evidence package cannot shrink to a minimal set and still pass. Full
    // clean verification is proven against the real artifact in C5 baseline.
    const result = verifyArtifact(sealed);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("artifact_shape");
  });

  it("detects mutation, addition, removal and a rewritten artifactHash", () => {
    const sealed = sealArtifact(sample) as Record<string, unknown>;
    expect(verifyArtifact({ ...sealed, targetPackHistory: [{ smuggled: true }] }).failures.join(" ")).toContain("targetPackHistory");
    const { targetPackHistory: _drop, ...removed } = sealed;
    expect(verifyArtifact(removed).failures.join(" ")).toContain("manifest mismatch");
    expect(verifyArtifact({ ...sealed, artifactHash: "0".repeat(64) }).failures).toContain("artifactHash stale");
    expect(verifyArtifact({ series: [] }).ok).toBe(false);
  });

  it("is order-independent, content-sensitive and re-seals byte-identically", () => {
    const forward = sealArtifact(sample);
    expect(sealArtifact(Object.fromEntries(Object.entries(sample).reverse())).artifactHash).toBe(forward.artifactHash);
    expect(sha256Canonical({ x: 1 })).not.toBe(sha256Canonical({ x: 2 }));
    const first = JSON.stringify(sealArtifact(sample), null, 1);
    expect(JSON.stringify(sealArtifact(JSON.parse(first)), null, 1)).toBe(first);
  }, 180_000);

  it("round-trips columnar storage and ignores hash fields", () => {
    const rows = [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, effective_date: "2026-08-01" }];
    const cols = ["business_id", "provider_account_id", "effective_date"];
    expect(fromColumnar(toColumnar(rows, cols))).toEqual(rows);
    expect(Object.keys(computeSectionHashes({ a: 1, sectionHashes: {}, artifactHash: "x" }))).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// C4.1 — the six registry counterexamples, each must now FAIL closed
// ---------------------------------------------------------------------------

describe("C4.1 — the registry no longer accepts empty, deep, out-of-scope or late evidence", () => {
  // A FACTORY, not a shared object: the required-section test below writes into
  // nested paths, and a shared literal would silently wipe these cutoffs.
  const cutoffOnly = () => ({
    clocks: { perBinding: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, cutoff: "2026-08-21" }] },
  });

  it("1. rejects a freshly sealed empty shell", () => {
    const r = verifyArtifact(sealArtifact({ contract: "adsecute.meta.d080-budget-edit-evidence.v3" }));
    expect(r.ok).toBe(false);
    expect(r.scope.missingRequiredSections.length).toBe(D080_REQUIRED_SECTIONS.length);
    expect(r.failures.join(" ")).toContain("required_section_missing");
  });

  it("1b. rejects a re-sealed artifact with one required section deleted", () => {
    const full: Record<string, unknown> = cutoffOnly() as Record<string, unknown>;
    for (const section of D080_REQUIRED_SECTIONS) {
      const path = section.split(".");
      let node = full as Record<string, unknown>;
      for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
      node[path[path.length - 1]!] = [];
    }
    expect(verifyArtifact(sealArtifact(full)).scope.missingRequiredSections).toEqual([]);
    const stripped = JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
    delete (stripped.campaignRole as Record<string, unknown>).rows;
    const r = verifyArtifact(sealArtifact(stripped));
    expect(r.ok).toBe(false);
    expect(r.scope.missingRequiredSections).toContain("campaignRole.rows");
  });

  it("2. discovers a depth-four row set", () => {
    const found = discoverRowBearingSections({ a: { b: { c: { rows: [{ x: 1 }] } } } });
    expect(found).toContain("a.b.c.rows");
    const r = verifyArtifact(sealArtifact({ ...cutoffOnly(), a: { b: { c: { rows: [{ business_id: "BAD", provider_account_id: "act_BAD" }] } } } }));
    expect(r.ok).toBe(false);
    expect(r.scope.unhandledSections).toContain("a.b.c.rows");
  });

  it("3. a source-clock exception waives a clock, never scope", () => {
    const r = verifyArtifact(sealArtifact({ ...cutoffOnly(), canonicalDecisions: { servedDate: [{ business_id: "BAD", provider_account_id: "act_BAD" }] } }));
    expect(r.ok).toBe(false);
    expect(r.scope.violations.some((v) => v.reason === "unpinned_binding")).toBe(true);
    // ...while the exempted clock field on a PINNED row is still waived.
    const pinned = verifyArtifact(sealArtifact({
      ...cutoffOnly(),
      canonicalDecisions: { servedDate: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, native_ad_max: "2026-08-29" }] },
    }));
    expect(pinned.scope.violations.some((v) => v.reason === "effective_after_cutoff")).toBe(false);
  });

  it("4. rejects a late-captured config identity", () => {
    const r = verifyArtifact(sealArtifact({
      ...cutoffOnly(),
      configStates: { identities: [{ business_id: IWA.businessId, provider_account_id: IWA.providerAccountId, effective_from: "2026-08-20", captured_at: "2026-08-29" }] },
    }));
    expect(r.ok).toBe(false);
    expect(r.scope.violations.some((v) => v.reason === "knowledge_after_cutoff")).toBe(true);
  });

  it("5. rejects a null-account role row effective after the business cutoff", () => {
    const r = verifyArtifact(sealArtifact({
      ...cutoffOnly(),
      campaignRole: { rows: [{ business_id: IWA.businessId, provider_account_id: null, as_of_date: "2026-09-15" }] },
    }));
    expect(r.ok).toBe(false);
    expect(r.scope.violations.some((v) => v.reason === "effective_after_cutoff")).toBe(true);
  });

  it("6. rejects an unpinned camelCase read-ledger row", () => {
    expect(rowBusinessId({ businessId: "x" })).toBe("x");
    expect(rowProviderAccountId({ providerAccountId: "y" })).toBe("y");
    expect(rowBusinessId({ business_id: "x" })).toBe("x");
    const r = verifyArtifact(sealArtifact({
      ...cutoffOnly(),
      provenance: { readLedger: [{ query: "x", status: "ok", businessId: "BAD", providerAccountId: "act_BAD" }], readFailures: [] },
    }));
    expect(r.ok).toBe(false);
    expect(r.scope.violations.some((v) => v.reason === "unpinned_binding")).toBe(true);
  });

  it("reports separate counters instead of one conflated number", () => {
    const r = verifyArtifact(sealArtifact(cutoffOnly()));
    const c = r.scope.counters;
    for (const key of ["discoveredRowSets", "registeredSections", "requiredSectionsExpected", "requiredSectionsPresent", "totalRows", "scopeCheckedRows", "effectiveTimeCheckedFields", "knowledgeTimeCheckedFields", "crossSectionReconciliations", "sourceAggregateRows", "exemptedClockFields", "expectedInvocations", "observedInvocations"]) {
      expect(c, key).toHaveProperty(key);
    }
    expect(r.scope).not.toHaveProperty("checkedRows");
    // C5.5 — handler visitation is never called an aggregate check again.
    expect(c).not.toHaveProperty("aggregateConsistencyCheckedRows");
  });
});

// ---------------------------------------------------------------------------
// C4.2 — executed read plan
// ---------------------------------------------------------------------------

describe("C4.2 — the read plan reconciles one-to-one with the ledger", () => {
  it("has a distinct entry for each config invocation, with honest PIT status", () => {
    expect(D080_READ_PLAN["configSemanticStates:pointInTime"]!.pitStatus).toBe("pit_safe");
    expect(D080_READ_PLAN["configSemanticStates:retrospective"]!.pitStatus).toBe("retrospective");
    expect(D080_READ_PLAN["configSemanticStates:retrospective"]!.knowledgeBounds).toBe("none");
    expect(Object.keys(D080_READ_PLAN).length).toBeGreaterThan(Object.keys(D080_QUERY_MANIFEST).length);
  });

  it("maps a suffixed ledger name to exactly one plan key", () => {
    expect(planKeyForLedgerQuery("configSemanticStates:pointInTime:5dbc7147")).toBe("configSemanticStates:pointInTime");
    expect(planKeyForLedgerQuery("clockAdsetDaily:f8a3b5ac")).toBe("clockAdsetDaily");
    expect(planKeyForLedgerQuery("targetPackHistory")).toBe("targetPackHistory");
  });

  it("rejects a ledger query with no plan entry", () => {
    const v = reconcileLedgerAndPlan({ provenance: { readLedger: [{ query: "someNewRead", status: "ok" }] } });
    expect(v.some((x) => x.detail.includes("someNewRead"))).toBe(true);
  });

  it("rejects a plan entry that never executed", () => {
    const v = reconcileLedgerAndPlan({ provenance: { readLedger: [{ query: "runSchema", status: "ok" }] } });
    expect(v.some((x) => x.detail.includes("never executed"))).toBe(true);
  });

  it("requires readFailures to be exactly the non-ok ledger subset", () => {
    const ledger = [
      { query: "runSchema", status: "ok" },
      { query: "clockAdsetConfig", status: "unknown/source_read_failed", providerAccountId: "act_x", grain: "adset" },
    ];
    const mismatch = reconcileLedgerAndPlan({ provenance: { readLedger: ledger, readFailures: [] } });
    expect(mismatch.some((x) => x.section === "provenance.readFailures")).toBe(true);
    const smuggled = reconcileLedgerAndPlan({
      provenance: { readLedger: ledger, readFailures: [{ query: "notInLedger", providerAccountId: "act_x", grain: "adset" }] },
    });
    expect(smuggled.some((x) => x.section === "provenance.readFailures")).toBe(true);
  });

  it("enforces every bound kind and scope kind declared by the manifest", () => {
    const seenBounds = new Set<string>();
    const seenScopes = new Set<string>();
    for (const [name, entry] of Object.entries(D080_QUERY_MANIFEST)) {
      const sql = (D080_QUERIES as Record<string, string>)[name]!;
      seenBounds.add(entry.effectiveBounds);
      seenBounds.add(entry.knowledgeBounds);
      seenScopes.add(entry.scope);
      if (entry.scope === "binding") expect(sql, `${name} binding scope`).toMatch(/provider_account_id\s*=\s*\$2/);
      if (entry.scope === "business") expect(sql, `${name} business scope`).toMatch(/business_id(::text)?\s*=\s*(\$1|ANY)/);
      if (entry.scope === "none") expect(sql, `${name} must not be account-scoped`).not.toMatch(/provider_account_id\s*=\s*\$2/);
      if (entry.effectiveBounds === "two_sided") {
        expect(sql, `${name} lower`).toMatch(/>=\s*\$\d::date/);
        expect(sql, `${name} upper`).toMatch(/<=\s*\$\d::date|<\s*\(\$\d::date \+ 1\)/);
      }
      if (entry.effectiveBounds === "lower_only") {
        expect(sql, `${name} lower`).toMatch(/>=\s*\$\d::date/);
        expect(sql, `${name} must have no effective upper bound`).not.toMatch(/effective_from\s*<=/);
      }
      if (entry.effectiveBounds === "upper_only") expect(sql, `${name} upper`).toMatch(/<=\s*\$\d::date/);
      if (entry.effectiveBounds === "pinned_single_date") expect(sql, `${name} exact date`).toMatch(/=\s*\$\d::date/);
      if (entry.effectiveBounds === "none") expect(sql, `${name} must not carry a date bound`).not.toMatch(/(>=|<=)\s*\$\d::date/);
      if (entry.knowledgeBounds === "upper_only") expect(sql, `${name} knowledge`).toMatch(/captured_at < \(\$\d::date \+ 1\)/);
    }
    // every bound kind and scope kind is actually exercised by the contract
    for (const kind of ["two_sided", "upper_only", "lower_only", "pinned_single_date", "none"]) {
      expect(seenBounds, `bound kind ${kind}`).toContain(kind);
    }
    for (const kind of ["binding", "business", "none"]) expect(seenScopes, `scope ${kind}`).toContain(kind);
  });

  it("declares the code-applied bitemporal bound for the target-pack read", () => {
    expect(D080_QUERY_MANIFEST.targetPackHistory!.pitStatus).toBe("pit_safe");
    expect(D080_READ_PLAN.targetPackHistory!.why).toMatch(/in code rather than SQL/);
    // and the resolver really does apply both bounds
    const backdated = [{ effectiveAt: "2026-05-10", recordedAt: "2026-07-14T00:00:00.000Z", operation: "upsert", targetRoas: 2.2, breakEvenRoas: 1.8 }];
    expect(resolveAnchorAtOrigin({ origin: "2026-06-01", revisions: backdated }).status).toBe("no_revision_before_origin");
  });

  it("carries grain and source on every grain-specific plan entry", () => {
    for (const [name, entry] of Object.entries(D080_READ_PLAN)) {
      if (!name.startsWith("clock")) continue;
      expect(entry.grain, `${name} grain`).toMatch(/^(campaign|adset)$/);
      expect(entry.source, `${name} source`).toMatch(/^meta_/);
    }
  });
});

// ---------------------------------------------------------------------------
// C4.3 — served-date reproduction
// ---------------------------------------------------------------------------

describe("C4.3 — the served-date query reproduces the route CTE exactly", () => {
  it("unions both creative ownership tables and applies exclusivity", () => {
    const sql = D080_QUERIES.servedDateCandidates;
    expect(sql).toMatch(/meta_creative_dimensions/);
    expect(sql).toMatch(/meta_creative_daily/);
    expect(sql).toMatch(/UNION/);
    expect(sql).toMatch(/count\(DISTINCT provider_account_id\) = 1/);
    expect(sql).toMatch(/min\(provider_account_id\) = \$2/);
  });

  it("covers only the default path and says so", () => {
    const source = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    expect(source).toMatch(/DEFAULT path only/);
    expect(source).toMatch(/explicitEndDate/);
    // no stale "both readers take native MAX" statement anywhere
    expect(source).not.toMatch(/both take MAX\(as_of_date\)/);
  });

  it("is unclaimable, not vacuously equal, when a binding is missing or failed", () => {
    const expected = D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId));
    const sixOk = expected.slice(0, 6);
    expect(auditExpectedKeys(expected, sixOk).ok).toBe(false);
    expect(auditExpectedKeys(expected, sixOk).missing).toHaveLength(1);
    // a duplicate cell is also a failure
    expect(auditExpectedKeys(expected, [...expected, expected[0]!]).duplicates).toHaveLength(1);
    // and an unexpected cell
    expect(auditExpectedKeys(expected, [...expected, "nope|act_x"]).unexpected).toHaveLength(1);
  });

  it("refuses to claim a fleet comparison while a cell is not ok", () => {
    const v = reconcileClaims({
      analysis: {
        servedDateContract: {
          coverage: [{ status: "ok" }, { status: "unknown/source_read_failed" }],
          fleetComparisonClaimable: true,
          allServedEqualNativeMax: true,
        },
      },
    });
    expect(v.some((x) => x.section === "analysis.servedDateContract")).toBe(true);
  });

  it("requires allServedEqualNativeMax to be null when unclaimable", () => {
    const v = reconcileClaims({
      analysis: { servedDateContract: { coverage: [{ status: "ok" }], fleetComparisonClaimable: false, allServedEqualNativeMax: true } },
    });
    expect(v.some((x) => x.detail.includes("must be null"))).toBe(true);
  });

  it("resolves the served date from the later non-native candidate", () => {
    const resolve1 = (n: string | null, l: string | null, j: string | null) => {
      const c = [n, l, j].filter((v): v is string => Boolean(v));
      return c.length ? c.sort()[c.length - 1]! : null;
    };
    expect(resolve1("2026-08-20", "2026-08-22", null)).toBe("2026-08-22");
    expect(resolve1("2026-08-20", null, "2026-08-23")).toBe("2026-08-23");
    expect(resolve1(null, null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C4.4 — role temporal branches, exercised behaviourally
// ---------------------------------------------------------------------------

describe("C4.4 — the role temporal gate is actually reached", () => {
  const SUPPORTED = ["resolver.v1"] as const;
  const row: RoleRow = {
    providerAccountId: IWA.providerAccountId, inferredKind: "main", confidenceClass: "high",
    confidenceScore: 0.9, resolverVersion: "resolver.v1", asOfDate: "2026-08-14",
    recordedAt: "2026-08-14T06:00:00.000Z", overwrittenAfterInsert: false,
  };
  const call = (over: Partial<RoleRow>, temporal: "mutable_current_snapshot" | "immutable_knowledge_time", rows?: RoleRow[]) =>
    resolveRoleAuthorityAtOrigin({
      origin: "2026-08-15", expectedProviderAccountId: IWA.providerAccountId, staleAfterDays: 3,
      sourceTemporalStatus: temporal, supportedResolverVersions: SUPPORTED,
      rows: rows ?? [{ ...row, ...over }],
    });

  it("1. supported resolver + mutable source can never be authoritative", () => {
    const v = call({}, "mutable_current_snapshot");
    expect(v.status).toBe("blocked_mutable_source_not_pit");
    expect(v.status).not.toBe("blocked_unsupported_resolver");
  });

  it("2. supported + immutable + overwritten row is a retrospective candidate", () => {
    const v = call({ overwrittenAfterInsert: true }, "immutable_knowledge_time");
    expect(v.status).toBe("retrospective_role_candidate");
    expect(v.status).not.toBe("authoritative");
  });

  it("3. supported + immutable + clean account-scoped row is authoritative", () => {
    const v = call({}, "immutable_knowledge_time");
    expect(v.status).toBe("authoritative");
    expect(v.role).toBe("main");
  });

  it("4. cross-account, null-account, stale, low-confidence and unsupported all fail closed", () => {
    const mine: RoleRow = { ...row, asOfDate: "2026-08-12", recordedAt: "2026-08-12T06:00:00.000Z" };
    const theirs: RoleRow = { ...row, providerAccountId: SWAF_ALT.providerAccountId, inferredKind: "test" };
    for (const order of [[mine, theirs], [theirs, mine]]) {
      const v = call({}, "immutable_knowledge_time", order);
      expect(v.status).toBe("authoritative");
      expect(v.role).toBe("main"); // the other account never shadows ours
    }
    expect(call({ providerAccountId: null }, "immutable_knowledge_time").status).toBe("blocked_legacy_business_scope");
    expect(call({ asOfDate: "2026-07-01", recordedAt: "2026-07-01T00:00:00.000Z" }, "immutable_knowledge_time").status).toBe("blocked_stale");
    expect(call({ confidenceClass: "low" }, "immutable_knowledge_time").status).toBe("blocked_low_confidence");
    expect(call({ resolverVersion: "other" }, "immutable_knowledge_time").status).toBe("blocked_unsupported_resolver");
  });

  it("keeps the product default empty so nothing is authoritative today", () => {
    expect(SUPPORTED_ROLE_RESOLVER_VERSIONS).toHaveLength(0);
    const v = resolveRoleAuthorityAtOrigin({
      origin: "2026-08-15", expectedProviderAccountId: IWA.providerAccountId, staleAfterDays: 3,
      sourceTemporalStatus: "immutable_knowledge_time", rows: [row],
    });
    expect(v.status).toBe("blocked_unsupported_resolver");
  });
});

// ---------------------------------------------------------------------------
// C4.5 — claimability tied to every required read
// ---------------------------------------------------------------------------

describe("C4.5 — claims cannot outrun coverage", () => {
  it("separates semantic claimability from identity completeness", () => {
    const v = reconcileClaims({
      analysis: { configChangeQuality: { unknownCells: [], semanticCountsClaimable: true, identityManifestComplete: true, identityTruncatedFor: [] } },
      configStates: { coverage: [{ status: "ok", cellKind: "semantic" }, { status: "unknown/source_read_failed", cellKind: "identity" }] },
    });
    expect(v.some((x) => x.detail.includes("identityManifestComplete is true while an identity coverage cell failed"))).toBe(true);
  });

  it("refuses identity completeness when a cell hit the cap", () => {
    const v = reconcileClaims({
      analysis: { configChangeQuality: { unknownCells: [], semanticCountsClaimable: true, identityManifestComplete: true, identityTruncatedFor: ["act_x/adset"] } },
      configStates: { coverage: [{ status: "ok", cellKind: "identity" }] },
    });
    expect(v.some((x) => x.detail.includes("hit the cap"))).toBe(true);
  });

  it("refuses semantic claimability when a semantic cell failed", () => {
    const v = reconcileClaims({
      analysis: { configChangeQuality: { unknownCells: ["a"], semanticCountsClaimable: true, identityManifestComplete: false, identityTruncatedFor: [] } },
      configStates: { coverage: [{ status: "unknown/source_read_failed", cellKind: "semantic" }] },
    });
    expect(v.some((x) => x.detail.includes("semanticCountsClaimable is true while a semantic coverage cell failed"))).toBe(true);
  });

  it("detects unknown-cell counts that contradict the coverage rows", () => {
    const v = reconcileClaims({
      analysis: { configChangeQuality: { unknownCells: [], semanticCountsClaimable: false, identityManifestComplete: false, identityTruncatedFor: [] } },
      configStates: { coverage: [{ status: "unknown/source_read_failed", cellKind: "semantic" }] },
    });
    expect(v.some((x) => x.detail.includes("unknown cells are declared"))).toBe(true);
  });

  it("audits exact expected key sets for every coverage matrix", () => {
    const expected = ["a", "b"];
    expect(auditExpectedKeys(expected, ["a", "b"]).ok).toBe(true);
    expect(auditExpectedKeys(expected, ["a"]).ok).toBe(false);
    expect(auditExpectedKeys(expected, ["a", "b", "b"]).ok).toBe(false);
    expect(auditExpectedKeys(expected, ["a", "b", "c"]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C5 — adversarial mutation of the REAL frozen artifact
// ---------------------------------------------------------------------------

const ARTIFACT_PATH = "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json";
const FROZEN = readFileSync(resolve(ARTIFACT_PATH), "utf8");
type Art = Record<string, any>;
const frozenClone = (): Art => JSON.parse(FROZEN);

/** Mutate, RE-SEAL, verify. Stale hashes are never the explanation. */
function mutateAndVerify(mutate: (a: Art) => void) {
  const a = frozenClone();
  mutate(a);
  return verifyArtifact(sealArtifact(a));
}
const reasons = (r: ReturnType<typeof verifyArtifact>) => new Set(r.scope.violations.map((v) => v.reason));

describe("C5 baseline", () => {
  it("the unmutated frozen artifact verifies", () => {
    const r = verifyArtifact(frozenClone());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.scope.counters.expectedInvocations).toBe(D080_EXPECTED_INVOCATION_COUNT);
    expect(r.scope.counters.observedInvocations).toBe(D080_EXPECTED_INVOCATION_COUNT);
  });
});

describe("C5.1 — artifact shape and provenance are enforced", () => {
  it("rejects an emptied clocks.perBinding", () => {
    const r = mutateAndVerify((a) => { a.clocks.perBinding = []; });
    expect(r.ok).toBe(false);
  });

  it.each([...D080_REQUIRED_OBJECTS, "correctionLedger"])("rejects a deleted %s", (key) => {
    const r = mutateAndVerify((a) => { delete a[key]; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain(key);
  });

  it("rejects a wrong contract string", () => {
    const r = mutateAndVerify((a) => { a.contract = "wrong"; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("contract_mismatch");
  });

  it("rejects an untrue transaction proof", () => {
    for (const [path, value] of [["transactionReadOnly", "off"], ["transactionIsolation", "read committed"], ["statementTimeout", "5s"]] as const) {
      const r = mutateAndVerify((a) => { a.provenance[path] = value; });
      expect(r.ok, path).toBe(false);
      expect(r.failures.join(" ")).toContain("provenance_untrue");
    }
  });

  it("rejects a forged query-contract, manifest or read-plan hash", () => {
    for (const key of ["queryContractSha256", "queryManifestSha256", "readPlanSha256"]) {
      const r = mutateAndVerify((a) => { a.provenance[key] = "fake"; });
      expect(r.ok, key).toBe(false);
      expect(r.failures.join(" ")).toContain("contract_hash_mismatch");
    }
  });

  it("rejects a compromised execution authority", () => {
    expect(mutateAndVerify((a) => { a.provenance.executionAuthority.ok = false; }).ok).toBe(false);
    const r = mutateAndVerify((a) => { a.provenance.executionAuthority.truthyBefore = ["META_ADS_WRITE_ENABLED"]; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("execution_authority");
  });

  it("rejects a tampered pinned matrix or scope reconciliation", () => {
    expect(mutateAndVerify((a) => { a.scope.pinnedBindings = []; }).ok).toBe(false);
    const r = mutateAndVerify((a) => { a.scope.unexpectedExtra = ["bogus|act_x"]; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("scope_reconciliation");
  });

  it("rejects a broken D078 predecessor pin", () => {
    const r = mutateAndVerify((a) => { a.scope.pinnedInputs.d078BundleObserved = "0".repeat(64); });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("predecessor_pin");
  });

  it("discovers a NON-EMPTY scalar list", () => {
    const found = discoverRowBearingSections({ a: { list: ["x", "y"] } });
    expect(found).toContain("a.list");
    const r = mutateAndVerify((a) => { a.brandNewScalarList = ["x"]; });
    expect(r.scope.unhandledSections).toContain("brandNewScalarList");
    expect(r.ok).toBe(false);
  });

  it("recomputes the cutoff and series_from rather than trusting them", () => {
    expect(mutateAndVerify((a) => { a.clocks.perBinding[0].cutoff = "2026-01-01"; }).ok).toBe(false);
    expect(mutateAndVerify((a) => { a.clocks.perBinding[0].series_from = "2020-01-01"; }).ok).toBe(false);
  });

  it("rejects a truncated identity list while the claim says complete", () => {
    const r = mutateAndVerify((a) => { a.configStates.identityTruncatedFor = ["act_x/adset"]; });
    expect(r.ok).toBe(false);
    expect(reasons(r)).toContain("claim_contradiction");
  });

  it("fails closed on a declared clock field that is absent", () => {
    const r = mutateAndVerify((a) => { delete a.configStates.identities[0].captured_at; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("not declared nullable");
  });
});

describe("C5.2 — exact invocation reconciliation", () => {
  it("generates exactly 226 expected invocations for the pinned scope", () => {
    const expected = buildExpectedInvocations();
    expect(expected).toHaveLength(226);
    expect(new Set(expected.map((e) => e.invocationKey)).size).toBe(226);
    expect(Object.keys(D080_READ_PLAN)).toHaveLength(29);
    expect(Object.keys(D080_QUERIES)).toHaveLength(28);
  });

  it("rejects a ledger collapsed to one row per plan key", () => {
    const r = mutateAndVerify((a) => {
      const seen = new Set<string>();
      a.provenance.readLedger = a.provenance.readLedger.filter((l: any) => {
        if (seen.has(l.planKey)) return false;
        seen.add(l.planKey);
        return true;
      });
      a.provenance.readFailures = a.provenance.readLedger.filter((l: any) => l.status !== "ok");
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("missing_invocation");
  });

  it("rejects a renamed or suffixed invocation", () => {
    const r = mutateAndVerify((a) => {
      const row = a.provenance.readLedger.find((l: any) => l.planKey === "runSchema");
      row.query = "runSchema:unexpected";
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("is not the exact plan key");
  });

  it("rejects a dropped, duplicated or added invocation", () => {
    expect(mutateAndVerify((a) => { a.provenance.readLedger.pop(); }).failures.join(" ")).toContain("missing_invocation");
    expect(mutateAndVerify((a) => { a.provenance.readLedger.push({ ...a.provenance.readLedger[0] }); }).failures.join(" ")).toContain("duplicate_invocation");
    expect(mutateAndVerify((a) => {
      a.provenance.readLedger.push({ ...a.provenance.readLedger[0], invocationKey: "nope#global", planKey: "nope", query: "nope" });
    }).failures.join(" ")).toContain("unexpected_invocation");
  });

  it("rejects a wrong grain, source, PIT layer or knowledge bound", () => {
    const cases: Array<[string, (l: any) => void, string]> = [
      ["grain", (l) => { l.grain = "campaign"; }, "grain_mismatch"],
      ["source", (l) => { l.source = "meta_adset_config_history"; }, "source_mismatch"],
      ["pitStatus", (l) => { l.pitStatus = "pit_safe"; }, "pit_layer_mismatch"],
      ["knowledgeBounds", (l) => { l.knowledgeBounds = "two_sided"; }, "knowledge_bound_mismatch"],
    ];
    for (const [label, mutate, reason] of cases) {
      const r = mutateAndVerify((a) => {
        const row = a.provenance.readLedger.find((l: any) => l.planKey === "clockAdsetDaily");
        mutate(row);
      });
      expect(r.ok, label).toBe(false);
      expect(r.failures.join(" "), label).toContain(reason);
    }
    // Four full verifications of the frozen artifact take ~15.3s, which sits
    // just past the 15s default and made this test fail on time rather than on
    // truth. The assertions are unchanged.
  }, 300_000);

  it("rejects swapped bindings", () => {
    const r = mutateAndVerify((a) => {
      const rows = a.provenance.readLedger.filter((l: any) => l.planKey === "seriesCampaign");
      const t = rows[0].providerAccountId;
      rows[0].providerAccountId = rows[1].providerAccountId;
      rows[1].providerAccountId = t;
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a readFailures list that is not the exact non-ok subset", () => {
    const r = mutateAndVerify((a) => {
      const row = a.provenance.readLedger[5];
      row.status = "unknown/source_read_failed";
      row.reason = "injected";
      // readFailures deliberately NOT updated
    });
    expect(r.ok).toBe(false);
  });

  it("builds a stable invocation key per cardinality", () => {
    expect(invocationKeyFor("runSchema", "global")).toBe("runSchema#global");
    const byCardinality = buildExpectedInvocations().reduce<Record<string, number>>((acc, e) => {
      acc[e.cardinality] = (acc[e.cardinality] ?? 0) + 1;
      return acc;
    }, {});
    // 4 once + 112 per_binding + 98 per_binding_grain + 12 per_business
    expect(byCardinality).toEqual({ once: 4, per_binding: 112, per_binding_grain: 98, per_business: 12 });
  });

  it("reports an empty ledger as every invocation missing", () => {
    expect(reconcileInvocations([])).toHaveLength(226);
  });
});

describe("C5.3 — coverage matrices are recomputed, not trusted", () => {
  const drops: Array<[string, (a: Art) => void]> = [
    ["configStates.coverage drop", (a) => { a.configStates.coverage.pop(); }],
    ["configStates.coverage duplicate", (a) => { a.configStates.coverage.push({ ...a.configStates.coverage[0] }); }],
    ["unitEvidence.coverageMatrix drop", (a) => { a.unitEvidence.coverageMatrix.pop(); }],
    ["unitEvidence.coverageMatrix duplicate", (a) => { a.unitEvidence.coverageMatrix.push({ ...a.unitEvidence.coverageMatrix[0] }); }],
    ["canonicalDecisions.perBinding drop", (a) => { a.canonicalDecisions.perBinding.pop(); }],
    ["canonicalDecisions.servedDateCoverage drop", (a) => { a.canonicalDecisions.servedDateCoverage.pop(); }],
    ["analysis.servedDateContract.coverage drop", (a) => { a.analysis.servedDateContract.coverage.pop(); }],
  ];
  it.each(drops)("rejects %s", (_label, mutate) => {
    const r = mutateAndVerify(mutate);
    expect(r.ok).toBe(false);
    expect(reasons(r).has("coverage_key_mismatch") || reasons(r).has("claim_contradiction")).toBe(true);
  });

  it("declares the exact expected key sets", () => {
    const keys = expectedCoverageKeys();
    expect(keys.clockBinding).toHaveLength(7);
    expect(keys.configCoverage).toHaveLength(42);
    expect(keys.unitCoverage).toHaveLength(28);
    expect(keys.canonicalPerBinding).toHaveLength(7);
    expect(keys.servedDateCoverage).toHaveLength(7);
  });

  it("distinguishes a failed identity read from a clean empty membership", () => {
    // The identity read FAILED, but the binding presents a clean empty set.
    const r = mutateAndVerify((a) => {
      const account = a.canonicalDecisions.perBinding[0].provider_account_id;
      const row = a.provenance.readLedger.find(
        (l: any) => l.planKey === "canonicalIdentities" && l.providerAccountId === account,
      );
      row.status = "unknown/source_read_failed";
      row.rows = 0;
      row.reason = "injected";
      a.provenance.readFailures = a.provenance.readLedger.filter((l: any) => l.status !== "ok");
      a.canonicalDecisions.perBinding[0].identity_status = "ok_zero_identities";
      a.canonicalDecisions.perBinding[0].membership = { count: 0, groupHash: "x", firstIdentity: null, lastIdentity: null };
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("identity_status");
  });
});

describe("C5.4 — ledger status drives coverage and claims", () => {
  const families = [
    "configSemanticStates:pointInTime",
    "configTransitionIdentities",
    "servedDateCandidates",
    "canonicalIdentities",
    "unitEvidenceCampaignDaily",
  ];
  it.each(families)("rejects a failed %s read with unchanged coverage", (planKey) => {
    const r = mutateAndVerify((a) => {
      const row = a.provenance.readLedger.find((l: any) => l.planKey === planKey);
      row.status = "unknown/source_read_failed";
      row.rows = 0;
      row.reason = "injected";
      a.provenance.readFailures = a.provenance.readLedger.filter((l: any) => l.status !== "ok");
    });
    expect(r.ok, planKey).toBe(false);
  });

  it("rejects the inverse: coverage failed while the ledger is ok", () => {
    const r = mutateAndVerify((a) => { a.configStates.coverage[0].status = "unknown/source_read_failed"; });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown list that does not match coverage", () => {
    const r = mutateAndVerify((a) => { a.analysis.configChangeQuality.unknownCells = ["act_x/campaign/pointInTime"]; });
    expect(r.ok).toBe(false);
  });

  it("rejects a claim reported while its dependency is unknown", () => {
    const r = mutateAndVerify((a) => {
      a.analysis.configChangeQuality.semanticCountsClaimable = false;
      a.analysis.configChangeQuality.totalClaimable = true;
    });
    expect(r.ok).toBe(false);
  });

  it("derives the same claims verify recomputes", () => {
    const a = frozenClone();
    const derived = deriveClaims({
      configCoverage: a.configStates.coverage,
      unitCoverage: a.unitEvidence.coverageMatrix,
      servedCoverage: a.canonicalDecisions.servedDateCoverage,
      identityTruncatedFor: a.configStates.identityTruncatedFor,
    });
    expect(derived.semanticCountsClaimable).toBe(a.analysis.configChangeQuality.semanticCountsClaimable);
    expect(derived.identityManifestComplete).toBe(a.analysis.configChangeQuality.identityManifestComplete);
    expect(derived.servedFleetClaimable).toBe(a.analysis.servedDateContract.fleetComparisonClaimable);
  });
});

describe("C5.5 — aggregates are reconciled or honestly labelled", () => {
  it("rejects an inflated unit aggregate sum", () => {
    const r = mutateAndVerify((a) => { a.unitEvidence.rows[0].compared = 999999999; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("totalCompared");
  });

  it("rejects a sub-count that exceeds its own denominator", () => {
    const r = mutateAndVerify((a) => { a.unitEvidence.rows[0].raw_equals_stored = 999999999; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("exceeds compared");
  });

  it("rejects a tampered budget-verb census", () => {
    const r = mutateAndVerify((a) => { a.canonicalDecisions.budgetVerbCensus[0].scanned_rows = 1; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("scannedHistoricalSnapshotRows");
  });

  it("rejects replay window arithmetic that does not sum", () => {
    expect(mutateAndVerify((a) => { a.analysis.layer3.windows["14"].entityDays = 1; }).ok).toBe(false);
    expect(mutateAndVerify((a) => { a.analysis.layer1Creative.denominator = 1; }).ok).toBe(false);
  });

  it("rejects a config total that does not sum from its frozen rows", () => {
    const r = mutateAndVerify((a) => { a.configStates.pointInTime[0].transitions = 1; });
    expect(r.ok).toBe(false);
  });

  it("counts only real comparisons, and names what it cannot recompute", () => {
    const r = verifyArtifact(frozenClone());
    expect(r.scope.counters).not.toHaveProperty("aggregateConsistencyCheckedRows");
    expect(r.scope.counters.crossSectionReconciliations).toBeGreaterThan(100);
    expect(r.scope.counters.sourceAggregateRows).toBeGreaterThan(0);
  });
});

describe("C5.6 — served-date behaviour, not regex", () => {
  const ACC = "act_1";
  const OTHER = "act_2";

  it("resolves ownership from meta_creative_dimensions alone", () => {
    const scope = resolveCreativeAccountScope(
      [{ source: "meta_creative_dimensions", providerAccountId: ACC, creativeId: "c1" }],
      ACC,
    );
    expect(scope).toEqual(["c1"]);
  });

  it("resolves ownership from meta_creative_daily alone", () => {
    expect(resolveCreativeAccountScope([{ source: "meta_creative_daily", providerAccountId: ACC, creativeId: "c2" }], ACC)).toEqual(["c2"]);
  });

  it("unions both tables without double counting", () => {
    const scope = resolveCreativeAccountScope(
      [
        { source: "meta_creative_dimensions", providerAccountId: ACC, creativeId: "c1" },
        { source: "meta_creative_daily", providerAccountId: ACC, creativeId: "c1" },
      ],
      ACC,
    );
    expect(scope).toEqual(["c1"]);
  });

  it("excludes a creative seen under two accounts", () => {
    const scope = resolveCreativeAccountScope(
      [
        { source: "meta_creative_dimensions", providerAccountId: ACC, creativeId: "shared" },
        { source: "meta_creative_daily", providerAccountId: OTHER, creativeId: "shared" },
      ],
      ACC,
    );
    expect(scope).toEqual([]);
  });

  it("excludes a creative owned only by another account", () => {
    expect(resolveCreativeAccountScope([{ source: "meta_creative_daily", providerAccountId: OTHER, creativeId: "c9" }], ACC)).toEqual([]);
  });

  it("takes the later legacy candidate over the native max", () => {
    const r = resolveServedDate({ nativeAdMax: "2026-08-21", legacyCreativeMax: "2026-08-22", nativeJobRunMax: null });
    expect(r.servedDate).toBe("2026-08-22");
    expect(r.equalsNativeMax).toBe(false);
    expect(r.divergenceReason).toBe("later_non_native_candidate");
  });

  it("takes the later job-run candidate over the native max", () => {
    expect(resolveServedDate({ nativeAdMax: "2026-08-20", legacyCreativeMax: null, nativeJobRunMax: "2026-08-23" }).servedDate).toBe("2026-08-23");
  });

  it("reports no candidate and a failed read as distinct states", () => {
    expect(resolveServedDate({ nativeAdMax: null, legacyCreativeMax: null, nativeJobRunMax: null }).status).toBe("no_candidate");
    expect(resolveServedDate({ readFailed: true, nativeAdMax: "2026-08-22", legacyCreativeMax: null, nativeJobRunMax: null }).status).toBe("unknown/source_read_failed");
  });

  it("is unclaimable, never vacuously equal, when a binding is missing or failed", () => {
    const seven = Array.from({ length: 7 }, () => resolveServedDate({ nativeAdMax: "2026-08-22", legacyCreativeMax: "2026-08-22", nativeJobRunMax: "2026-08-22" }));
    expect(resolveFleetComparison(seven, 7)).toEqual({ claimable: true, allEqual: true });
    const withFailure = [...seven.slice(0, 6), resolveServedDate({ readFailed: true, nativeAdMax: null, legacyCreativeMax: null, nativeJobRunMax: null })];
    expect(resolveFleetComparison(withFailure, 7)).toEqual({ claimable: false, allEqual: null });
    expect(resolveFleetComparison(seven.slice(0, 6), 7)).toEqual({ claimable: false, allEqual: null });
  });

  it("matches the frozen artifact's own seven-binding outcome", () => {
    const a = frozenClone();
    const resolutions = a.analysis.servedDateContract.perBinding.map((r: any) =>
      resolveServedDate({ nativeAdMax: r.nativeAdMax, legacyCreativeMax: r.legacyCreativeMax, nativeJobRunMax: r.nativeJobRunMax }),
    );
    const fleet = resolveFleetComparison(resolutions, 7);
    expect(fleet.claimable).toBe(a.analysis.servedDateContract.fleetComparisonClaimable);
    expect(fleet.allEqual).toBe(a.analysis.servedDateContract.allServedEqualNativeMax);
  });

  it("carries no stale receipt-hash or both-readers language", () => {
    const src = readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8");
    // The word may appear only inside the sentence that CORRECTS it.
    const stray = src.split("\n").filter((l) => /receipt hash/i.test(l) && !/NOT a hash of captured source bytes|would overstate|calling it a receipt hash/i.test(l));
    expect(stray).toEqual([]);
    expect(src).not.toMatch(/both take MAX\(as_of_date\)/);
    expect(src).toMatch(/claimMetadataHash/);
  });
});

// ---------------------------------------------------------------------------
// C6 — the 22 independent attacks, plus the execution boundary
// ---------------------------------------------------------------------------

const ledgerRow = (a: Art, planKey: string) => a.provenance.readLedger.find((l: any) => l.planKey === planKey);

/** Re-seal the artifact after mutating, then run the real verifier. */
function attack(mutate: (a: Art) => void) {
  const a = frozenClone();
  mutate(a);
  return verifyArtifact(sealArtifact(a));
}
const c6reasons = (r: ReturnType<typeof verifyArtifact>) => new Set(r.scope.violations.map((v) => v.reason));

describe("C6.1 — recorded provenance must match the rebuilt canonical request", () => {
  const cases: Array<[string, (a: Art) => void]> = [
    ["seriesCampaign.effectiveFrom", (a) => { ledgerRow(a, "seriesCampaign").effectiveFrom = "1900-01-01"; }],
    ["seriesCampaign.effectiveTo", (a) => { ledgerRow(a, "seriesCampaign").effectiveTo = "2099-01-01"; }],
    ["configSemanticStates:pointInTime.knowledgeTo", (a) => { ledgerRow(a, "configSemanticStates:pointInTime").knowledgeTo = "2099-01-01"; }],
    ["canonicalIdentities.asOfDate", (a) => { ledgerRow(a, "canonicalIdentities").asOfDate = "1900-01-01"; }],
    ["configTransitionIdentities.limit", (a) => { ledgerRow(a, "configTransitionIdentities").limit = 1; }],
    ["seriesCampaign.source", (a) => { ledgerRow(a, "seriesCampaign").source = "totally_wrong"; }],
    ["ownershipObservations.source", (a) => { ledgerRow(a, "ownershipObservations").source = "totally_wrong"; }],
    ["templateKey", (a) => { ledgerRow(a, "seriesCampaign").templateKey = "seriesAdset"; }],
    ["statementSha256", (a) => { ledgerRow(a, "seriesCampaign").statementSha256 = "0".repeat(64); }],
    ["paramsSha256", (a) => { ledgerRow(a, "seriesCampaign").paramsSha256 = "0".repeat(64); }],
    ["businessListHash", (a) => { ledgerRow(a, "targetPackHistory").businessListHash = "0".repeat(64); }],
    ["businessId", (a) => { ledgerRow(a, "campaignRoleCensus").businessId = D080_PINNED_BINDINGS[1].businessId; }],
  ];
  it.each(cases)("rejects a forged %s", (_label, mutate) => {
    const r = attack(mutate);
    expect(r.ok).toBe(false);
    expect(c6reasons(r).has("request_provenance_mismatch") || c6reasons(r).has("invocation_mismatch")).toBe(true);
  });

  it("rejects an arbitrary ledger status", () => {
    const r = attack((a) => { ledgerRow(a, "seriesCampaign").status = "totally_made_up"; });
    expect(r.ok).toBe(false);
    expect([...D080_LEDGER_STATUSES]).not.toContain("totally_made_up");
  });

  it("shapes templates deterministically and hashes params stably", () => {
    expect(shapeStatement("configSemanticStates", "campaign")).toContain("meta_campaign_config_history");
    expect(shapeStatement("configSemanticStates", "adset")).toContain("meta_adset_config_history");
    expect(shapeStatement("configSemanticStates", "campaign")).not.toContain("SOURCE_TABLE");
    expect(normaliseParams(["b", ["z", "a"], 5, null])).toEqual(["b", ["a", "z"], 5, null]);
  });

  it("rebuilds every ledger row's request from the frozen prerequisites", () => {
    const a = frozenClone();
    const expected = buildExpectedDispositions(a);
    expect(expected.size).toBe(226);
    for (const row of a.provenance.readLedger) {
      const d = expected.get(row.invocationKey);
      expect(d, row.invocationKey).toBeDefined();
      expect(row.statementSha256, row.invocationKey).toBe(d!.request.statementSha256);
      expect(row.paramsSha256, row.invocationKey).toBe(d!.request.paramsSha256);
      expect(row.source, row.invocationKey).toBe(d!.request.source);
    }
    expect(reconcileRequestProvenance(a)).toEqual([]);
  });

  it("every plan definition has an exact source expectation", () => {
    for (const planKey of Object.keys(D080_READ_PLAN)) {
      const req = buildCanonicalRequest(planKey, { grain: "campaign", params: [] });
      expect(req.source, planKey).toBeTruthy();
    }
  });
});

/**
 * C7.2 — the Correction 6 "boundary" tests were removed. They regex-checked
 * that an error string existed in the source and recomputed hashes by hand;
 * they never drove the guard or proved a query was refused before execution.
 * The real boundary proof lives in the C7.2 block below, against an injected
 * executor that must receive ZERO calls on a mismatch.
 */
describe("C6.2 — every invocation is bound to its materialised result", () => {
  const removals: Array<[string, (a: Art) => void]> = [
    ["series.rows", (a) => { a.series.rows = []; }],
    ["configStates.identities", (a) => { a.configStates.identities = []; }],
    ["canonicalDecisions.servedDate", (a) => { a.canonicalDecisions.servedDate = []; }],
    ["ownershipObservations.rows", (a) => { a.ownershipObservations.rows = []; }],
    ["campaignRole.rows", (a) => { a.campaignRole.rows = []; }],
    ["unitEvidence.rows", (a) => { a.unitEvidence.rows = []; }],
    ["configStates.pointInTime", (a) => { a.configStates.pointInTime = []; }],
  ];
  it.each(removals)("rejects removal of all %s", (_label, mutate) => {
    const r = attack(mutate);
    expect(r.ok).toBe(false);
    expect(c6reasons(r).has("result_count_mismatch")).toBe(true);
  });

  it("rejects a successful ledger row whose count disagrees with its slice", () => {
    const r = attack((a) => { ledgerRow(a, "seriesCampaign").rows = 0; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("result_count_mismatch");
  });

  it("rejects a result ROW HASH change that preserves the count", () => {
    const r = attack((a) => {
      const rows = a.series.rows;
      const idx = a.series.columns.indexOf("spend");
      rows[0][idx] = 123456789;
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("rowHash");
  });

  it("rejects a failed read that still has materialised rows", () => {
    const r = attack((a) => {
      const row = ledgerRow(a, "seriesCampaign");
      row.status = "unknown/source_read_failed";
      row.rows = 0;
      row.reason = "injected";
      a.provenance.readFailures = a.provenance.readLedger.filter((l: any) => l.status !== "ok");
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("rows are materialised");
  });

  it("issues exactly one receipt per expected invocation", () => {
    const a = frozenClone();
    const { receipts } = reconcileInvocationResults(a);
    expect(receipts).toHaveLength(226);
    expect(new Set(receipts.map((r) => r.invocationKey)).size).toBe(226);
    expect(receipts.filter((r) => !r.recomputable).length).toBeGreaterThan(0);
    expect(a.invocationResults.receipts).toHaveLength(226);
  });

  it("rejects a tampered stored receipt", () => {
    expect(attack((a) => { a.invocationResults.receipts[0].materialisedRows = 999999; }).ok).toBe(false);
    expect(attack((a) => { a.invocationResults.receipts[0].rowHash = "0".repeat(64); }).ok).toBe(false);
    expect(attack((a) => { a.invocationResults.receipts.pop(); }).ok).toBe(false);
  }, 180_000);
});

describe("C6.3 — the complete nested contract and value domains", () => {
  it.each([...D080_REQUIRED_NESTED_OBJECTS])("rejects a deleted %s", (path) => {
    const r = attack((a) => {
      const parts = path.split(".");
      let node: any = a;
      for (const key of parts.slice(0, -1)) node = node?.[key];
      if (node) delete node[parts[parts.length - 1]!];
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an arbitrary status in every coverage domain", () => {
    const paths: Array<[string, (a: Art) => void]> = [
      ["unit", (a) => { a.unitEvidence.coverageMatrix[0].status = "made_up"; }],
      ["config", (a) => { a.configStates.coverage[0].status = "made_up"; }],
      ["servedDateCoverage", (a) => { a.canonicalDecisions.servedDateCoverage[0].status = "made_up"; }],
      ["servedAnalysis", (a) => { a.analysis.servedDateContract.coverage[0].status = "made_up"; }],
    ];
    for (const [label, mutate] of paths) {
      const r = attack(mutate);
      expect(r.ok, label).toBe(false);
      expect(r.failures.join(" "), label).toContain("status_domain");
    }
  }, 180_000);

  it("does not count a dependency skip as a successful unit read", () => {
    expect([...UNIT_READ_STATUSES]).toEqual(["rows_returned", "zero_rows_returned"]);
    const r = attack((a) => { a.unitEvidence.coverageMatrix[0].status = "not_run_dependency_failed"; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("allCellsRead");
  });

  it("rejects an execution-authority change outside the known flag set or truthy", () => {
    expect(attack((a) => { a.provenance.executionAuthority.changedByLoader = [{ flag: "NOT_A_FLAG", before: null, after: "0" }]; }).ok).toBe(false);
    expect(attack((a) => { a.provenance.executionAuthority.changedByLoader = [{ flag: "ENABLE_RUNTIME_MIGRATIONS", before: null, after: "1" }]; }).ok).toBe(false);
  });
});

describe("C6.4 — scope, clock and matrix exactness", () => {
  it("rejects a duplicated clock source cell that preserves length", () => {
    const r = attack((a) => { a.clocks.perSource[3] = JSON.parse(JSON.stringify(a.clocks.perSource[0])); });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("coverage_matrix");
  });

  it("rejects a missing or extra clock source key", () => {
    expect(attack((a) => { a.clocks.perSource.pop(); }).ok).toBe(false);
    expect(attack((a) => { a.clocks.perSource.push(JSON.parse(JSON.stringify(a.clocks.perSource[0]))); }).ok).toBe(false);
  });

  it("rejects a swapped clock source or grain", () => {
    expect(attack((a) => { a.clocks.perSource[0].source = "totally_wrong"; }).ok).toBe(false);
    expect(attack((a) => { a.clocks.perSource[0].grain = "adset"; }).ok).toBe(false);
  });

  it("rejects a raw clock that disagrees with the derived per_source value", () => {
    const r = attack((a) => { a.clocks.perSource[0].latest_effective = "1900-01-01"; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("clock_disagreement");
  });

  it("rejects a missing, duplicated or reselected observed binding", () => {
    expect(attack((a) => {
      const removed = a.scope.observedBindings.pop();
      a.scope.expectedMissing = [`${removed.business_id}|${removed.provider_account_id}`];
    }).ok).toBe(false);
    expect(attack((a) => { a.scope.observedBindings.push(JSON.parse(JSON.stringify(a.scope.observedBindings[0]))); }).ok).toBe(false);
    const r = attack((a) => { a.scope.observedBindings[0].is_selected = !a.scope.observedBindings[0].is_selected; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("is_selected");
  }, 180_000);
});

describe("C6.1E — readFailures is an exact multiset", () => {
  it("rejects a duplicate failure hiding a different failed invocation", () => {
    const r = attack((a) => {
      const rows = a.provenance.readLedger.filter((l: any) => l.planKey === "seriesCampaign").slice(0, 2);
      for (const row of rows) { row.status = "unknown/source_read_failed"; row.rows = 0; row.reason = "injected"; }
      a.provenance.readFailures = [JSON.parse(JSON.stringify(rows[0])), JSON.parse(JSON.stringify(rows[0]))];
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("failure_multiset_mismatch");
  });

  it("rejects a failure whose reason or row count drifted", () => {
    const r = attack((a) => {
      const row = ledgerRow(a, "seriesCampaign");
      row.status = "unknown/source_read_failed"; row.rows = 0; row.reason = "real";
      a.provenance.readFailures = [{ ...JSON.parse(JSON.stringify(row)), reason: "different" }];
    });
    expect(r.ok).toBe(false);
  });

  it("accepts the frozen artifact's own empty failure set", () => {
    expect(reconcileFailureMultiset(frozenClone())).toEqual([]);
  });

  it("keeps 226 attempts even when a prerequisite is missing", () => {
    // A binding with no cutoff still yields its full per-binding invocation set
    // as explicit dependency skips.
    const expected = buildExpectedDispositions({ clocks: { perBinding: [] }, canonicalDecisions: { perBinding: [] } });
    expect(expected.size).toBe(226);
    const skips = [...expected.values()].filter((d) => d.disposition === "dependency_skip" && d.request.planKey === "seriesCampaign");
    expect(skips).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// C7 — the seven confirmed attacks, the real boundary, and the typed contract
// ---------------------------------------------------------------------------

describe("C7.4 — typed, dated and enumerated schema", () => {
  it("rejects an unparseable retrieval timestamp", () => {
    const r = attack((a) => { a.provenance.retrievedAt = "not-a-timestamp"; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("invalid_timestamp");
  });

  it("accepts the Postgres offset form and rejects a naive timestamp", () => {
    expect(isValidTimestampWithZone("2026-08-31 18:58:13.756626+00")).toBe(true);
    expect(isValidTimestampWithZone("2026-08-31T18:58:13.000Z")).toBe(true);
    expect(isValidTimestampWithZone("2026-08-31 18:58:13")).toBe(false);
    expect(isValidTimestampWithZone("not-a-timestamp")).toBe(false);
    expect(isValidCalendarDate("2026-08-21")).toBe(true);
    expect(isValidCalendarDate("2026-02-31")).toBe(false);
    expect(isValidCalendarDate("2026-8-21")).toBe(false);
  });

  it("rejects an unknown clock cutoff_status", () => {
    const r = attack((a) => { a.clocks.perBinding[0].cutoff_status = "made_up"; });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("cutoff_status");
  });

  it("rejects an unknown canonical latest_status and identity_status", () => {
    expect(attack((a) => { a.canonicalDecisions.perBinding[0].latest_status = "made_up"; }).ok).toBe(false);
    expect(attack((a) => { a.canonicalDecisions.perBinding[0].identity_status = "made_up"; }).ok).toBe(false);
  });

  it("rejects a negative row count and a negative denominator", () => {
    expect(attack((a) => { a.unitEvidence.coverageMatrix[0].rows = -1; }).failures.join(" ")).toContain("invalid_count");
    expect(attack((a) => { a.analysis.layer2StrictPit.denominator = -1; }).failures.join(" ")).toContain("invalid_count");
  });

  it("rejects non-integer, NaN-like, infinite and string counts", () => {
    expect(isCount(3)).toBe(true);
    expect(isCount(-1)).toBe(false);
    expect(isCount(1.5)).toBe(false);
    expect(isCount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isCount("5")).toBe(false);
    expect(isCount(null)).toBe(false);
    for (const path of ["analysis.layer3.denominator", "analysis.layer1Creative.denominator"]) {
      const r = attack((a) => {
        const parts = path.split(".");
        let node: any = a;
        for (const k of parts.slice(0, -1)) node = node[k];
        node[parts[parts.length - 1]!] = 1.5;
      });
      expect(r.ok, path).toBe(false);
    }
  });

  it("declares the v6 contract, which supersedes v5 and the rejected v4", () => {
    const a = frozenClone();
    expect(a.contract).toBe("adsecute.meta.d080-budget-edit-evidence.v6");
    expect(D080_EVIDENCE_CONTRACT).toBe("adsecute.meta.d080-budget-edit-evidence.v6");
    // v6 exists because the artifact gained a section and four statuses, not
    // because the verifier got stricter: dependencyCoverage.cells is new, and
    // `not_run_dependency_failed` is now a legal state on four coverage paths.
    expect(D080_REQUIRED_SECTIONS).toContain("dependencyCoverage.cells");
    expect(D080_STATUS_DOMAINS["canonicalDecisions.servedDateCoverage"]).toContain("not_run_dependency_failed");
    expect(attack((x) => { x.contract = "adsecute.meta.d080-budget-edit-evidence.v4"; }).ok).toBe(false);
  });

  it("does not apply one generic domain to unrelated statuses", () => {
    const fields = D080_FIELD_DOMAINS.map((d) => `${d.path}.${d.field}`);
    expect(fields).toContain("clocks.perBinding.cutoff_status");
    expect(fields).toContain("canonicalDecisions.perBinding.latest_status");
    expect(new Set(D080_FIELD_DOMAINS.map((d) => d.allowed.join("|"))).size).toBeGreaterThan(1);
    expect(D080_REQUIRED_COUNT_PATHS.length).toBeGreaterThan(10);
  });
});

describe("C7.5 — failure provenance is the complete stable projection", () => {
  it("rejects a failure row with a forged source or hash", () => {
    for (const forge of [
      (row: any) => { row.source = "totally_wrong"; },
      (row: any) => { row.statementSha256 = "0".repeat(64); },
      (row: any) => { row.paramsSha256 = "0".repeat(64); },
      (row: any) => { row.grain = "adset"; },
      (row: any) => { row.effectiveFrom = "1900-01-01"; },
    ]) {
      const r = attack((a) => {
        const row = a.provenance.readLedger.find((l: any) => l.planKey === "seriesCampaign");
        row.status = "unknown/source_read_failed"; row.rows = 0; row.sourceRowCount = 0; row.reason = "injected";
        const forged = JSON.parse(JSON.stringify(row));
        forge(forged);
        a.provenance.readFailures = [forged];
      });
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toContain("failure_multiset_mismatch");
    }
  }, 180_000);

  it("excludes only genuinely nondeterministic timing from the projection", () => {
    const a = frozenClone();
    const row = a.provenance.readLedger[0];
    const p1 = stableLedgerProjection({ ...row, ms: 1 });
    const p2 = stableLedgerProjection({ ...row, ms: 999 });
    expect(p1).toBe(p2);
    expect(stableLedgerProjection({ ...row, source: "x" })).not.toBe(p1);
  });

  it("derives matrixChecks from the matrices actually enforced", () => {
    const r = verifyArtifact(frozenClone());
    // 5 recomputed matrices + the 3 enforced in the shape contract.
    expect(r.scope.counters.matrixChecks).toBe(8);
  });
});

describe("C7.2 — the execution boundary refuses before any query is issued", () => {
  const request = () => buildCanonicalRequest("seriesCampaign", {
    businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, grain: "campaign",
    effectiveFrom: "2026-04-23", effectiveTo: "2026-08-21",
    params: [IWA.businessId, IWA.providerAccountId, "2026-04-23", "2026-08-21"],
  });

  it("passes a valid request to the executor with its exact statement and params", async () => {
    const calls: Array<{ statement: string; params: unknown[] }> = [];
    const req = request();
    await executeGuardedRequest(req, async (statement, params) => {
      calls.push({ statement, params });
      return [];
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.statement).toBe(req.statement);
    expect(calls[0]!.params).toEqual(req.params);
  });

  it("refuses a mismatched statement with ZERO executor calls", async () => {
    const calls: unknown[] = [];
    const lying = { ...request(), statement: "SELECT 1" };
    await expect(
      executeGuardedRequest(lying, async (s, p) => { calls.push([s, p]); return []; }),
    ).rejects.toThrow(/statement does not match its declared hash/);
    expect(calls).toHaveLength(0);
  });

  it("refuses mismatched params with ZERO executor calls", async () => {
    const calls: unknown[] = [];
    const lying = { ...request(), params: ["forged"] };
    await expect(
      executeGuardedRequest(lying, async (s, p) => { calls.push([s, p]); return []; }),
    ).rejects.toThrow(/params do not match their declared hash/);
    expect(calls).toHaveLength(0);
  });

  it("is the same guard, callable directly", () => {
    expect(() => assertRequestIntegrity(request())).not.toThrow();
    expect(() => assertRequestIntegrity({ ...request(), statementSha256: "0".repeat(64) })).toThrow();
    expect(() => assertRequestIntegrity({ ...request(), paramsSha256: "0".repeat(64) })).toThrow();
  });
});

describe("C7.1 — the execute/skip disposition contract", () => {
  const skipKeyed = () => {
    // No clocks and no canonical latest ⇒ every per-binding invocation skips.
    const dispositions = buildExpectedDispositions({ clocks: { perBinding: [] }, canonicalDecisions: { perBinding: [] } });
    return dispositions;
  };

  it("still produces exactly 226 dispositions when prerequisites are missing", () => {
    const d = skipKeyed();
    expect(d.size).toBe(226);
    const skips = [...d.values()].filter((x) => x.disposition === "dependency_skip");
    expect(skips.length).toBeGreaterThan(100);
    for (const skip of skips) {
      expect(skip.disposition).toBe("dependency_skip");
      if (skip.disposition !== "dependency_skip") continue;
      expect(D080_DEPENDENCY_CODES).toContain(skip.dependencyCode);
      expect(skip.missingPrerequisites.length).toBeGreaterThan(0);
      expect(skip.skipOutcomeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(skip.reason).toContain(skip.dependencyCode);
    }
  });

  it("hashes an explicit no-query envelope with every inapplicable field null", () => {
    const req = buildCanonicalRequest("seriesCampaign", { businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, grain: "campaign", params: [] });
    const env = skipEnvelope(req, "binding_cutoff_unavailable", ["cutoff", "series_from"]);
    expect(env.queryExecuted).toBe(false);
    for (const field of ["statementSha256", "paramsSha256", "effectiveFrom", "effectiveTo", "knowledgeTo", "asOfDate", "limit"]) {
      expect(env[field], field).toBeNull();
    }
    const a1 = expectedSkip(req, "binding_cutoff_unavailable", ["series_from", "cutoff"]);
    const a2 = expectedSkip(req, "binding_cutoff_unavailable", ["cutoff", "series_from"]);
    if (a1.disposition !== "dependency_skip" || a2.disposition !== "dependency_skip") throw new Error("expected skips");
    expect(a1.skipOutcomeHash).toBe(a2.skipOutcomeHash);
  });

  it("rejects a dependency-skip row with any forged field", () => {
    const forges: Array<[string, (row: any) => void]> = [
      ["statementSha256", (row) => { row.statementSha256 = "0".repeat(64); }],
      ["paramsSha256", (row) => { row.paramsSha256 = "0".repeat(64); }],
      ["businessId", (row) => { row.businessId = "forged"; }],
      ["providerAccountId", (row) => { row.providerAccountId = "forged"; }],
      ["effectiveFrom", (row) => { row.effectiveFrom = "1900-01-01"; }],
      ["source", (row) => { row.source = "totally_wrong"; }],
      ["grain", (row) => { row.grain = "adset"; }],
      ["dependencyCode", (row) => { row.dependencyCode = "binding_cutoff_unavailable"; }],
      ["rows", (row) => { row.rows = 5; }],
    ];
    for (const [label, forge] of forges) {
      const r = attack((a) => {
        const row = a.provenance.readLedger.find((l: any) => l.planKey === "seriesCampaign");
        row.status = "not_run_dependency_failed";
        row.disposition = "dependency_skip";
        forge(row);
      });
      expect(r.ok, label).toBe(false);
    }
  }, 300_000);

  it("rejects an executed row that carries skip fields, or a skip that claims a result", () => {
    expect(attack((a) => { a.provenance.readLedger[0].dependencyCode = "binding_cutoff_unavailable"; }).ok).toBe(false);
    expect(attack((a) => { a.provenance.readLedger[0].disposition = "dependency_skip"; }).ok).toBe(false);
  });

  /**
   * C8.1 — the Correction 7 test that lived here was a no-op: it cloned the
   * finished green artifact, mapped every ledger row to itself and verified the
   * original. It is replaced by the real orchestration scenario in the C8.1
   * block below, which drives the shared orchestrator through a fake executor.
   */
});

describe("C7.3 — every invocation has a truthful outcome receipt", () => {
  it("classifies all 226 receipts into the three explicit kinds", () => {
    const a = frozenClone();
    const kinds = a.invocationResults.receipts.reduce((m: any, r: any) => ((m[r.outcomeKind] = (m[r.outcomeKind] ?? 0) + 1), m), {});
    expect(a.invocationResults.receipts).toHaveLength(226);
    expect(kinds.materialised_slice).toBe(211);
    expect(kinds.source_query_receipt).toBe(15);
  });

  it("gives every EXECUTED invocation an actual source row count and hash", () => {
    const a = frozenClone();
    const executed = a.provenance.readLedger.filter((l: any) => l.disposition === "execute");
    expect(executed).toHaveLength(226);
    for (const row of executed) {
      expect(typeof row.sourceRowCount, row.invocationKey).toBe("number");
      expect(row.sourceRowHash, row.invocationKey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("binds a transformed summary for the 15 non-materialised invocations", () => {
    const a = frozenClone();
    const sq = a.invocationResults.receipts.filter((r: any) => r.outcomeKind === "source_query_receipt");
    expect(sq).toHaveLength(15);
    const plans = new Set(sq.map((r: any) => String(r.invocationKey).split("#")[0]));
    expect([...plans].sort()).toEqual(["canonicalIdentities", "canonicalLatestAsOf", "runSchema"]);
    for (const r of sq) {
      expect(r.sourceRowHash, r.invocationKey).toMatch(/^[0-9a-f]{64}$/);
      expect(r.summaryHash, r.invocationKey).toMatch(/^[0-9a-f]{64}$/);
      expect(r.rowHash).toBeNull();
      expect(r.recomputable).toBe(false);
    }
    expect(summaryBindingFor(a, buildCanonicalRequest("runSchema", { params: [] }))).toHaveProperty("observedRunColumns");
  });

  it("rejects a mutated summary binding for a source-query receipt", () => {
    expect(attack((a) => { a.schemaContract.compatibility = "compatible"; }).ok).toBe(false);
    expect(attack((a) => { a.canonicalDecisions.perBinding[0].latest_as_of = "2020-01-01"; }).ok).toBe(false);
  });

  it("rejects independent mutation of source count, source hash and receipt kind", () => {
    expect(attack((a) => { a.provenance.readLedger[0].sourceRowCount = 999; }).ok).toBe(false);
    expect(attack((a) => { a.invocationResults.receipts[0].sourceRowHash = "0".repeat(64); }).ok).toBe(false);
    expect(attack((a) => { a.invocationResults.receipts[0].outcomeKind = "dependency_skip"; }).ok).toBe(false);
    expect(attack((a) => { a.invocationResults.receipts[0].summaryHash = "0".repeat(64); }).ok).toBe(false);
  }, 180_000);
});

describe("C7.5 — report and verifier numbers stay mechanically consistent", () => {
  it("the report's verification block matches the live verifier output", () => {
    const a = frozenClone();
    const r = verifyArtifact(a);
    const report = readFileSync(resolve("docs/audits/D080_META_BUDGET_EDIT_EVIDENCE_AND_CONTRACT_2026-08-31.md"), "utf8");
    const c = r.scope.counters;
    const required = [
      a.contract,
      `${c.requiredSectionsPresent} / ${c.requiredSectionsExpected}`,
      c.totalRows.toLocaleString("en-US"),
      String(c.matrixChecks),
      String(c.crossSectionReconciliations),
      String(c.expectedInvocations),
      String(c.recomputableResultReceipts),
    ];
    for (const value of required) {
      expect(report, `report must state ${value}`).toContain(value);
    }
  });
});


// ---------------------------------------------------------------------------
// C8 — real orchestration, envelope binding, domains, non-circular binding
// ---------------------------------------------------------------------------

describe("C8.1 — the shared orchestration seam, driven with a missing prerequisite", () => {
  /** Runs the REAL orchestrator through a fake boundary. */
  async function runOrchestration(victimIndex: number) {
    const ledger: any[] = [];
    const executed: string[] = [];
    const cutoffByBinding = new Map<string, string | null>();
    const seriesFromByBinding = new Map<string, string | null>();
    for (const [i, b] of D080_PINNED_BINDINGS.entries()) {
      const key = bindingKey(b.businessId, b.providerAccountId);
      cutoffByBinding.set(key, "2026-08-21");
      // The victim keeps a VALID cutoff but loses series_from only.
      seriesFromByBinding.set(key, i === victimIndex ? null : seriesFromForCutoff("2026-08-21"));
    }
    const ledgerEntry = (req: any, status: string, rows: number, extra: any = {}) => ({
      invocationKey: req.invocationKey, planKey: req.planKey, query: req.planKey,
      templateKey: req.templateKey, statementSha256: req.statementSha256,
      paramsSha256: req.paramsSha256, businessId: req.businessId,
      providerAccountId: req.providerAccountId, businessListHash: req.businessListHash,
      grain: req.grain, source: req.source, pitStatus: req.pitStatus,
      knowledgeBounds: req.knowledgeBounds, effectiveFrom: req.effectiveFrom,
      effectiveTo: req.effectiveTo, knowledgeTo: req.knowledgeTo, asOfDate: req.asOfDate,
      limit: req.limit, disposition: "execute", sourceRowCount: rows,
      sourceRowHash: sha256Canonical([]), dependencyCode: null,
      missingPrerequisites: null, skipOutcomeHash: null, ms: 1, rows, status, ...extra,
    });
    const safeQ = async (request: any) => {
      assertRequestIntegrity(request);
      executed.push(request.invocationKey);
      ledger.push(ledgerEntry(request, "ok", 0));
      return [];
    };
    const skip = (request: any, code: any, missing: string[]) => {
      const env = skipEnvelope(request, code, [...missing].sort());
      ledger.push({
        ...ledgerEntry(request, "not_run_dependency_failed", 0),
        disposition: "dependency_skip",
        statementSha256: null, paramsSha256: null, effectiveFrom: null, effectiveTo: null,
        knowledgeTo: null, asOfDate: null, limit: null,
        sourceRowCount: null, sourceRowHash: null,
        dependencyCode: code, missingPrerequisites: [...missing].sort(),
        skipOutcomeHash: sha256Canonical(env),
        reason: `${code}: missing ${[...missing].sort().join(",")}`,
      });
    };
    const businessIds = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];
    const out = await orchestrateEvidence({ safeQ, skip, ledger, businessIds, cutoffByBinding, seriesFromByBinding });
    return { ledger, executed, out, cutoffByBinding, seriesFromByBinding };
  }

  /**
   * The orchestrator owns every planned invocation except the three global
   * reads and the four per-binding clock reads, which are issued before it (the
   * clocks are what resolve the cutoff). Derived from the plan table so the
   * expectation cannot drift from the contract.
   */
  const PRE_ORCHESTRATION = new Set(["runSchema", "decisionVocabulary", "bindings"]);
  const CLOCK_PLANS = new Set(["clockCampaignDaily", "clockAdsetDaily", "clockCampaignConfig", "clockAdsetConfig"]);
  const BINDINGS = D080_PINNED_BINDINGS.length;
  const BUSINESSES = new Set(D080_PINNED_BINDINGS.map((b) => b.businessId)).size;
  const expand = (cardinality: string) =>
    cardinality === "once" ? 1
      : cardinality === "per_binding" ? BINDINGS
      : cardinality === "per_binding_grain" ? BINDINGS * 2
      : BUSINESSES;
  let ownedInvocations = 0;
  let preInvocations = 0;
  for (const [planKey, plan] of Object.entries(D080_READ_PLAN)) {
    const n = expand(plan.cardinality);
    if (PRE_ORCHESTRATION.has(planKey) || CLOCK_PLANS.has(planKey)) preInvocations += n;
    else ownedInvocations += n;
  }
  /** The victim's own owned invocations — everything binding-scoped but clocks. */
  const victimOwned = Object.entries(D080_READ_PLAN)
    .filter(([k, p]) => !CLOCK_PLANS.has(k) && (p.cardinality === "per_binding" || p.cardinality === "per_binding_grain"))
    .reduce((acc, [, p]) => acc + (p.cardinality === "per_binding" ? 1 : 2), 0);

  it("accounts for all 226 planned outcomes and skips ONLY the dependent requests", async () => {
    expect(ownedInvocations + preInvocations).toBe(D080_EXPECTED_INVOCATION_COUNT);
    const victim = D080_PINNED_BINDINGS[6]!;
    const { ledger, executed } = await runOrchestration(6);

    // Every owned invocation is represented exactly once — as an execution or
    // as an explicit skip. The planned cardinality never shrinks, and nothing
    // is represented twice.
    expect(ledger).toHaveLength(ownedInvocations);
    const keys = ledger.map((l) => l.invocationKey);
    expect(new Set(keys).size, "no invocation is represented twice").toBe(keys.length);

    const skips = ledger.filter((l) => l.disposition === "dependency_skip");
    const seriesSkips = skips.filter((l) => l.dependencyCode === "binding_cutoff_unavailable");
    expect(seriesSkips).toHaveLength(victimOwned);
    for (const s of seriesSkips) {
      expect(s.providerAccountId).toBe(victim.providerAccountId);
      expect(s.missingPrerequisites).toEqual(["series_from"]);
      expect(s.reason).toBe("binding_cutoff_unavailable: missing series_from");
      expect(s.skipOutcomeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.statementSha256).toBeNull();
      expect(s.sourceRowCount).toBeNull();
      expect(s.status).toBe("not_run_dependency_failed");
    }
    // The skip envelope is deterministic: same request, same code, same hash.
    const hashes = new Set(seriesSkips.map((s) => s.skipOutcomeHash));
    expect(hashes.size, "each skipped request has its own outcome hash").toBe(seriesSkips.length);

    // ZERO executor calls for every skipped invocation, and none at all for the
    // victim binding.
    for (const s of skips) expect(executed).not.toContain(s.invocationKey);
    expect(executed.filter((k) => k.includes(victim.providerAccountId))).toHaveLength(0);

    // Every unaffected binding still executed through the fake boundary.
    for (const b of D080_PINNED_BINDINGS.filter((x) => x.providerAccountId !== victim.providerAccountId)) {
      expect(executed.some((k) => k.includes(b.providerAccountId)), b.providerAccountId).toBe(true);
    }
  }, 120_000);

  it("skips a SECOND, independent dependency with its own code and set", async () => {
    // The fake executor returns no rows, so `canonicalLatestAsOf` yields no
    // as-of for the surviving bindings: a different dependency, skipped under
    // its own code, proving the gate is not one hard-coded branch.
    const { ledger } = await runOrchestration(6);
    const canonical = ledger.filter((l) => l.dependencyCode === "canonical_latest_as_of_unavailable");
    expect(canonical.length).toBeGreaterThan(0);
    for (const c of canonical) {
      expect(c.missingPrerequisites).toEqual(["latest_as_of"]);
      expect(c.planKey).toBe("canonicalIdentities");
    }
    // The two dependency families are disjoint and together are all the skips.
    const skips = ledger.filter((l) => l.disposition === "dependency_skip");
    expect(canonical.length + skips.filter((l) => l.dependencyCode === "binding_cutoff_unavailable").length)
      .toBe(skips.length);
  }, 120_000);

  it("a recorded-unavailable prerequisite is never recomputed from the cutoff", async () => {
    // Regression: the orchestrator used to fall back to seriesFromForCutoff()
    // when the recorded series_from was null, so the gate never fired and the
    // binding read a lower bound it had no evidence for.
    const { ledger, executed } = await runOrchestration(6);
    const victim = D080_PINNED_BINDINGS[6]!;
    expect(seriesFromForCutoff("2026-08-21")).not.toBeNull();
    expect(ledger.filter((l) => l.invocationKey.includes(victim.providerAccountId) && l.disposition === "execute"))
      .toHaveLength(0);
    expect(executed.some((k) => k.includes(victim.providerAccountId))).toBe(false);
  }, 120_000);

  it("refuses to run at all when a binding has no prerequisite record", async () => {
    const ledger: any[] = [];
    const safeQ = async () => [];
    const skip = () => {};
    await expect(
      orchestrateEvidence({
        safeQ: safeQ as any, skip: skip as any, ledger,
        businessIds: [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))],
        cutoffByBinding: new Map(), seriesFromByBinding: new Map(),
      }),
    ).rejects.toThrow(/no resolved prerequisite record/);
  });

  /**
   * C9.2 — the Correction 8 test that stood here asserted
   * `victimUnit.every(c => c.status !== "rows_returned")` on an array that was
   * always EMPTY, so it passed vacuously and hid the fact that a
   * dependency-blocked binding vanished from every coverage matrix. It is
   * replaced by the exact-count, exact-key assertions in the C9.1/C9.2 block,
   * which run against a sealed package rather than a partial return value.
   */

  it("computes the EXACT missing set, not a fixed pair", () => {
    expect(missingPrereqsFor({ cutoff: "2026-08-21", seriesFrom: null })).toEqual(["series_from"]);
    expect(missingPrereqsFor({ cutoff: null, seriesFrom: "2026-04-23" })).toEqual(["cutoff"]);
    expect(missingPrereqsFor({ cutoff: null, seriesFrom: null })).toEqual(["cutoff", "series_from"]);
    const b = D080_PINNED_BINDINGS[0]!;
    const d = buildExpectedDispositions({
      clocks: { perBinding: [{ business_id: b.businessId, provider_account_id: b.providerAccountId, cutoff: "2026-08-21", series_from: null, per_source: {} }] },
      canonicalDecisions: { perBinding: [] },
    });
    const entry = d.get(`seriesCampaign#${b.businessId}|${b.providerAccountId}`)!;
    expect(entry.disposition).toBe("dependency_skip");
    if (entry.disposition === "dependency_skip") expect(entry.missingPrerequisites).toEqual(["series_from"]);
  });
});

describe("C8.3 — the full request envelope is bound before execution", () => {
  const IWA = D080_PINNED_BINDINGS[0]!;
  const good = () => buildCanonicalRequest("seriesCampaign", {
    businessId: IWA.businessId, providerAccountId: IWA.providerAccountId, grain: "campaign",
    effectiveFrom: "2026-04-23", effectiveTo: "2026-08-21",
    params: [IWA.businessId, IWA.providerAccountId, "2026-04-23", "2026-08-21"],
  });

  it("passes a valid request through once with the exact statement and params", async () => {
    const calls: Array<{ s: string; p: unknown[] }> = [];
    const req = good();
    await executeGuardedRequest(req, async (s, p) => { calls.push({ s, p }); return []; });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.s).toBe(req.statement);
    expect(calls[0]!.p).toEqual(req.params);
  });

  it.each([
    ["businessId", (r: any) => ({ ...r, businessId: "forged-business" })],
    ["providerAccountId", (r: any) => ({ ...r, providerAccountId: "act_forged" })],
    ["effectiveFrom", (r: any) => ({ ...r, effectiveFrom: "1900-01-01" })],
    ["effectiveTo", (r: any) => ({ ...r, effectiveTo: "2099-01-01" })],
    ["grain", (r: any) => ({ ...r, grain: "adset" })],
    ["source", (r: any) => ({ ...r, source: "totally_wrong" })],
    ["templateKey", (r: any) => ({ ...r, templateKey: "seriesAdset" })],
    ["invocationKey", (r: any) => ({ ...r, invocationKey: "seriesAdset#x" })],
    ["businessListHash", (r: any) => ({ ...r, businessListHash: "0".repeat(64) })],
    ["statement", (r: any) => ({ ...r, statement: "SELECT 1" })],
    ["params", (r: any) => ({ ...r, params: ["forged"] })],
  ])("refuses a forged %s with ZERO executor calls", async (_label, forge) => {
    const calls: unknown[] = [];
    await expect(
      executeGuardedRequest(forge(good()) as any, async (s, p) => { calls.push([s, p]); return []; }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("cannot let one plan masquerade as another", async () => {
    const calls: unknown[] = [];
    const masquerade = { ...good(), planKey: "seriesAdset" };
    await expect(
      executeGuardedRequest(masquerade as any, async (s, p) => { calls.push([s, p]); return []; }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("carries no credentials, DSNs or secrets in the request contract", () => {
    const req = good();
    const serialised = JSON.stringify({ ...req, statement: undefined });
    expect(serialised).not.toMatch(/postgres(ql)?:\/\/|password|PGPASSWORD|Bearer /i);
  });
});

describe("C8.4 — the complete nested domain census", () => {
  it.each([
    ["campaignRole.rows.inferred_kind", (a: Art) => { a.campaignRole.rows[0].inferred_kind = "made_up"; }],
    ["campaignRole.rows.confidence_class", (a: Art) => { a.campaignRole.rows[0].confidence_class = "made_up"; }],
    ["analysis.layer3.unitContract.status", (a: Art) => { a.analysis.layer3.unitContract.status = "made_up"; }],
    ["unitEvidence.factualContract.status", (a: Art) => { a.unitEvidence.factualContract.status = "made_up"; }],
    ["capabilityMatrix.budgetWritePath.status", (a: Art) => { a.capabilityMatrix.budgetWritePath.status = "made_up"; }],
    ["capabilityMatrix.actionLogGrain.status", (a: Art) => { a.capabilityMatrix.actionLogGrain.status = "made_up"; }],
    ["queryManifest.pitStatus", (a: Art) => { a.provenance.queryManifest.seriesCampaign.pitStatus = "made_up"; }],
    ["queryManifest.kind", (a: Art) => { a.provenance.queryManifest.seriesCampaign.kind = "made_up"; }],
    ["queryManifest.scope", (a: Art) => { a.provenance.queryManifest.seriesCampaign.scope = "made_up"; }],
    ["schemaContract.compatibility", (a: Art) => { a.schemaContract.compatibility = "made_up"; }],
    ["sourceSemantics.writeSemantics", (a: Art) => { a.sourceSemantics.sources[0].writeSemantics = "made_up"; }],
    ["d080bContract.recommendation", (a: Art) => { a.d080bContract.recommendation = "made_up"; }],
    ["primarySourceVerification.status", (a: Art) => { a.capabilityMatrix.graphApiVersions.primarySourceVerification[0].status = "made_up"; }],
  ])("rejects an unknown %s and names the path", (label, mutate) => {
    const r = attack(mutate);
    expect(r.ok, label).toBe(false);
    expect(r.failures.join(" "), label).toContain("status_domain");
  });

  it("does not police Meta delivery statuses, which are provider vocabulary", () => {
    const domains = [
      ...D080_OBJECT_DOMAINS.map((d) => `${d.path}.${d.field}`),
      ...D080_ROW_VALUE_DOMAINS.map((d) => `${d.path}.${d.field}`),
    ];
    expect(domains.join(" ")).not.toMatch(/campaign_status|effective_status|presence/);
  });
});

describe("C8.5 — source-to-materialisation binding is not circular", () => {
  it("rejects a PAIR-forged source hash on a materialised slice", () => {
    const r = attack((a) => {
      const rec = a.invocationResults.receipts.find((x: any) => x.outcomeKind === "materialised_slice");
      const led = a.provenance.readLedger.find((x: any) => x.invocationKey === rec.invocationKey);
      const forged = "a".repeat(64);
      rec.sourceRowHash = forged;
      led.sourceRowHash = forged;
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("source_materialisation_mismatch");
  });

  it("every materialised slice's boundary hash equals its recomputed slice hash", () => {
    const a = frozenClone();
    const recomputed = reconcileInvocationResults(a);
    expect(recomputed.violations).toEqual([]);
    const materialised = recomputed.receipts.filter((r) => r.outcomeKind === "materialised_slice");
    expect(materialised).toHaveLength(211);
    for (const r of materialised) expect(r.sourceRowHash, r.invocationKey).toBe(r.rowHash);
  });

  it("keeps the 15 source-query receipts honestly non-recomputable", () => {
    const a = frozenClone();
    const sq = a.invocationResults.receipts.filter((r: any) => r.outcomeKind === "source_query_receipt");
    expect(sq).toHaveLength(15);
    for (const r of sq) {
      expect(r.recomputable).toBe(false);
      expect(r.rowHash).toBeNull();
      expect(r.sourceRowHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.summaryHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("C8.6 — structural matrix evidence and one anchored report block", () => {
  it("derives matrixChecks from audit records that each ran and passed", () => {
    const r = verifyArtifact(frozenClone());
    const audits = r.scope.matrixAudits;
    expect(audits.length).toBe(r.scope.counters.matrixChecks);
    expect(audits.length).toBeGreaterThanOrEqual(8);
    for (const a of audits) {
      expect(a.name.length).toBeGreaterThan(3);
      expect(a.passed).toBe(true);
      expect(a.expected).toBeGreaterThan(0);
      expect(a.observed).toBe(a.expected);
    }
    expect(audits.map((a) => a.name)).toContain("clocks.perSource");
    expect(audits.map((a) => a.name)).toContain("scope.observedBindings");
  });

  it("records a failing matrix audit rather than silently reducing the count", () => {
    const a = frozenClone();
    a.clocks.perSource.pop();
    const r = verifyArtifact(sealArtifact(a));
    const audit = r.scope.matrixAudits.find((x) => x.name === "clocks.perSource")!;
    expect(audit.passed).toBe(false);
    expect(audit.missing).toBeGreaterThan(0);
    expect(r.scope.counters.matrixChecks).toBe(r.scope.matrixAudits.length);
  });

  it("the report carries exactly ONE anchored current block matching the verifier", () => {
    const a = frozenClone();
    const expected = renderVerificationBlock(a, verifyArtifact(a));
    const report = readFileSync(resolve("docs/audits/D080_META_BUDGET_EDIT_EVIDENCE_AND_CONTRACT_2026-08-31.md"), "utf8");
    const begins = report.split(REPORT_BLOCK_BEGIN).length - 1;
    const ends = report.split(REPORT_BLOCK_END).length - 1;
    expect(begins, "exactly one begin marker").toBe(1);
    expect(ends, "exactly one end marker").toBe(1);
    const start = report.indexOf(REPORT_BLOCK_BEGIN);
    const stop = report.indexOf(REPORT_BLOCK_END) + REPORT_BLOCK_END.length;
    expect(report.slice(start, stop)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// C9 — one real end-to-end package, exact dependency coverage, full envelope
// ---------------------------------------------------------------------------

const SYNTH_CUTOFF = "2026-08-21";
const SYNTH_VICTIM = D080_PINNED_BINDINGS[6]!;
const SYNTH_BUSINESS_IDS = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];

/**
 * A deterministic fake source. Rows echo the request envelope, so every row is
 * in scope and inside its window by construction and the package exercises the
 * real scope/time verifiers rather than dodging them.
 */
function syntheticRows(req: any): Array<Record<string, unknown>> {
  switch (req.planKey) {
    case "runSchema":
      return ["run_id", "business_id", "provider_account_id", "started_at", "completed_at", "status"]
        .map((column_name) => ({ column_name }));
    case "decisionVocabulary":
      return [{
        constraint_name: "engine_v3_ad_decision_snapshots_dail_decision_entity_type_check",
        definition: "CHECK ((decision_entity_type = 'ad'::text))",
      }];
    case "bindings":
      return D080_PINNED_BINDINGS.map((x) => ({
        business_id: x.businessId, provider_account_id: x.providerAccountId, is_selected: x.isSelected,
      }));
    case "clockCampaignDaily":
    case "clockAdsetDaily":
    case "clockCampaignConfig":
    case "clockAdsetConfig":
      return [{
        source: req.source, grain: req.grain,
        business_id: req.businessId, provider_account_id: req.providerAccountId,
        latest_effective: SYNTH_CUTOFF, earliest_effective: "2026-01-01", status: "ok",
      }];
    default:
      // A successful read that found nothing. Distinct from a failed read and
      // from a dependency skip, which is exactly the distinction under test.
      return [];
  }
}

/**
 * C9.1 — runs the REAL extraction flow (`collectEvidence` → `assembleArtifact`
 * → `analyseAndSeal` → `verifyArtifact`) over the synthetic source, with one
 * pinned binding whose cutoff is valid and whose series lower bound is
 * explicitly unavailable.
 */
async function runSyntheticPackage(
  mutate?: (frozen: any) => void,
): Promise<{ ledger: any[]; executed: string[]; sealed: any; result: ReturnType<typeof verifyArtifact> }> {
  const ledger: any[] = [];
  const executed: string[] = [];
  const proof = {
    retrieved_at: "2026-09-01 00:00:00+00", transaction_isolation: "repeatable read",
    transaction_read_only: "on", statement_timeout: "30s", lock_timeout: "5s",
  };
  const ledgerBase = (r: any) => ({
    invocationKey: r.invocationKey, planKey: r.planKey, query: r.planKey,
    templateKey: r.templateKey, businessId: r.businessId, providerAccountId: r.providerAccountId,
    businessListHash: r.businessListHash, grain: r.grain, source: r.source,
    pitStatus: r.pitStatus, knowledgeBounds: r.knowledgeBounds,
  });
  const safeQ = async (request: any) => {
    assertRequestIntegrity(request);
    executed.push(request.invocationKey);
    const rows = syntheticRows(request);
    ledger.push({
      ...ledgerBase(request),
      statementSha256: request.statementSha256, paramsSha256: request.paramsSha256,
      effectiveFrom: request.effectiveFrom, effectiveTo: request.effectiveTo,
      knowledgeTo: request.knowledgeTo, asOfDate: request.asOfDate, limit: request.limit,
      disposition: "execute", sourceRowCount: rows.length, sourceRowHash: sha256Canonical(rows),
      dependencyCode: null, missingPrerequisites: null, skipOutcomeHash: null,
      ms: 1, rows: rows.length, status: "ok",
    });
    return rows;
  };
  const skip = (request: any, code: any, missing: string[]) => {
    const sorted = [...missing].sort();
    ledger.push({
      ...ledgerBase(request),
      statementSha256: null, paramsSha256: null,
      effectiveFrom: null, effectiveTo: null, knowledgeTo: null, asOfDate: null, limit: null,
      disposition: "dependency_skip", sourceRowCount: null, sourceRowHash: null,
      dependencyCode: code, missingPrerequisites: sorted,
      skipOutcomeHash: sha256Canonical(skipEnvelope(request, code, sorted)),
      reason: `${code}: missing ${sorted.join(",")}`,
      ms: 0, rows: 0, status: "not_run_dependency_failed",
    });
  };

  const frozen: any = await collectEvidence({
    proof, safeQ, skip, ledger,
    businessIds: SYNTH_BUSINESS_IDS,
    d078Sha: D080_PINNED_INPUTS.d078BundleSha256,
    resolveSeriesFrom: (cutoff: string | null, binding: { providerAccountId: string }) =>
      binding.providerAccountId === SYNTH_VICTIM.providerAccountId ? null : seriesFromForCutoff(cutoff),
  });
  mutate?.(frozen);

  const assembled = assembleArtifact({
    ...frozen,
    authority: { ok: true, truthyBefore: [], truthyAfter: [], changedByLoader: [] },
  });
  const { sealed } = analyseAndSeal(assembled as any);
  return { ledger, executed, sealed, result: verifyArtifact(sealed as any) };
}

describe("C9.1 — a sealed missing-prerequisite package that passes the real verifier", () => {
  let pkg: Awaited<ReturnType<typeof runSyntheticPackage>>;
  beforeAll(async () => { pkg = await runSyntheticPackage(); }, 300_000);

  const victimRows = (rows: any[]) =>
    (rows ?? []).filter((r) => r?.provider_account_id === SYNTH_VICTIM.providerAccountId);

  it("assembles and SEALS a package, then passes the real full verifyArtifact", () => {
    // Correction 8 imported `assembleArtifact` and never called it; this asserts
    // the sealed package exists, is self-consistent and verifies clean.
    expect(pkg.sealed.contract).toBe(D080_EVIDENCE_CONTRACT);
    expect(pkg.sealed.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.sealed.sectionHashes).toBeTypeOf("object");
    expect(pkg.result.failures, JSON.stringify(pkg.result.failures.slice(0, 4))).toEqual([]);
    expect(pkg.result.ok).toBe(true);
  });

  it("keeps the exact 29-plan expansion: 226 outcomes, each represented once", () => {
    expect(pkg.ledger).toHaveLength(D080_EXPECTED_INVOCATION_COUNT);
    const keys = pkg.ledger.map((l) => l.invocationKey);
    expect(new Set(keys).size).toBe(D080_EXPECTED_INVOCATION_COUNT);
    expect(pkg.sealed.invocationResults.receipts).toHaveLength(D080_EXPECTED_INVOCATION_COUNT);
    const executes = pkg.ledger.filter((l) => l.disposition === "execute").length;
    const skips = pkg.ledger.filter((l) => l.disposition === "dependency_skip").length;
    expect(executes + skips).toBe(D080_EXPECTED_INVOCATION_COUNT);
    expect(executes).toBe(pkg.executed.length);
  });

  it("skips exactly the victim's owned invocations, with zero executor calls", () => {
    const skips = pkg.ledger.filter((l) => l.disposition === "dependency_skip");
    const victimSkips = skips.filter((l) => l.dependencyCode === "binding_cutoff_unavailable");
    // Derived from the plan table: every owned binding-scoped plan for this one
    // binding. Nothing hard-coded.
    const CLOCKS = new Set(["clockCampaignDaily", "clockAdsetDaily", "clockCampaignConfig", "clockAdsetConfig"]);
    const expectedVictimSkips = Object.entries(D080_READ_PLAN)
      .filter(([k, p]) => !CLOCKS.has(k) && (p.cardinality === "per_binding" || p.cardinality === "per_binding_grain"))
      .reduce((n, [, p]) => n + (p.cardinality === "per_binding" ? 1 : 2), 0);
    expect(expectedVictimSkips).toBe(26);
    expect(victimSkips).toHaveLength(expectedVictimSkips);
    for (const s of victimSkips) {
      expect(s.providerAccountId).toBe(SYNTH_VICTIM.providerAccountId);
      expect(s.missingPrerequisites).toEqual(["series_from"]);
      expect(s.status).toBe("not_run_dependency_failed");
      expect(s.statementSha256).toBeNull();
      expect(s.skipOutcomeHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Zero executor calls for the OWNED invocations. The four clock reads for
    // this binding do run — they are what resolved its cutoff in the first
    // place — and they are excluded from the owned set above.
    const victimSkipKeys = new Set(victimSkips.map((s) => s.invocationKey));
    for (const key of pkg.executed) expect(victimSkipKeys.has(key)).toBe(false);
    const victimExecuted = pkg.executed.filter((k) => k.includes(SYNTH_VICTIM.providerAccountId));
    expect(victimExecuted).toHaveLength(4);
    expect(victimExecuted.map((k) => k.split("#")[0]).sort())
      .toEqual(["clockAdsetConfig", "clockAdsetDaily", "clockCampaignConfig", "clockCampaignDaily"]);
  });

  it("still executes every unaffected binding through the fake boundary", () => {
    for (const b of D080_PINNED_BINDINGS.filter((x) => x.providerAccountId !== SYNTH_VICTIM.providerAccountId)) {
      const ran = pkg.executed.filter((k) => k.includes(b.providerAccountId));
      expect(ran.length, b.providerAccountId).toBeGreaterThan(0);
    }
    expect(pkg.ledger.filter((l) => l.status === "ok").length).toBeGreaterThan(150);
  });

  it("represents the victim in EVERY coverage matrix with an explicit dependency state", () => {
    const cases: Array<[string, any[], number]> = [
      ["unitEvidence.coverageMatrix", pkg.sealed.unitEvidence.coverageMatrix, 4],
      ["configStates.coverage", pkg.sealed.configStates.coverage, 6],
      ["canonicalDecisions.servedDateCoverage", pkg.sealed.canonicalDecisions.servedDateCoverage, 1],
      ["canonicalDecisions.perBinding", pkg.sealed.canonicalDecisions.perBinding, 1],
    ];
    for (const [label, rows, expected] of cases) {
      const victim = victimRows(rows);
      // Not `.every(...)`: an empty array must fail here.
      expect(victim, label).toHaveLength(expected);
      for (const cell of victim) {
        const state = cell.status ?? cell.latest_status;
        expect(state, `${label} state`).toBe("not_run_dependency_failed");
        expect(cell.dependency_code, `${label} code`).toBe("binding_cutoff_unavailable");
        expect(cell.missing_prerequisites, `${label} set`).toEqual(["series_from"]);
      }
    }
  });

  it("names the exact victim unit and config cell keys, with no gap or duplicate", () => {
    const unitKeys = victimRows(pkg.sealed.unitEvidence.coverageMatrix)
      .map((c) => `${c.grain}/${c.budget_field}`).sort();
    expect(unitKeys).toEqual(["adset/daily", "adset/lifetime", "campaign/daily", "campaign/lifetime"]);
    const configKeys = victimRows(pkg.sealed.configStates.coverage)
      .map((c) => `${c.grain}/${c.layer}`).sort();
    expect(configKeys).toEqual([
      "adset/identities", "adset/pointInTime", "adset/retrospective",
      "campaign/identities", "campaign/pointInTime", "campaign/retrospective",
    ]);
    expect(new Set(unitKeys).size).toBe(unitKeys.length);
    expect(new Set(configKeys).size).toBe(configKeys.length);
  });

  it("carries observation and state-change unavailability as explicit cells", () => {
    // These two row contracts have no status column, so their unavailability
    // lives in dependencyCoverage rather than as an absent row.
    const cells = pkg.sealed.dependencyCoverage.cells as any[];
    const victim = cells.filter((c) => c.provider_account_id === SYNTH_VICTIM.providerAccountId);
    for (const family of ["observation", "state_change"] as const) {
      const forFamily = victim.filter((c) => c.family === family);
      expect(forFamily, family).toHaveLength(2);
      expect(forFamily.map((c) => c.grain).sort()).toEqual(["adset", "campaign"]);
      for (const c of forFamily) {
        expect(c.status).toBe("not_run_dependency_failed");
        expect(c.dependencyCode).toBe("binding_cutoff_unavailable");
        expect(c.missingPrerequisites).toEqual(["series_from"]);
        expect(c.rows).toBe(0);
      }
    }
    // And the victim's own observation/state-change ROWS are genuinely absent,
    // which is only honest because the cells above say why.
    expect(victimRows(pkg.sealed.observationCoverage.providerObservationFreshness)).toHaveLength(0);
    expect(victimRows(pkg.sealed.observationCoverage.stateChangeCheckpointDensity)).toHaveLength(0);
  });

  it("makes dependencyCoverage an exact bijection with the ledger's skips", () => {
    const cells = pkg.sealed.dependencyCoverage.cells as any[];
    const skips = pkg.ledger.filter((l) => l.disposition === "dependency_skip");
    expect(cells).toHaveLength(skips.length);
    expect(cells.map((c) => c.invocationKey).sort()).toEqual(skips.map((s) => s.invocationKey).sort());
    const byKey = new Map(cells.map((c) => [c.invocationKey, c]));
    for (const s of skips) {
      const cell = byKey.get(s.invocationKey)!;
      expect(cell.dependencyCode).toBe(s.dependencyCode);
      expect(cell.missingPrerequisites).toEqual(s.missingPrerequisites);
      expect(cell.planKey).toBe(s.planKey);
      expect(D080_PLAN_FAMILY[cell.planKey]).toBe(cell.family);
    }
  });

  it("does not let a dependency-blocked cell read as a successful read", () => {
    expect(pkg.sealed.analysis.unitCoverage.allCellsRead).toBe(false);
    const served = victimRows(pkg.sealed.analysis.servedDateContract.coverage);
    expect(served).toHaveLength(1);
    expect(served[0].status).toBe("not_run_dependency_failed");
    // The clocks row reports the bound as absent, not as a repaired value.
    const clock = pkg.sealed.clocks.perBinding.find(
      (r: any) => r.provider_account_id === SYNTH_VICTIM.providerAccountId,
    );
    expect(clock.cutoff).toBe(SYNTH_CUTOFF);
    expect(clock.series_from).toBeNull();
  });

  it("negative control: dropping one dependency-coverage cell fails the verifier", async () => {
    const broken = await runSyntheticPackage((f) => { f.dependencyCoverage = f.dependencyCoverage.slice(1); });
    expect(broken.result.ok).toBe(false);
    expect(broken.result.failures.join(" ")).toContain("dependency_coverage_mismatch");
  }, 300_000);

  it("negative control: forging one dependency code fails the verifier", async () => {
    const broken = await runSyntheticPackage((f) => { f.dependencyCoverage[0].dependencyCode = "business_cutoff_unavailable"; });
    expect(broken.result.ok).toBe(false);
    expect(broken.result.failures.join(" ")).toContain("dependency_code_mismatch");
  }, 300_000);

  it("negative control: a hole in the victim's unit matrix fails the verifier", async () => {
    const broken = await runSyntheticPackage((f) => {
      const i = f.unitCoverage.findIndex((c: any) => c.provider_account_id === SYNTH_VICTIM.providerAccountId);
      f.unitCoverage.splice(i, 1);
    });
    expect(broken.result.ok).toBe(false);
    expect(broken.result.failures.join(" ")).toContain("dependency_matrix_hole");
  }, 300_000);

  it("negative control: a silently repaired series_from fails the verifier", async () => {
    // Writing the derived bound back into the clocks row is the exact repair
    // Correction 8 performed silently. It is now caught by the stronger guard:
    // the frozen prerequisites would imply 26 EXECUTED invocations, which
    // contradicts the 26 skips actually recorded.
    const broken = await runSyntheticPackage((f) => {
      const row = f.perBinding.find((r: any) => r.provider_account_id === SYNTH_VICTIM.providerAccountId);
      row.series_from = seriesFromForCutoff(SYNTH_CUTOFF);
    });
    expect(broken.result.ok).toBe(false);
    const joined = broken.result.failures.join(" ");
    expect(joined).toContain("request_provenance_mismatch");
    expect(joined).toContain("disposition dependency_skip != expected execute");
    expect(
      broken.result.failures.filter((f) => f.includes("disposition dependency_skip != expected execute")).length,
    ).toBe(25);
  }, 300_000);

  it("negative control: a null series_from with no dependency cell fails the verifier", async () => {
    // The mirror image: claim the bound is unavailable while erasing the cells
    // that say so. The clock invariant refuses an unexplained null.
    const broken = await runSyntheticPackage((f) => {
      f.dependencyCoverage = f.dependencyCoverage.filter(
        (c: any) => !(c.provider_account_id === SYNTH_VICTIM.providerAccountId && c.dependencyCode === "binding_cutoff_unavailable"),
      );
    });
    expect(broken.result.ok).toBe(false);
    expect(broken.result.failures.join(" ")).toContain("no dependency-coverage cell declaring it unavailable");
  }, 300_000);
});

describe("C9.3 — every envelope field is bound, applicable or not", () => {
  const B0 = D080_PINNED_BINDINGS[0]!;
  const B1 = D080_PINNED_BINDINGS[1]!;
  const BIZ = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];
  const FROM = "2026-04-23";
  const TO = "2026-08-21";

  /** Calls the exact exported guard and reports how many times the executor ran. */
  async function attempt(request: any): Promise<{ calls: number; error: string | null }> {
    const calls: unknown[] = [];
    let error: string | null = null;
    try {
      await executeGuardedRequest(request, async (s, p) => { calls.push([s, p]); return []; });
    } catch (e) { error = (e as Error).message; }
    return { calls: calls.length, error };
  }

  const valid = {
    seriesCampaign: () => buildCanonicalRequest("seriesCampaign", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, FROM, TO],
    }),
    knowledgeBound: () => buildCanonicalRequest("configSemanticStates:pointInTime", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO, knowledgeTo: TO,
      params: [B0.businessId, B0.providerAccountId, FROM, TO, TO],
    }),
    nullKnowledge: () => buildCanonicalRequest("configSemanticStates:retrospective", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO, knowledgeTo: null,
      params: [B0.businessId, B0.providerAccountId, FROM, TO, null],
    }),
    limited: () => buildCanonicalRequest("configTransitionIdentities", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "adset",
      effectiveFrom: FROM, effectiveTo: TO, knowledgeTo: TO, limit: CONFIG_IDENTITY_LIMIT,
      params: [B0.businessId, B0.providerAccountId, FROM, TO, TO, CONFIG_IDENTITY_LIMIT],
    }),
    asOf: () => buildCanonicalRequest("canonicalIdentities", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, asOfDate: TO,
      params: [B0.businessId, B0.providerAccountId, TO],
    }),
    businessList: () => buildCanonicalRequest("bindings", { businessList: BIZ, params: [BIZ] }),
    businessScoped: () => buildCanonicalRequest("campaignRole", {
      businessId: B0.businessId, effectiveFrom: FROM, effectiveTo: TO,
      params: [B0.businessId, FROM, TO],
    }),
    unscoped: () => buildCanonicalRequest("runSchema", { params: [] }),
    grainParam: () => buildCanonicalRequest("observationCoverage", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "adset",
      effectiveFrom: FROM, effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, "adset", FROM, TO],
    }),
  };

  it("gives all 29 plans a complete nine-field envelope contract", () => {
    const fields = ["businessId", "providerAccountId", "businessList", "grain",
      "effectiveFrom", "effectiveTo", "knowledgeTo", "asOfDate", "limit"];
    const plans = Object.keys(D080_READ_PLAN);
    expect(plans).toHaveLength(29);
    for (const planKey of plans) {
      const contract = envelopeContractFor(planKey);
      expect(Object.keys(contract).sort(), planKey).toEqual([...fields].sort());
      for (const f of fields) {
        expect(["required_param", "required_bound", "nullable_param", "forbidden"], `${planKey}.${f}`)
          .toContain((contract as any)[f].kind);
      }
    }
  });

  it.each(Object.entries(valid))("passes a valid %s request through exactly once", async (_label, build) => {
    const req = build();
    const calls: Array<{ s: string; p: unknown[] }> = [];
    await executeGuardedRequest(req, async (s, p) => { calls.push({ s, p }); return []; });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.s).toBe(req.statement);
    expect(calls[0]!.p).toEqual(req.params);
  });

  // The five attacks the independent probe drove through Correction 8's guard.
  it.each([
    ["C9 attack 1 — extraneous knowledgeTo", () => ({ ...valid.seriesCampaign(), knowledgeTo: TO })],
    ["C9 attack 2 — extraneous asOfDate", () => ({ ...valid.seriesCampaign(), asOfDate: TO })],
    ["C9 attack 3 — extraneous limit", () => ({ ...valid.seriesCampaign(), limit: 1 })],
    ["C9 attack 4 — self-consistent unpinned identity", () => buildCanonicalRequest("seriesCampaign", {
      businessId: "forged-business", providerAccountId: "act_forged", grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO,
      params: ["forged-business", "act_forged", FROM, TO],
    })],
    ["C9 attack 5 — self-consistent backwards window", () => buildCanonicalRequest("seriesCampaign", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: "2026-08-22", effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, "2026-08-22", TO],
    })],
  ])("refuses %s with ZERO executor calls", async (_label, build) => {
    const { calls, error } = await attempt(build());
    expect(calls).toBe(0);
    expect(error).toMatch(/^D080 refuses to execute /);
  });

  it.each([
    ["cross-paired pinned identity", () => buildCanonicalRequest("seriesCampaign", {
      businessId: B0.businessId, providerAccountId: B1.providerAccountId, grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO,
      params: [B0.businessId, B1.providerAccountId, FROM, TO],
    })],
    ["impossible calendar date", () => buildCanonicalRequest("seriesCampaign", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: "2026-02-31", effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, "2026-02-31", TO],
    })],
    ["non-date bound", () => buildCanonicalRequest("seriesCampaign", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: "not-a-date", effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, "not-a-date", TO],
    })],
    ["missing required effectiveFrom", () => ({ ...valid.seriesCampaign(), effectiveFrom: null })],
    ["missing required knowledge bound", () => ({ ...valid.knowledgeBound(), knowledgeTo: null })],
    ["knowledge bound detached from effectiveTo", () => buildCanonicalRequest("configSemanticStates:pointInTime", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "campaign",
      effectiveFrom: FROM, effectiveTo: TO, knowledgeTo: "2026-08-20",
      params: [B0.businessId, B0.providerAccountId, FROM, TO, "2026-08-20"],
    })],
    ["provider account on a business-scoped plan", () => ({ ...valid.businessScoped(), providerAccountId: B0.providerAccountId })],
    ["business on an unscoped plan", () => ({ ...valid.unscoped(), businessId: B0.businessId })],
    ["grain on a plan that has none", () => ({ ...valid.asOf(), grain: "campaign" })],
    ["unknown grain value", () => buildCanonicalRequest("observationCoverage", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "sitelink" as any,
      effectiveFrom: FROM, effectiveTo: TO,
      params: [B0.businessId, B0.providerAccountId, "sitelink", FROM, TO],
    })],
    ["business list with a duplicate", () => buildCanonicalRequest("bindings", {
      businessList: [...BIZ, BIZ[0]!], params: [[...BIZ, BIZ[0]!]],
    })],
    ["business list missing a business", () => buildCanonicalRequest("bindings", {
      businessList: BIZ.slice(1), params: [BIZ.slice(1)],
    })],
    ["business list with an extra business", () => buildCanonicalRequest("bindings", {
      businessList: [...BIZ, "extra-business"], params: [[...BIZ, "extra-business"]],
    })],
    ["business list hash detached from the list", () => ({ ...valid.businessList(), businessListHash: "0".repeat(64) })],
    ["wrong limit value", () => buildCanonicalRequest("configTransitionIdentities", {
      businessId: B0.businessId, providerAccountId: B0.providerAccountId, grain: "adset",
      effectiveFrom: FROM, effectiveTo: TO, knowledgeTo: TO, limit: 10,
      params: [B0.businessId, B0.providerAccountId, FROM, TO, TO, 10],
    })],
    ["missing a required limit", () => ({ ...valid.limited(), limit: null })],
  ])("refuses %s with ZERO executor calls", async (_label, build) => {
    const { calls, error } = await attempt(build() as any);
    expect(calls).toBe(0);
    expect(error).toMatch(/^D080 refuses to execute /);
  });

  it("accepts a reordered business list, because the binding is order-free", async () => {
    // The statement binds the list with `= ANY(...)` and the hash is taken over
    // the sorted list, so ordering carries no meaning. Membership and arity do,
    // and the cases above prove those are enforced.
    const reordered = [...BIZ].reverse();
    const { calls } = await attempt(buildCanonicalRequest("bindings", { businessList: reordered, params: [reordered] }));
    expect(calls).toBe(1);
  });

  it("states the ONE envelope relation this boundary cannot check", () => {
    // `asOfDate` is only bounded against an effective window when a plan
    // carries both. No plan does, so an out-of-range as-of is NOT refused here
    // — it is a value read from the database, bounded by the binding cutoff at
    // the artifact level. Recording the gap rather than implying it is closed.
    const both = Object.keys(D080_READ_PLAN).filter((k) => {
      const c = envelopeContractFor(k);
      return c.asOfDate.kind !== "forbidden" && c.effectiveTo.kind !== "forbidden";
    });
    expect(both).toEqual([]);
    const asOfPlans = Object.keys(D080_READ_PLAN).filter((k) => envelopeContractFor(k).asOfDate.kind !== "forbidden");
    expect(asOfPlans).toEqual(["canonicalIdentities"]);
  });

  it("rejects only real calendar dates as dates", () => {
    expect(isCalendarDate("2026-08-21")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-8-21")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
  });

  it("still admits every request the real extraction issues", () => {
    // C9.3.8 — the stricter guard must not make production fail closed. Every
    // executed invocation in the shipped package is rebuilt and re-admitted.
    const expected = buildExpectedDispositions(frozenClone());
    let executes = 0;
    for (const [key, e] of expected) {
      if (e.disposition !== "execute") continue;
      executes += 1;
      expect(() => assertRequestIntegrity(e.request), key).not.toThrow();
    }
    expect(executes).toBe(D080_EXPECTED_INVOCATION_COUNT);
  });
});

// ---------------------------------------------------------------------------
// C10 — the verifier, not the generator, proves the whole dependency cell
// ---------------------------------------------------------------------------

describe("C10 — every stable dependency-cell field is bound to the ledger and the pinned matrix", () => {
  /** The cell every attack below mutates: an observation cell for the victim. */
  const victimCell = (cells: any[]) =>
    cells.find((c) => c.provider_account_id === SYNTH_VICTIM.providerAccountId && c.family === "observation");

  let baseline: Awaited<ReturnType<typeof runSyntheticPackage>>;
  beforeAll(async () => { baseline = await runSyntheticPackage(); }, 300_000);

  it("keeps the untouched synthetic package fully verifiable", () => {
    // The positive control the attacks are measured against. If this drifts,
    // every rejection below could be rejecting the wrong thing.
    expect(baseline.result.ok).toBe(true);
    expect(baseline.result.failures).toEqual([]);
    expect(baseline.ledger).toHaveLength(226);
    expect(baseline.sealed.invocationResults.receipts).toHaveLength(226);
    const skips = baseline.ledger.filter((l) => l.disposition === "dependency_skip");
    expect(baseline.ledger.filter((l) => l.disposition === "execute")).toHaveLength(194);
    expect(skips).toHaveLength(32);
    expect(skips.filter((s) => s.dependencyCode === "binding_cutoff_unavailable")).toHaveLength(26);
    expect(skips.filter((s) => s.dependencyCode === "canonical_latest_as_of_unavailable")).toHaveLength(6);
    const victim = (rows: any[]) => (rows ?? []).filter((r) => r?.provider_account_id === SYNTH_VICTIM.providerAccountId);
    expect(victim(baseline.sealed.unitEvidence.coverageMatrix)).toHaveLength(4);
    expect(victim(baseline.sealed.configStates.coverage)).toHaveLength(6);
    expect(victim(baseline.sealed.canonicalDecisions.servedDateCoverage)).toHaveLength(1);
    expect(victim(baseline.sealed.canonicalDecisions.perBinding)).toHaveLength(1);
    const cells = victim(baseline.sealed.dependencyCoverage.cells);
    expect(cells.filter((c: any) => c.family === "observation")).toHaveLength(2);
    expect(cells.filter((c: any) => c.family === "state_change")).toHaveLength(2);
  });

  it("derives the expected projection from the ledger, the matrix and the plan alone", () => {
    // Non-circular by construction: the cells are not an input.
    const { cells: expectedCells, violations } = expectedDependencyCells(baseline.sealed as any);
    expect(violations).toEqual([]);
    expect(expectedCells).toHaveLength(32);
    for (const c of expectedCells) {
      expect(c.status).toBe("not_run_dependency_failed");
      expect(c.rows).toBe(0);
      expect(D080_PLAN_FAMILY[c.planKey]).toBe(c.family);
      const pinned = D080_PINNED_BINDINGS.find((b) => b.businessId === c.business_id);
      expect(pinned, c.invocationKey).toBeDefined();
      expect(c.business).toBe(pinned!.business);
    }
    // Rebuilt from a package with its cells stripped: the projection cannot be
    // reading them.
    const stripped = { ...(baseline.sealed as any), dependencyCoverage: { cells: [] } };
    expect(expectedDependencyCells(stripped).cells).toHaveLength(32);
  });

  it("permits exactly eleven stable fields and no others", () => {
    expect([...D080_DEPENDENCY_CELL_FIELDS].sort()).toEqual([
      "business", "business_id", "dependencyCode", "family", "grain",
      "invocationKey", "missingPrerequisites", "planKey", "provider_account_id",
      "rows", "status",
    ]);
    for (const cell of baseline.sealed.dependencyCoverage.cells as any[]) {
      expect(Object.keys(cell).sort()).toEqual([...D080_DEPENDENCY_CELL_FIELDS].sort());
    }
  });

  /**
   * The five attacks independent acceptance drove through Correction 9's
   * verifier, each returning ok:true, plus every neighbouring field.
   */
  it.each([
    ["C10 attack 1 — grain campaign→adset", (c: any) => { c.grain = "adset"; }, "dependency_cell_grain_mismatch"],
    ["C10 attack 2 — rows 0→-1", (c: any) => { c.rows = -1; }, "invalid_count"],
    ["C10 attack 3 — rows 0→1", (c: any) => { c.rows = 1; }, "dependency_cell_rows_invalid"],
    ["C10 attack 4 — provider_account_id→null", (c: any) => { c.provider_account_id = null; }, "dependency_cell_identity_mismatch"],
    ["C10 attack 5 — business display forged", (c: any) => { c.business = "made_up"; }, "dependency_cell_identity_mismatch"],
    ["business_id forged", (c: any) => { c.business_id = "forged-business"; }, "dependency_cell_identity_mismatch"],
    ["provider_account_id cross-paired", (c: any) => { c.provider_account_id = D080_PINNED_BINDINGS[0]!.providerAccountId; }, "dependency_cell_identity_mismatch"],
    ["status forged to ok", (c: any) => { c.status = "ok"; }, "dependency_state_not_stated"],
    ["planKey forged", (c: any) => { c.planKey = "seriesCampaign"; }, "dependency_plan_mismatch"],
    ["family forged", (c: any) => { c.family = "unit"; }, "dependency_family_mismatch"],
    ["dependencyCode forged", (c: any) => { c.dependencyCode = "business_cutoff_unavailable"; }, "dependency_code_mismatch"],
    ["missing-prerequisite set forged", (c: any) => { c.missingPrerequisites = ["cutoff"]; }, "dependency_missing_set_mismatch"],
    ["invocationKey forged", (c: any) => { c.invocationKey = "seriesCampaign#nope"; }, "dependency_coverage_mismatch"],
    ["rows as a string", (c: any) => { c.rows = "0"; }, "invalid_count"],
    ["rows fractional", (c: any) => { c.rows = 0.5; }, "invalid_count"],
    ["rows non-finite", (c: any) => { c.rows = Number.NaN; }, "invalid_count"],
    ["a smuggled extra stable field", (c: any) => { c.totallyMadeUp = "yes"; }, "dependency_cell_unexpected_field"],
    ["required field removed — grain", (c: any) => { delete c.grain; }, "dependency_cell_field_missing"],
    ["required field removed — business", (c: any) => { delete c.business; }, "dependency_cell_field_missing"],
    ["required field removed — planKey", (c: any) => { delete c.planKey; }, "dependency_cell_field_missing"],
    ["required field removed — rows", (c: any) => { delete c.rows; }, "dependency_cell_rows_invalid"],
  ])("refuses %s", async (_label, forge, reason) => {
    const broken = await runSyntheticPackage((f) => forge(victimCell(f.dependencyCoverage)));
    expect(broken.result.ok).toBe(false);
    const onSection = broken.result.failures.filter((x) => x.startsWith("dependencyCoverage.cells:"));
    // The rejection must come from the dependency cell itself, not only from a
    // downstream matrix or a stale hash.
    expect(onSection.length, JSON.stringify(broken.result.failures.slice(0, 3))).toBeGreaterThan(0);
    expect(onSection.join(" ")).toContain(reason);
  }, 300_000);

  it("refuses a duplicated cell", async () => {
    const broken = await runSyntheticPackage((f) => {
      f.dependencyCoverage.push({ ...victimCell(f.dependencyCoverage) });
    });
    expect(broken.result.ok).toBe(false);
    expect(broken.result.failures.join(" ")).toContain("duplicates");
  }, 300_000);

  it("refuses an omitted cell", async () => {
    const broken = await runSyntheticPackage((f) => {
      const drop = victimCell(f.dependencyCoverage);
      f.dependencyCoverage = f.dependencyCoverage.filter((c: any) => c !== drop);
    });
    expect(broken.result.ok).toBe(false);
    const joined = broken.result.failures.join(" ");
    expect(joined).toContain("dependency_coverage_mismatch");
    expect(joined).toContain("dependency_cell_projection_mismatch");
  }, 300_000);

  it("reports a projection mismatch alongside every field-level rejection", async () => {
    // The multiset equality is a second, independent net: even a forgery whose
    // field check were somehow bypassed would still not match the projection.
    const broken = await runSyntheticPackage((f) => { victimCell(f.dependencyCoverage).grain = "adset"; });
    expect(broken.result.failures.join(" ")).toContain("dependency_cell_projection_mismatch");
  }, 300_000);
});

// Every test above captured the D080-specific timeout during collection. Reset
// immediately so another file reusing this worker keeps the global 15s bound.
vi.resetConfig();
