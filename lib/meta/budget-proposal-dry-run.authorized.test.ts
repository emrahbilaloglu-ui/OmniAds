/**
 * D085 Correction 7 — the adversarial matrix, run against a REACHABLE positive
 * baseline.
 *
 * The canonical campaign-context resolver identity is environment-approved,
 * and no environment in this repository approves it. Correction 6 recorded
 * that honestly and then drew the wrong conclusion: with no positive builder
 * row reachable, every negative row rested on the authority floor, so eleven
 * mutations that should have blocked were never actually exercised. Codex
 * approved the resolver for a single process and drove them through; all
 * eleven escaped.
 *
 * This file exists so that can never silently happen again. It is SKIPPED
 * unless the resolver identity is approved for this process, and the first
 * test proves the baseline is genuinely `would_write_available` with an empty
 * blocker list — so a green run here can never be vacuous.
 *
 * Run it with:
 *
 *   CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION=campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01 \
 *     npx vitest run --maxWorkers=1 --no-file-parallelism --sequence.concurrent=false \
 *     lib/meta/budget-proposal-dry-run.authorized.test.ts
 *
 * The approval is process-local. It is never persisted, never written to any
 * env file, and never weakened in product code.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PREVIEW_CONTRACT_VERSION,
  evaluateHashEligibility,
  assembleWouldWritePreview,
  buildBudgetProposalDryRun,
  capabilityFingerprint,
  clearSafetyFlag,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS,
  META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS,
  RECEIPT_FIELD_COVERAGE,
  previewIdempotencyKey,
  derivePreviewKey,
  enumerateSchemaPaths,
  RECEIPT_PROOF_KEYS,
  RECEIPT_REQUIRED_KEYS,
  RECEIPT_VERIFICATION_GUARANTEE,
  REQUEST_FIELD_COVERAGE,
  UNOBSERVABLE_HASH,
  WOULD_WRITE_REQUEST_KEYS,
  validateWouldWriteSemantics,
  recomputePreviewHash,
  sanitizeCapabilitySnapshot,
  verifyReceiptPreviewIntegrity,
  type DryRunBlocker,
  type SafetyFlag,
  type DryRunInput,
  type ProviderCapabilityContract,
  type ReceiptPreview,
  type WouldWriteRequest,
} from "@/lib/meta/budget-proposal-dry-run";
import { readbackFingerprint, type PreflightProjection } from "@/lib/meta/provider-readback-contract";
import { validateBudgetIntent } from "@/lib/meta/budget-intent-contract";
import { ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { PIT_POLICY } from "@/lib/meta/point-in-time-policy";
import * as dryRunModule from "@/lib/meta/budget-proposal-dry-run";
import { SNAPSHOT_LIMITS, checkFingerprint, exactMap, isPlainDataInvariant, isPlainMap, safeSnapshot, typedArray, utf8BytesUpTo, type SchemaProblem } from "@/lib/meta/runtime-schema";
import { campaignContextAuthorityResolverVersion } from "@/lib/creative-decision-engine/campaign-context/source";

/*
  TEST-LOCAL adversarial resealing — private to this file by construction.

  Adversarial fixtures must sometimes seal a deliberately illegal pair in order
  to attack the verifier. r13 met that need by weakening the production
  recompute function; r14 moved it behind a name but still EXPORTED it from the
  production runtime; r15 moved it to `lib/meta/__testing__/`, which any
  production module could still import. Correction 15 deletes the module: the
  algorithm is reimplemented here, in the test that needs it, where nothing can
  import it. There is no forge module to reach.
*/
function canonicaliseForTests(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseForTests);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((k) => [k, canonicaliseForTests((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The raw canonical preview hash, with NO eligibility gate. */
function rawCanonicalPreviewHashForTests(
  payload: { request: unknown; receipt: unknown },
  previewContractVersion: string,
): string {
  const { receiptHash: _excluded, ...bareReceipt } = payload.receipt as Record<string, unknown>;
  const canonical = JSON.stringify(canonicaliseForTests({
    v: previewContractVersion, request: payload.request, receipt: bareReceipt,
  }));
  return `${previewContractVersion}:${createHash("sha256").update(canonical).digest("hex")}`;
}

const RESOLVER_APPROVED = campaignContextAuthorityResolverVersion() !== null;

const BASELINE: PreflightProjection = {
  providerAccountId: "act_1087566732415606", entityGrain: "adset", entityId: "23851234567890123",
  parentCampaignId: "23859876543210987", budgetField: "daily_budget", budgetMinorUnits: 10_000,
  ownerMode: "adset_budget", effectiveStatus: "ACTIVE", scheduleStart: null, scheduleEnd: null,
  optimizationGoal: "OFFSITE_CONVERSIONS",
};

/** An explicitly SYNTHETIC capability. Production always passes the real one. */
const SYN: ProviderCapabilityContract = {
  budgetEndpointExists: true, dispatchVerbExists: true,
  supportedFields: ["daily_budget"],
  source: "SYNTHETIC TEST CAPABILITY — no such endpoint exists in this codebase",
  why: "synthetic capability used only to exercise the adversarial matrix",
};

const BUSINESS = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const ACCOUNT = "act_1087566732415606";
const CAMPAIGN = "23859876543210987";
const ADSET = "23851234567890123";

function bestCase(over: Partial<DryRunInput> = {}): DryRunInput {
  const satisfied = Object.fromEntries(
    WRITE_SAFETY_STEPS.map((s) => [s, "satisfied" as const]),
  ) as DryRunInput["writeSafety"];
  return {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: { id: "dec_1", hash: "d".repeat(64), version: "v1", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 86_400 },
    scope: {
      businessId: BUSINESS, business: "IwaStore", providerAccountId: ACCOUNT,
      entityGrain: "adset", entityId: ADSET, parentCampaignId: CAMPAIGN,
      accountIsWriteScope: true, accountSelectionWhy: "selected serving account",
    },
    direction: "increase", percent: 10, accountCurrency: "USD", currencyExponent: 2,
    currencyRegistryVersion: ISO_4217_REGISTRY_VERSION, unitConfidence: "exact",
    role: {
      role: "main", source: "system_inferred", resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      confidence: "high", asOf: "2026-09-01", accountScoped: true, satisfiesRoleAuthority: true,
      authorityBlockers: [], producer: "automatic_inference", campaignId: CAMPAIGN,
      businessId: BUSINESS, providerAccountId: ACCOUNT, resolved: true, why: "resolved",
    },
    budgetFact: {
      contractVersion: "meta.budget-fact.v4", available: true, currentMinorUnits: 10_000,
      budgetField: "daily_budget", ownerMode: "adset_budget", scheduleStart: null, scheduleEnd: null,
      observedAt: "2026-09-01", capturedAt: "2026-09-01T00:00:00.000Z", lineage: "canonical",
      availabilityWhy: "available",
    },
    commercial: {
      profileContractVersion: "adsecute.account-decision-profile.v1",
      businessId: BUSINESS, providerAccountId: ACCOUNT, sourceStatus: "resolved",
      selectedAction: "scale", eligible: true, code: null, reason: null, blockerCodes: [],
      evidenceFloorsClear: true, changeSafetyClear: true,
    },
    safety: {
      killSwitch: clearSafetyFlag("test", "2026-09-01", "disengaged"),
      admission: clearSafetyFlag("test", "2026-09-01", "allowed"),
      cap: clearSafetyFlag("test", "2026-09-01", "under cap"),
      cooldown: clearSafetyFlag("test", "2026-09-01", "no cooldown"),
      conflict: clearSafetyFlag("test", "2026-09-01", "no lock"),
    },
    capability: SYN,
    rawIntent: {
      contractVersion: "meta.budget-intent.v1",
      scope: { businessId: BUSINESS, providerAccountId: ACCOUNT, entityGrain: "adset", entityId: ADSET, parentCampaignId: CAMPAIGN },
      ownerMode: "adset_budget", budgetField: "daily_budget",
      observedDailyMinorUnits: 10_000, observedLifetimeMinorUnits: null, lifetimeSchedule: null,
      direction: "increase", percent: 10, accountCurrency: "USD",
      originDate: "2026-09-01", effectiveAsOf: "2026-09-01", knowledgeAsOf: "2026-09-01",
      authorityEvidenceAsOf: "2026-09-01", maxAuthorityEvidenceAgeDays: 60,
      sourceFingerprints: { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64) },
      evidenceWindow: { from: "2026-08-01", to: "2026-09-01" },
      targetSource: null, authorityStatus: "authorised", blockerCodes: [],
    },
    knownBindings: [{ businessId: BUSINESS, providerAccountId: ACCOUNT }],
    intent: null, intentRejections: [], casBaseline: BASELINE,
    preflightEvidence: {
      rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: BASELINE },
      evaluatedAt: "2026-09-01T00:00:00.000Z", baselineFingerprint: readbackFingerprint(BASELINE),
    },
    preflight: {
      contractVersion: "meta.provider-readback.v4", outcome: "succeeded", claimedStatus: "succeeded",
      rejections: [], ageSeconds: 0, fresh: true, projectionComplete: true,
      driftedFields: [], driftDetail: [], matchesBaseline: true,
      why: "a fresh (0s old), complete provider read reproduces the baseline on every projected field",
    },
    writeSafety: satisfied, originDate: "2026-09-01", knowledgeAsOf: "2026-09-01T00:00:00.000Z",
    ...over,
  } as DryRunInput;
}

/** A CAMPAIGN-grain proposal, so the expected role campaign is the entity itself. */
function campaignGrain(over: Partial<DryRunInput> = {}): DryRunInput {
  const b = bestCase();
  const projection: PreflightProjection = {
    ...BASELINE, entityGrain: "campaign", entityId: CAMPAIGN, parentCampaignId: null,
    ownerMode: "campaign_budget_optimization",
    // A campaign carries no ad-set optimization goal; the projection contract
    // rejects one, and rightly so.
    optimizationGoal: null,
  };
  return bestCase({
    scope: { ...b.scope, entityGrain: "campaign", entityId: CAMPAIGN, parentCampaignId: null },
    budgetFact: { ...b.budgetFact, ownerMode: "campaign_budget_optimization" },
    rawIntent: {
      ...b.rawIntent!,
      scope: { businessId: BUSINESS, providerAccountId: ACCOUNT, entityGrain: "campaign", entityId: CAMPAIGN, parentCampaignId: null },
      ownerMode: "campaign_budget_optimization",
    },
    casBaseline: projection,
    preflightEvidence: {
      rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection },
      evaluatedAt: "2026-09-01T00:00:00.000Z", baselineFingerprint: readbackFingerprint(projection),
    },
    ...over,
  });
}

const run = (over: Partial<DryRunInput> = {}) => buildBudgetProposalDryRun(bestCase(over));

/**
 * Every negative row goes through here.
 *
 * It asserts the four things Correction 7 requires of each: no uncaught
 * exception, a deterministic exact blocker, no would-write preview, and — the
 * one r7 could not give — that the gate under test contributed the block
 * ITSELF, from a baseline that would otherwise have previewed.
 */
function blocksWith(over: Partial<DryRunInput>, expected: DryRunBlocker, expectedWhy?: string) {
  const label = JSON.stringify(over).slice(0, 110);
  let result: ReturnType<typeof buildBudgetProposalDryRun>;
  expect(() => { result = buildBudgetProposalDryRun(bestCase(over)); }, `${label} threw`).not.toThrow();
  result = buildBudgetProposalDryRun(bestCase(over));
  expect(result.status, label).toBe("blocked");
  expect(result.wouldWriteRequest, label).toBeNull();
  expect(result.receiptPreview, label).toBeNull();
  expect(result.blockers, label).toContain(expected);
  if (expectedWhy !== undefined) {
    const why = result.blockerDetail.find((d) => d.code === expected)!.why;
    expect(why, `${label} — expected the reason to name: ${expectedWhy}`).toContain(expectedWhy);
  }
  return result.blockers;
}

describe.skipIf(!RESOLVER_APPROVED)("D085 C7 — the adversarial matrix, against a reachable baseline", () => {
  it("NON-VACUITY: the untouched baseline previews with an EMPTY blocker list", () => {
    // If this ever fails, every negative row below is meaningless and the
    // suite must not be read as evidence of anything.
    const r = run();
    expect(campaignContextAuthorityResolverVersion()).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    expect(r.blockers).toEqual([]);
    expect(r.status).toBe("would_write_available");
    expect(r.wouldWriteRequest).not.toBeNull();
    expect(r.receiptPreview).not.toBeNull();
  });

  it("the campaign-grain baseline also previews, so both grains are exercised", () => {
    const r = buildBudgetProposalDryRun(campaignGrain());
    expect(r.blockers).toEqual([]);
    expect(r.status).toBe("would_write_available");
  });

  // ---------------------------------------------------------------------
  // Escape 1 — the composite scope binds business, account AND campaign
  // ---------------------------------------------------------------------
  describe("escape 1: exact composite role scope", () => {
    it("blocks the exact r7 escape: a role resolved for a different campaign, same account", () => {
      blocksWith(
        { role: { ...bestCase().role, campaignId: "23850000000000000" } },
        "role_identity_unbound",
        "not the proposal's campaign 23859876543210987",
      );
    });

    it("blocks a campaign-grain proposal whose role names a different campaign", () => {
      const g = campaignGrain({ role: { ...bestCase().role, campaignId: "23850000000000000" } });
      const r = buildBudgetProposalDryRun(g);
      expect(r.status).toBe("blocked");
      expect(r.blockers).toContain("role_identity_unbound");
      // At CAMPAIGN grain the expected campaign is the entity itself.
      expect(r.blockerDetail.find((d) => d.code === "role_identity_unbound")!.why).toContain(CAMPAIGN);
    });

    it("blocks an ad-set proposal whose role names the AD SET instead of the parent campaign", () => {
      // A plausible off-by-one that a non-empty-string check cannot catch.
      blocksWith({ role: { ...bestCase().role, campaignId: ADSET } }, "role_identity_unbound");
    });

    it.each([
      ["a missing campaign", null],
      ["an empty campaign", ""],
      ["a whitespace campaign", "   "],
    ])("blocks %s on the role", (_l, campaignId) => {
      blocksWith({ role: { ...bestCase().role, campaignId } as DryRunInput["role"] }, "role_identity_unbound");
    });

    it("blocks a wrong account", () => {
      blocksWith({ role: { ...bestCase().role, providerAccountId: "act_999999999999999" } }, "role_identity_unbound");
    });

    it("blocks a wrong business", () => {
      blocksWith({ role: { ...bestCase().role, businessId: "00000000-0000-0000-0000-000000000000" } }, "role_identity_unbound");
    });

    it("blocks a stale as-of that is not the canonical authority evidence", () => {
      blocksWith(
        { role: { ...bestCase().role, asOf: "2026-01-01" } },
        "role_identity_unbound",
        "not the 2026-09-01 authority evidence",
      );
    });

    it("blocks an as-of AFTER the origin", () => {
      blocksWith({ role: { ...bestCase().role, asOf: "2026-09-05" } }, "role_identity_unbound");
    });
  });

  // ---------------------------------------------------------------------
  // Escapes 2 and 3 — the capability proof
  // ---------------------------------------------------------------------
  describe("escapes 2 and 3: the capability a receipt was assembled under", () => {
    const assembled = (capability: ProviderCapabilityContract = SYN) => {
      const input = bestCase({ capability });
      const v = validateBudgetIntent(input.rawIntent!, input.knownBindings);
      if (v.status !== "valid") throw new Error(`fixture intent invalid: ${v.rejections.join(", ")}`);
      const out = assembleWouldWritePreview({
        scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
        intent: v.intent, budgetField: "daily_budget",
        casBaseline: BASELINE, decisionId: "dec_1", writeSafety: input.writeSafety,
        capability, inputFingerprint: buildBudgetProposalDryRun(input).inputFingerprint,
      });
      if ("refused" in out) throw new Error(`unexpectedly refused: ${out.why}`);
      return out;
    };

    it("a receipt assembled from the BUILDER's own preview verifies", () => {
      const r = run();
      if (r.status !== "would_write_available") throw new Error("baseline must preview");
      const v = verifyReceiptPreviewIntegrity({ request: r.wouldWriteRequest, receipt: r.receiptPreview });
      expect(v.problems).toEqual([]);
      expect(v.verified).toBe(true);
    });

    it.each([
      ["duplicates", ["lifetime_budget", "daily_budget", "daily_budget"]],
      ["reverse order", ["lifetime_budget", "daily_budget"]],
      ["canonical order", ["daily_budget", "lifetime_budget"]],
      ["repeated single field", ["daily_budget", "daily_budget", "daily_budget"]],
    ])("canonicalizes %s to ONE snapshot, fingerprint and hash", (_l, supportedFields) => {
      // The exact r7 escape: the fingerprint hashed a sorted-but-not-deduped
      // caller object while the snapshot shipped deduped, so a genuine
      // receipt could not reproduce its own fingerprint.
      const cap = { ...SYN, supportedFields } as ProviderCapabilityContract;
      const a = assembled(cap);
      const v = verifyReceiptPreviewIntegrity({ request: a.request, receipt: a.receipt });
      expect(v.problems).toEqual([]);
      expect(v.verified).toBe(true);
      expect(a.receipt.capabilitySnapshot!.supportedFields)
        .toEqual([...new Set(supportedFields)].sort());
      expect(a.receipt.capabilityFingerprint).toBe(capabilityFingerprint(cap));
      expect(capabilityFingerprint(cap)).toBe(capabilityFingerprint({
        ...SYN, supportedFields: [...new Set(supportedFields)].sort(),
      } as ProviderCapabilityContract));
    });

    it("publishes a snapshot whose sanitizer is idempotent", () => {
      const messy = { ...SYN, supportedFields: ["lifetime_budget", "daily_budget", "daily_budget"] } as ProviderCapabilityContract;
      const once = sanitizeCapabilitySnapshot(messy);
      const twice = sanitizeCapabilitySnapshot(once as unknown as ProviderCapabilityContract);
      expect(twice).toEqual(once);
    });

    it("REFUSES a self-consistent receipt that says the write path does not exist", () => {
      /*
        The r7 escape, verbatim: set both published booleans to false,
        recompute the capability fingerprint FROM that false snapshot, then
        recompute the receipt hash. r7 returned verified:true — a receipt
        asserting no budget endpoint and no dispatch verb, verifying as a
        valid would-write receipt.
      */
      const a = assembled();
      const snap = { ...a.receipt.capabilitySnapshot!, budgetEndpointExists: false, dispatchVerbExists: false };
      const forged = { ...a.receipt, capabilitySnapshot: snap, capabilityFingerprint: capabilityFingerprint(snap as never) };
      const sealed = { ...forged, receiptHash: recomputePreviewHash({ request: a.request, receipt: forged as never }) } as ReceiptPreview;
      // It is internally self-consistent...
      expect(recomputePreviewHash({ request: a.request, receipt: sealed })).toBe(sealed.receiptHash);
      expect(capabilityFingerprint(snap as never)).toBe(sealed.capabilityFingerprint);
      // ...and it is still refused, on capability PERMISSION.
      const v = verifyReceiptPreviewIntegrity({ request: a.request, receipt: sealed });
      expect(v.verified).toBe(false);
      expect(v.problems.join("; ")).toContain("no budget endpoint exists");
      expect(v.problems.join("; ")).toContain("no dispatch verb exists");
    });

    it.each([
      ["only budgetEndpointExists false", { budgetEndpointExists: false }],
      ["only dispatchVerbExists false", { dispatchVerbExists: false }],
      ["an empty supported-field list", { supportedFields: [] }],
      ["a field the request does not use", { supportedFields: ["lifetime_budget"] }],
    ])("REFUSES a self-consistent re-hashed forgery with %s", (_l, patch) => {
      const a = assembled();
      const snap = { ...a.receipt.capabilitySnapshot!, ...patch };
      const forged = { ...a.receipt, capabilitySnapshot: snap, capabilityFingerprint: capabilityFingerprint(snap as never) };
      const sealed = { ...forged, receiptHash: recomputePreviewHash({ request: a.request, receipt: forged as never }) } as ReceiptPreview;
      // Self-consistent by construction — the hash and fingerprint both agree.
      expect(recomputePreviewHash({ request: a.request, receipt: sealed })).toBe(sealed.receiptHash);
      const v = verifyReceiptPreviewIntegrity({ request: a.request, receipt: sealed });
      expect(v.verified).toBe(false);
      expect(v.problems.length).toBeGreaterThan(0);
    });

    it("REFUSES a self-consistent forgery whose snapshot is unsorted or duplicated", () => {
      const a = assembled();
      for (const supportedFields of [["lifetime_budget", "daily_budget"], ["daily_budget", "daily_budget"]]) {
        const snap = { ...a.receipt.capabilitySnapshot!, supportedFields } as never;
        const forged = { ...a.receipt, capabilitySnapshot: snap, capabilityFingerprint: capabilityFingerprint(snap) };
        const sealed = { ...forged, receiptHash: recomputePreviewHash({ request: a.request, receipt: forged as never }) } as ReceiptPreview;
        const v = verifyReceiptPreviewIntegrity({ request: a.request, receipt: sealed });
        expect(v.verified, JSON.stringify(supportedFields)).toBe(false);
        expect(v.problems.join("; ")).toContain("canonical form");
      }
    });
  });

  // ---------------------------------------------------------------------
  // Escapes 4-8 — the raw intent's blocker container and enums
  // ---------------------------------------------------------------------
  describe("escapes 4-8: raw intent containers and enums", () => {
    const withIntent = (patch: Record<string, unknown>) =>
      ({ rawIntent: { ...bestCase().rawIntent!, ...patch } } as unknown as Partial<DryRunInput>);

    it.each([
      ["null", null], ["undefined", undefined], ["a number", 7], ["a map", {}],
      ["the string \"none\"", "none"], ["a nested array", [[]]], ["true", true],
    ])("blocks blockerCodes as %s, without throwing", (_l, blockerCodes) => {
      // `null`/`undefined`/`7`/`{}` threw `is not iterable`; `"none"` was
      // spread into characters and PREVIEWED.
      blocksWith(withIntent({ blockerCodes }), "intent_rejected_by_canonical_validator");
    });

    it("blocks a non-string element inside an otherwise well-formed array", () => {
      blocksWith(withIntent({ authorityStatus: "blocked", blockerCodes: [7] }), "intent_rejected_by_canonical_validator");
    });

    it.each([
      ["an unknown status", "approved"], ["null", null], ["undefined", undefined],
      ["a number", 1], ["an array", []], ["a map", {}],
    ])("blocks authorityStatus as %s", (_l, authorityStatus) => {
      blocksWith(withIntent({ authorityStatus }), "intent_rejected_by_canonical_validator");
    });

    it.each([
      ["null", null], ["an array", []], ["a string", "hashes"], ["a number", 3],
      ["an extra key", { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64), extra: "x" }],
      ["a missing key", { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64) }],
    ])("blocks sourceFingerprints as %s", (_l, sourceFingerprints) => {
      blocksWith(withIntent({ sourceFingerprints }), "intent_rejected_by_canonical_validator");
    });

    it.each([
      ["null", null], ["an array", []], ["a string", "2026-08-01/2026-09-01"], ["a number", 1],
      ["a missing end", { from: "2026-08-01" }],
    ])("blocks evidenceWindow as %s", (_l, evidenceWindow) => {
      blocksWith(withIntent({ evidenceWindow }), "intent_rejected_by_canonical_validator");
    });

    it.each([
      ["an array", []], ["a string", "2026-08-01"], ["a number", 1], ["a map missing dates", {}],
    ])("blocks a lifetime schedule that is %s on a lifetime budget", (_l, lifetimeSchedule) => {
      blocksWith(
        {
          budgetFact: { ...bestCase().budgetFact, budgetField: "lifetime_budget", scheduleStart: "2026-08-01", scheduleEnd: "2026-09-30" },
          rawIntent: { ...bestCase().rawIntent!, budgetField: "lifetime_budget", observedDailyMinorUnits: null, observedLifetimeMinorUnits: 10_000, lifetimeSchedule },
        } as unknown as Partial<DryRunInput>,
        "intent_rejected_by_canonical_validator",
      );
    });
  });

  // ---------------------------------------------------------------------
  // Escapes 9-11 — preflight and commercial containers
  // ---------------------------------------------------------------------
  describe("escapes 9-11: preflight and commercial containers", () => {
    const malformedContainers = [
      ["null", null], ["undefined", undefined], ["a string", "none"], ["a number", 7],
      ["a map", {}], ["true", true],
    ] as Array<[string, unknown]>;

    it.each(
      (["rejections", "driftedFields", "driftDetail"] as const).flatMap((key) =>
        malformedContainers.map(([label, value]) => [key, label, value] as const))
    )("blocks preflight.%s as %s, without throwing", (key, _label, value) => {
      blocksWith(
        { preflight: { ...bestCase().preflight, [key]: value } } as unknown as Partial<DryRunInput>,
        "input_container_malformed",
        `preflight.${key}`,
      );
    });

    it.each(malformedContainers)("blocks commercial.blockerCodes as %s, floors CLEAR", (_l, blockerCodes) => {
      blocksWith(
        { commercial: { ...bestCase().commercial, blockerCodes } } as unknown as Partial<DryRunInput>,
        "input_container_malformed",
      );
    });

    it.each(malformedContainers)("blocks commercial.blockerCodes as %s, floors NOT clear", (_l, blockerCodes) => {
      // The exact r11 combination: the message-building branch read `.length`.
      blocksWith(
        { commercial: { ...bestCase().commercial, blockerCodes, evidenceFloorsClear: false } } as unknown as Partial<DryRunInput>,
        "input_container_malformed",
      );
    });

    it.each(malformedContainers)("blocks role.authorityBlockers as %s", (_l, authorityBlockers) => {
      blocksWith(
        { role: { ...bestCase().role, authorityBlockers } } as unknown as Partial<DryRunInput>,
        "role_authority_not_canonical",
      );
    });

    it.each(malformedContainers)("blocks capability.supportedFields as %s", (_l, supportedFields) => {
      blocksWith(
        { capability: { ...SYN, supportedFields } } as unknown as Partial<DryRunInput>,
        "input_container_malformed",
      );
    });

    it.each(malformedContainers)("blocks intentRejections as %s", (_l, intentRejections) => {
      blocksWith({ intentRejections } as unknown as Partial<DryRunInput>, "input_container_malformed");
    });

    it.each([
      ["null", null], ["a map", {}], ["a string", "bindings"], ["a number", 7],
    ])("blocks knownBindings as %s", (_l, knownBindings) => {
      blocksWith({ knownBindings } as unknown as Partial<DryRunInput>, "input_container_malformed");
    });

    it.each([
      ["a null element", [null]], ["a string element", ["biz"]], ["an array element", [[]]],
      ["an element missing the account", [{ businessId: BUSINESS }]],
      ["an element with a blank business", [{ businessId: "  ", providerAccountId: ACCOUNT }]],
    ])("blocks knownBindings with %s", (_l, knownBindings) => {
      blocksWith({ knownBindings } as unknown as Partial<DryRunInput>, "input_container_malformed");
    });

    it("blocks preflightEvidence.rawAttempt as null on the container", () => {
      // `null` is an explicitly absent attempt, which the container layer owns.
      blocksWith(
        { preflightEvidence: { ...bestCase().preflightEvidence, rawAttempt: null } } as unknown as Partial<DryRunInput>,
        "input_container_malformed",
      );
    });

    it.each([["a string", "none"], ["a number", 7], ["true", true]] as Array<[string, unknown]>)(
      "blocks preflightEvidence.rawAttempt as %s on the SCHEMA", (_l, rawAttempt) => {
        // Correction 8's discriminated-union check reaches these first and
        // names the variant that is missing, which is the more precise
        // failure than "wrong container".
        blocksWith(
          { preflightEvidence: { ...bestCase().preflightEvidence, rawAttempt } } as unknown as Partial<DryRunInput>,
          "input_schema_not_exact",
        );
      });

    it("blocks an EMPTY rawAttempt map on MISSING EVIDENCE, not container shape", () => {
      // `{}` is a well-formed map, so the honest failure is that the raw
      // provider evidence carries no canonical status — not that the container
      // is malformed, and not that "the read failed", which is what r7's
      // message claimed of an attempt that was never made.
      blocksWith(
        { preflightEvidence: { ...bestCase().preflightEvidence, rawAttempt: {} } } as unknown as Partial<DryRunInput>,
        "preflight_raw_evidence_missing",
        "no canonical status",
      );
    });

    it.each([
      ["an unknown status", { status: "banana", observedAt: "2026-09-01T00:00:00.000Z" }],
      ["a null status", { status: null }],
      ["a numeric status", { status: 1 }],
    ])("blocks a rawAttempt with %s", (_l, rawAttempt) => {
      blocksWith(
        { preflightEvidence: { ...bestCase().preflightEvidence, rawAttempt } } as unknown as Partial<DryRunInput>,
        "preflight_raw_evidence_missing",
      );
    });

    it.each([
      ["an array", []], ["a string", "baseline"], ["a number", 7],
    ])("blocks casBaseline as %s", (_l, casBaseline) => {
      blocksWith({ casBaseline } as unknown as Partial<DryRunInput>, "input_container_malformed");
    });

    it.each([
      ["an array", []], ["a string", "safety"], ["a number", 7],
    ])("blocks the writeSafety ceremony as %s", (_l, writeSafety) => {
      const r = buildBudgetProposalDryRun(bestCase({ writeSafety } as unknown as Partial<DryRunInput>));
      expect(r.status).toBe("blocked");
      expect(r.wouldWriteRequest).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // The floor: nothing above accidentally opened a write path
  // ---------------------------------------------------------------------
  it("never attempts a provider write, whatever the input", () => {
    for (const over of [
      {}, { role: { ...bestCase().role, campaignId: "x" } },
      { commercial: { ...bestCase().commercial, blockerCodes: null } } as unknown as Partial<DryRunInput>,
    ]) {
      const r = buildBudgetProposalDryRun(bestCase(over));
      expect(r.executable).toBe(false);
      expect(r.ctaEnabled).toBe(false);
      expect(r.executionState).toBe("validated_only");
      expect(r.providerWriteAttempted).toBe(false);
      expect(r.providerOutcome).toBe("not_attempted");
      expect(r.readbackClassification).toBe("not_attempted");
    }
  });
});

describe("D085 C7 — the approval gate itself", () => {
  it("is honest about whether this file could run", () => {
    // Recorded either way, so a skipped matrix can never be mistaken for a
    // passing one.
    if (!RESOLVER_APPROVED) {
      expect(campaignContextAuthorityResolverVersion()).toBeNull();
    } else {
      expect(campaignContextAuthorityResolverVersion()).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    }
  });
});

// ---------------------------------------------------------------------------
// Correction 8 — the 66 escapes, made permanent
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C8 — semantic request/receipt verification", () => {
  const genuine = (input: DryRunInput = bestCase()) => {
    const r = buildBudgetProposalDryRun(input);
    if (r.status !== "would_write_available") throw new Error(`baseline must preview, blocked by: ${r.blockers.join(", ")}`);
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };

  /**
   * Re-seal a mutated pair the way a forger would: recompute the capability
   * fingerprint from the published snapshot, then recompute the receipt hash.
   * The result is INTERNALLY CONSISTENT — which is exactly why r8 accepted it.
   */
  const reseal = (request: WouldWriteRequest, receipt: ReceiptPreview): ReceiptPreview => {
    const withFp = receipt.capabilitySnapshot
      ? { ...receipt, capabilityFingerprint: capabilityFingerprint(receipt.capabilitySnapshot as never) }
      : { ...receipt };
    /*
      Sealed through the TEST-ONLY raw hash.

      Correction 13 gave `recomputePreviewHash` an eligibility gate, so from
      then on resealing a forgery through it returned a SENTINEL — and the
      "this forgery is self-consistent, so a hash-only verifier would accept
      it" assertion silently degraded into sentinel === sentinel. The raw
      helper restores the property these rows exist to test.
    */
    return { ...withFp, receiptHash: rawCanonicalPreviewHashForTests({ request, receipt: withFp }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
  };

  /**
   * Every forgery row asserts the same four things Correction 8 requires:
   * the call does not throw; the forgery is genuinely self-consistent (so it
   * would have passed a hash-only check); verification fails; and it fails
   * for the row's OWN named reason rather than a generic one.
   */
  const forgeryRefused = (
    label: string,
    mutate: (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview],
    expectedReason: string,
    input: DryRunInput = bestCase(),
  ) => {
    const g = genuine(input);
    const [req, rec] = mutate(g.request, g.receipt);
    const sealed = reseal(req, rec);
    /*
      Self-consistent by construction: the forgery's own hash reproduces from
      its own bytes, so a HASH-ONLY verifier accepts it. Measured with the raw
      algorithm, because the production entrypoint refuses ineligible pairs —
      and that refusal is asserted separately below rather than assumed.
    */
    expect(
      rawCanonicalPreviewHashForTests({ request: req, receipt: sealed }, PREVIEW_CONTRACT_VERSION),
      `${label} is not self-consistent`,
    ).toBe(sealed.receiptHash);
    // Our own hash entrypoint refuses to bless it at all.
    expect(recomputePreviewHash({ request: req, receipt: sealed }), `${label} was blessed by the hash entrypoint`)
      .not.toBe(sealed.receiptHash);
    let v!: ReturnType<typeof verifyReceiptPreviewIntegrity>;
    expect(() => { v = verifyReceiptPreviewIntegrity({ request: req, receipt: sealed }); }, `${label} threw`).not.toThrow();
    expect(v.verified, label).toBe(false);
    expect(v.problems.join(" | "), `${label} — expected a problem naming: ${expectedReason}`).toContain(expectedReason);
  };

  it("POSITIVE: a genuine builder receipt verifies, at BOTH grains", () => {
    for (const [grain, input] of [["adset", bestCase()], ["campaign", campaignGrain()]] as Array<[string, DryRunInput]>) {
      const g = genuine(input);
      const v = verifyReceiptPreviewIntegrity(g);
      expect(v.problems, grain).toEqual([]);
      expect(v.verified, grain).toBe(true);
      expect(validateWouldWriteSemantics(g.request, g.receipt), grain).toEqual([]);
    }
  });

  // ---- A1-A19: request mutations ----------------------------------------
  it.each([
    ["A1 dryRun:false", (r: WouldWriteRequest, c: ReceiptPreview) => [{ ...r, dryRun: false }, c], "request.dryRun"],
    ["A2 endpointClass graph_mutation", (r, c) => [{ ...r, endpointClass: "graph_mutation" }, c], "request.endpointClass"],
    ["A3 nodeClass campaign on an adset receipt", (r, c) => [{ ...r, nodeClass: "campaign" }, c], "request.nodeClass"],
    ["A4 different entityId", (r, c) => [{ ...r, entityId: "99999999999999999" }, c], "request.entityId"],
    ["A5 different currentMinorUnits", (r, c) => [{ ...r, currentMinorUnits: 55_555 }, c], "receipt.before.minorUnits"],
    ["A6 different proposedMinorUnits", (r, c) => [{ ...r, proposedMinorUnits: 999_999 }, c], "receipt.proposed.minorUnits"],
    ["A7 different currency", (r, c) => [{ ...r, currency: "EUR" }, c], "receipt.currency"],
    ["A8 different currencyExponent", (r, c) => [{ ...r, currencyExponent: 3 }, c], "registry exponent"],
    ["A9 empty fieldAllowlist", (r, c) => [{ ...r, fieldAllowlist: [] }, c], "request.fieldAllowlist"],
    ["A10 valueSemantics relative_delta", (r, c) => [{ ...r, valueSemantics: "relative_delta" }, c], "request.valueSemantics"],
    ["A11 durable-looking idempotency key", (r, c) => [{ ...r, idempotencyKeyPreview: "meta.budget-intent.v1:deadbeef" }, c], "request.idempotencyKeyPreview"],
    ["A12 different CAS fingerprint", (r, c) => [{ ...r, casPrecondition: { ...r.casPrecondition, fingerprint: "meta.provider-readback.v4:0000" } }, c], "request.casPrecondition.fingerprint"],
    ["A13 different CAS field", (r, c) => [{ ...r, casPrecondition: { ...r.casPrecondition, field: "lifetime_budget" } }, c], "request.casPrecondition.field"],
    ["A14 different CAS expected amount", (r, c) => [{ ...r, casPrecondition: { ...r.casPrecondition, expectedMinorUnits: 1 } }, c], "request.casPrecondition.expectedMinorUnits"],
    ["A15 providerWriteAttempted:true", (r, c) => [{ ...r, providerWriteAttempted: true }, c], "request.providerWriteAttempted"],
    ["A16 providerOutcome succeeded", (r, c) => [{ ...r, providerOutcome: "succeeded" }, c], "request.providerOutcome"],
    ["A17 executable:true", (r, c) => [{ ...r, executable: true }, c], "request.executable"],
    ["A18 blank notExecutableWhy", (r, c) => [{ ...r, notExecutableWhy: "" }, c], "request.notExecutableWhy"],
    ["A19 extra accessToken key", (r, c) => [{ ...r, accessToken: "EAAsecret" }, c], "unrecognised key {accessToken}"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s, self-consistent and re-hashed", (label, mutate, reason) => {
      forgeryRefused(label, mutate, reason);
    });

  // ---- A20-A41: receipt and snapshot mutations ---------------------------
  it.each([
    ["A20 receipt dryRun:false", (r, c) => [r, { ...c, dryRun: false }], "receipt.dryRun"],
    ["A21 durable-looking previewKey", (r, c) => [r, { ...c, previewKey: "meta.budget-receipt:real" }], "receipt.previewKey"],
    ["A22 changed previewKeyNamespace", (r, c) => [r, { ...c, previewKeyNamespace: "meta.budget-receipt" }], "receipt.previewKeyNamespace"],
    ["A23 isDurableReceipt:true", (r, c) => [r, { ...c, isDurableReceipt: true }], "receipt.isDurableReceipt"],
    // v9's previewKey derivation commits to the scope identity, so an entity
    // substitution now fails the RECOMPUTATION before the cross-binding check
    // — an earlier and stronger detection of the same forgery.
    ["A24 different scope entity", (r, c) => [r, { ...c, scope: { ...c.scope, entityId: "88888888888888888" } }], "receipt.previewKey does not reproduce"],
    ["A25 different before amount", (r, c) => [r, { ...c, before: { ...c.before, minorUnits: 1 } }], "receipt.before.minorUnits"],
    ["A26 different proposed amount", (r, c) => [r, { ...c, proposed: { ...c.proposed, minorUnits: 777_777 } }], "receipt.proposed.minorUnits"],
    ["A27 different currency", (r, c) => [r, { ...c, currency: "GBP" }], "receipt.currency"],
    ["A28 different exponent", (r, c) => [r, { ...c, currencyExponent: 0 }], "receipt.currencyExponent"],
    ["A29 human actor and approval", (r, c) => [r, { ...c, actor: { classification: "human", module: "ui", humanApproval: "someone" } }], "receipt.actor.classification"],
    // Correction 9 catches this in the SCALAR domain first: the forged value
    // is not a `<contract>:<sha256>` fingerprint at all, which is a stronger
    // reason than "it disagrees with the request".
    ["A30 different CAS baseline fingerprint", (r, c) => [r, { ...c, casBaselineFingerprint: "meta.provider-readback.v4:ffff" }], "receipt.casBaselineFingerprint"],
    ["A30b a well-formed but DIFFERENT CAS fingerprint", (r, c) => [r, { ...c, casBaselineFingerprint: `meta.provider-readback.v4:${"a".repeat(64)}` }], "request.casPrecondition.fingerprint"],
    ["A31 blank readback fingerprint", (r, c) => [r, { ...c, readbackFingerprint: "" }], "receipt.readbackFingerprint"],
    ["A32 empty gatesSatisfied, all missing", (r, c) => [r, { ...c, gatesSatisfied: [], gatesMissing: [...c.gatesSatisfied] }], "canonical ordered partition"],
    ["A33 changed rollback operation", (r, c) => [r, { ...c, rollbackPreview: { ...c.rollbackPreview, operation: "apply_new_amount" } }], "receipt.rollbackPreview.operation"],
    ["A34 a redaction flag set true", (r, c) => [r, { ...c, redaction: { ...c.redaction, tokensIncluded: true } }], "receipt.redaction.tokensIncluded"],
    ["A35 receipt providerWriteAttempted:true", (r, c) => [r, { ...c, providerWriteAttempted: true }], "receipt.providerWriteAttempted"],
    ["A36 receipt providerOutcome succeeded", (r, c) => [r, { ...c, providerOutcome: "succeeded" }], "receipt.providerOutcome"],
    ["A37 readbackClassification succeeded", (r, c) => [r, { ...c, readbackClassification: "succeeded" }], "receipt.readbackClassification"],
    ["A38 executionState executable", (r, c) => [r, { ...c, executionState: "executable" }], "receipt.executionState"],
    ["A39 ctaEnabled:true", (r, c) => [r, { ...c, ctaEnabled: true }], "receipt.ctaEnabled"],
    ["A40 extra receipt key dispatchApproved", (r, c) => [r, { ...c, dispatchApproved: true }], "unrecognised key {dispatchApproved}"],
    ["A41 extra capability-snapshot key", (r, c) => [r, { ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, bypass: true } }], "unrecognised key {bypass}"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s, self-consistent and re-hashed", (label, mutate, reason) => {
      forgeryRefused(label, mutate, reason);
    });

  // ---- Cross-field companions, and the campaign grain --------------------
  it.each([
    ["a campaign-grain receipt whose request claims the ad-set node", (r, c) => [{ ...r, nodeClass: "adset" }, c], "request.nodeClass"],
    ["a campaign-grain rollback restoring the wrong amount", (r, c) => [r, { ...c, rollbackPreview: { ...c.rollbackPreview, restoreMinorUnits: 1 } }], "receipt.rollbackPreview.restoreMinorUnits"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s", (label, mutate, reason) => {
      forgeryRefused(label, mutate, reason, campaignGrain());
    });

  it("refuses BOTH sides mutated coherently to the same wrong amount", () => {
    // Request and receipt agree with each other — but not with the CAS
    // precondition and rollback that record what was actually observed.
    forgeryRefused(
      "coherent double mutation",
      (r, c) => [
        { ...r, currentMinorUnits: 42 },
        { ...c, before: { ...c.before, minorUnits: 42 } },
      ],
      "request.casPrecondition.expectedMinorUnits",
    );
  });

  it("STATES ITS LIMIT: a fully coherent re-write cannot be detected locally", () => {
    /*
      The honest boundary of this verifier, asserted rather than assumed.

      An adversary who rewrites EVERY mutually consistent field — request,
      receipt, CAS precondition, rollback, fingerprints — and recomputes the
      hash produces something that is, field for field, a genuine receipt for
      a different proposal. No local check can separate the two, because the
      verifier holds nothing the forger does not. Detecting it needs a
      server-held secret or an authoritative durable lookup, and D085 has
      neither while automation is OFF.
    */
    const g = genuine();
    const other = genuine(bestCase({ percent: 25, rawIntent: { ...bestCase().rawIntent!, percent: 25 } }));
    const v = verifyReceiptPreviewIntegrity(other);
    expect(v.verified).toBe(true);
    expect(other.receipt.receiptHash).not.toBe(g.receipt.receiptHash);
    expect(RECEIPT_VERIFICATION_GUARANTEE.doesNotEstablish.join(" ")).toContain("authenticity or origin");
    expect(RECEIPT_VERIFICATION_GUARANTEE.wouldRequire).toContain("server-held secret");
  });

  it("is MIGRATION-SAFE across the contract advance", () => {
    const g = genuine();
    for (const version of ["meta.budget-preview-receipt.v4", "meta.budget-preview-receipt.v5", "meta.budget-preview-receipt.v6", undefined]) {
      const legacy = { ...g.receipt, previewContractVersion: version } as unknown as ReceiptPreview;
      const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: legacy });
      expect(v.verified).toBe(false);
      // UNVERIFIABLE, not "false for the wrong reason": stricter semantics are
      // never applied retroactively to a receipt issued under an older
      // contract identifier.
      expect(v.problems.join("; ")).toContain("cannot be verified rather than being valid");
    }
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C8 — every exported boundary is total", () => {
  const validAssembly = () => {
    const input = bestCase();
    const v = validateBudgetIntent(input.rawIntent!, input.knownBindings);
    if (v.status !== "valid") throw new Error("fixture intent invalid");
    return {
      scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      intent: v.intent, budgetField: "daily_budget" as const,
      casBaseline: BASELINE, decisionId: "dec_1", writeSafety: input.writeSafety,
      capability: SYN, inputFingerprint: buildBudgetProposalDryRun(input).inputFingerprint,
    };
  };

  it("validateBudgetIntent returns a REJECTION rather than throwing", () => {
    for (const bad of [null, undefined, 7, "intent", []]) {
      let r!: ReturnType<typeof validateBudgetIntent>;
      expect(() => { r = validateBudgetIntent(bad as never, []); }, String(bad)).not.toThrow();
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(r.reasons.join("; ")).toContain("not a map");
    }
  });

  it.each([
    ["a null input", () => null],
    ["an undefined input", () => undefined],
    ["a primitive input", () => 7],
    ["an array input", () => []],
    ["a null capability", () => ({ ...validAssembly(), capability: null })],
    ["a null scope", () => ({ ...validAssembly(), scope: null })],
    ["a null intent view", () => ({ ...validAssembly(), intent: null })],
    ["a null rawIntent", () => ({ ...validAssembly(), rawIntent: null })],
    ["null knownBindings", () => ({ ...validAssembly(), knownBindings: null })],
    ["a null casBaseline", () => ({ ...validAssembly(), casBaseline: null })],
    ["a null writeSafety", () => ({ ...validAssembly(), writeSafety: null })],
    ["a null inputFingerprint", () => ({ ...validAssembly(), inputFingerprint: null })],
    ["an extra key", () => ({ ...validAssembly(), surprise: 1 })],
    ["a missing key", () => { const a = validAssembly() as Record<string, unknown>; delete a.capability; return a; }],
  ])("assembleWouldWritePreview REFUSES %s rather than throwing", (_l, build) => {
    let out!: ReturnType<typeof assembleWouldWritePreview>;
    expect(() => { out = assembleWouldWritePreview(build() as never); }).not.toThrow();
    expect("refused" in out).toBe(true);
    if ("refused" in out) expect(out.why.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 7, "receipt", []])(
    "verifyReceiptPreviewIntegrity returns unverified for %s rather than throwing", (bad) => {
      let v!: ReturnType<typeof verifyReceiptPreviewIntegrity>;
      expect(() => { v = verifyReceiptPreviewIntegrity(bad as never); }).not.toThrow();
      expect(v.verified).toBe(false);
      expect(v.problems.length).toBeGreaterThan(0);
    });

  it("a VALID assembly input still assembles, so totality did not close the door", () => {
    const out = assembleWouldWritePreview(validAssembly());
    expect("refused" in out).toBe(false);
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C8 — every canonical map is exactly its keys", () => {
  const b = bestCase();
  const blocksOnSchema = (over: Partial<DryRunInput>, expectedPath: string) => {
    const label = expectedPath;
    let r!: ReturnType<typeof buildBudgetProposalDryRun>;
    expect(() => { r = buildBudgetProposalDryRun(bestCase(over)); }, `${label} threw`).not.toThrow();
    expect(r.status, label).toBe("blocked");
    expect(r.wouldWriteRequest, label).toBeNull();
    expect(r.receiptPreview, label).toBeNull();
    expect(r.blockers, label).toContain("input_schema_not_exact");
    const why = r.blockerDetail.find((d) => d.code === "input_schema_not_exact")!.why;
    expect(why, `${label} — the blocker must name the offending path`).toContain(expectedPath);
  };

  it.each([
    ["C1 scope", { scope: { ...b.scope, surprise: 1 } }, "scope"],
    ["C2 role", { role: { ...b.role, surprise: 1 } }, "role"],
    ["C3 budgetFact", { budgetFact: { ...b.budgetFact, surprise: 1 } }, "budgetFact"],
    ["C4 commercial", { commercial: { ...b.commercial, surprise: 1 } }, "commercial"],
    ["C5 a safety child", { safety: { ...b.safety, killSwitch: { ...b.safety.killSwitch, surprise: 1 } } }, "safety.killSwitch"],
    ["C6 capability", { capability: { ...SYN, surprise: 1 } }, "capability"],
    ["C7 decision", { decision: { ...b.decision, surprise: 1 } }, "decision"],
    ["C8 a knownBindings element", { knownBindings: [{ ...b.knownBindings[0], surprise: 1 }] }, "knownBindings[0]"],
    ["C10 casBaseline", { casBaseline: { ...BASELINE, surprise: 1 } }, "casBaseline"],
    ["C11 preflight", { preflight: { ...b.preflight, surprise: 1 } }, "preflight"],
    ["C12 preflightEvidence", { preflightEvidence: { ...b.preflightEvidence!, surprise: 1 } }, "preflightEvidence"],
    ["C13 rawAttempt", { preflightEvidence: { ...b.preflightEvidence!, rawAttempt: { ...b.preflightEvidence!.rawAttempt!, surprise: 1 } } }, "preflightEvidence.rawAttempt"],
    ["C14 rawIntent", { rawIntent: { ...b.rawIntent!, surprise: 1 } }, "rawIntent"],
    ["C15 rawIntent.evidenceWindow", { rawIntent: { ...b.rawIntent!, evidenceWindow: { ...b.rawIntent!.evidenceWindow, surprise: 1 } } }, "rawIntent.evidenceWindow"],
    ["extra key on the top-level input", { surprise: 1 }, "input"],
    ["extra key on rawIntent.scope", { rawIntent: { ...b.rawIntent!, scope: { ...b.rawIntent!.scope, surprise: 1 } } }, "rawIntent.scope"],
    ["extra key on rawIntent.sourceFingerprints", { rawIntent: { ...b.rawIntent!, sourceFingerprints: { ...b.rawIntent!.sourceFingerprints, surprise: 1 } } }, "rawIntent.sourceFingerprints"],
    ["an unrecognised write-safety step", { writeSafety: { ...b.writeSafety, surprise_step: "satisfied" } }, "unrecognised step \"surprise_step\""],
  ] as unknown as Array<[string, Partial<DryRunInput>, string]>)("blocks an extra key on %s", (_l, over, path) => {
    blocksOnSchema(over as Partial<DryRunInput>, path);
  });

  it("C9 blocks a non-string element in intentRejections", () => {
    blocksOnSchema({ intentRejections: [7] } as unknown as Partial<DryRunInput>, "intentRejections[0]");
  });

  it.each([
    ["a missing required scope key", () => { const sc = { ...b.scope } as Record<string, unknown>; delete sc.entityGrain; return { scope: sc }; }, "scope"],
    ["a missing required capability key", () => { const c = { ...SYN } as Record<string, unknown>; delete c.why; return { capability: c }; }, "capability"],
    ["a missing required rawIntent key", () => { const ri = { ...b.rawIntent! } as Record<string, unknown>; delete ri.evidenceWindow; return { rawIntent: ri }; }, "rawIntent"],
  ])("blocks %s", (_l, build, path) => {
    blocksOnSchema(build() as Partial<DryRunInput>, path);
  });

  it.each([
    ["a failed variant carrying succeeded keys", { status: "failed", why: "x", retryable: false, observedAt: "2026-09-01T00:00:00.000Z" }],
    ["a succeeded variant carrying failed keys", { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: BASELINE, retryable: true }],
    ["an unknown variant", { status: "banana" }],
  ])("blocks a raw attempt that is %s", (_l, rawAttempt) => {
    blocksOnSchema(
      { preflightEvidence: { ...b.preflightEvidence!, rawAttempt } } as unknown as Partial<DryRunInput>,
      "preflightEvidence.rawAttempt",
    );
  });

  it.each([
    ["null", null], ["undefined", undefined], ["an array", []], ["a string", "projection"], ["a number", 7],
    ["an extra key", { ...BASELINE, surprise: 1 }],
  ])("D blocks a SUCCEEDED raw attempt whose projection is %s, without throwing", (_l, projection) => {
    // r8 threw `Cannot read properties of null (reading 'providerAccountId')`
    // inside the FROZEN predecessor validator. It is caught at the D085
    // boundary now, so the predecessor is never handed a malformed value and
    // is never edited to survive one.
    blocksOnSchema(
      { preflightEvidence: { ...b.preflightEvidence!, rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection } } } as unknown as Partial<DryRunInput>,
      "preflightEvidence.rawAttempt",
    );
  });

  it("blocks a malformed driftDetail element", () => {
    blocksOnSchema(
      { preflight: { ...b.preflight, driftDetail: [{ field: "budgetMinorUnits", baseline: 1 }] } } as unknown as Partial<DryRunInput>,
      "preflight.driftDetail[0]",
    );
  });

  it("POSITIVE: the untouched canonical input still previews at both grains", () => {
    // Exactness must not have closed the door on the genuine article.
    for (const [grain, input] of [["adset", bestCase()], ["campaign", campaignGrain()]] as Array<[string, DryRunInput]>) {
      const r = buildBudgetProposalDryRun(input);
      expect(r.blockers, grain).toEqual([]);
      expect(r.status, grain).toBe("would_write_available");
    }
  });
});

// ---------------------------------------------------------------------------
// Correction 9 — the 32 escapes, made permanent
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C9 — A: safe observation and totality", () => {
  const SCOPE_KEYS = ["businessId", "business", "providerAccountId", "entityGrain",
    "entityId", "parentCampaignId", "accountIsWriteScope", "accountSelectionWhy"];

  it("rejects a required key inherited through the PROTOTYPE", () => {
    // r9 probed required keys with `key in value`, which reaches the
    // prototype, while extras and hashing used own enumerable keys — two
    // universes, so an inherited required field produced NO schema problem.
    const proto = { entityGrain: "adset" };
    const crafted: Record<string, unknown> = Object.create(proto);
    for (const [k, v] of Object.entries(bestCase().scope)) if (k !== "entityGrain") crafted[k] = v;
    const problems: SchemaProblem[] = [];
    exactMap(crafted, "scope", SCOPE_KEYS, [], problems);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map((p) => p.why).join("; ")).toMatch(/nonstandard prototype|missing required/);
  });

  it.each([
    ["an arbitrary prototype", () => Object.assign(Object.create({ nefarious: true }), bestCase().scope)],
    ["a class instance", () => { class S {} return Object.assign(new S(), bestCase().scope); }],
  ])("rejects %s as a plain map", (_l, build) => {
    const problems: SchemaProblem[] = [];
    exactMap(build(), "scope", SCOPE_KEYS, [], problems);
    expect(problems.map((p) => p.why).join("; ")).toContain("nonstandard prototype");
    expect(isPlainMap(build())).toBe(false);
  });

  it("rejects an accessor WITHOUT invoking its getter", () => {
    let invoked = 0;
    const withAccessor: Record<string, unknown> = { ...bestCase().scope };
    Object.defineProperty(withAccessor, "entityId", {
      get() { invoked += 1; return "GETTER"; }, enumerable: true, configurable: true,
    });
    const problems: SchemaProblem[] = [];
    exactMap(withAccessor, "scope", SCOPE_KEYS, [], problems);
    expect(problems.map((p) => p.why).join("; ")).toContain("getters are never invoked");
    expect(invoked, "the getter must never be called during validation").toBe(0);
  });

  it.each([
    ["a symbol-keyed own property", () => { const o: Record<string | symbol, unknown> = { ...bestCase().scope }; o[Symbol("x")] = "hidden"; return o; }],
    ["a non-enumerable own property", () => { const o: Record<string, unknown> = { ...bestCase().scope }; Object.defineProperty(o, "hidden", { value: 1, enumerable: false }); return o; }],
  ])("rejects %s", (_l, build) => {
    const problems: SchemaProblem[] = [];
    exactMap(build(), "scope", SCOPE_KEYS, [], problems);
    expect(problems.length).toBeGreaterThan(0);
  });

  it.each([
    ["ownKeys", () => new Proxy({}, { ownKeys() { throw new Error("ownKeys trap"); } })],
    ["getOwnPropertyDescriptor", () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } })],
    ["getPrototypeOf", () => new Proxy({}, { getPrototypeOf() { throw new Error("proto trap"); } })],
  ])("turns a Proxy %s trap into a deterministic rejection, never a throw", (_l, build) => {
    const problems: SchemaProblem[] = [];
    expect(() => exactMap(build(), "scope", SCOPE_KEYS, [], problems)).not.toThrow();
    expect(problems.length).toBeGreaterThan(0);
  });

  it.each([
    ["a cycle", () => { const o: Record<string, unknown> = { ...bestCase().scope }; o.self = o; return o; }],
    ["a BigInt value", () => ({ ...bestCase().scope, entityId: BigInt(10) })],
    ["a function value", () => ({ ...bestCase().scope, entityId: () => "x" })],
    ["a NaN value", () => ({ ...bestCase().scope, entityId: Number.NaN })],
    ["an Infinity value", () => ({ ...bestCase().scope, entityId: Number.POSITIVE_INFINITY })],
    ["a sparse array", () => { const a = [1, , 3]; return { ...bestCase().scope, entityId: a }; }],
    ["an array with extra own keys", () => { const a: unknown[] & { evil?: number } = [1]; a.evil = 2; return { ...bestCase().scope, entityId: a }; }],
    ["a Date", () => ({ ...bestCase().scope, entityId: new Date(0) })],
    ["a Map", () => ({ ...bestCase().scope, entityId: new Map() })],
  ])("rejects %s without throwing", (_l, build) => {
    let snap!: ReturnType<typeof safeSnapshot>;
    expect(() => { snap = safeSnapshot(build(), "scope"); }).not.toThrow();
    expect(snap.ok).toBe(false);
  });

  it("snapshots a genuine plain object faithfully", () => {
    // Totality must not have made everything a rejection.
    const snap = safeSnapshot(bestCase().scope, "scope");
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(snap.value).toEqual(JSON.parse(JSON.stringify(bestCase().scope)));
  });

  it.each([
    ["buildBudgetProposalDryRun", (v: unknown) => buildBudgetProposalDryRun(v)],
    ["assembleWouldWritePreview", (v: unknown) => assembleWouldWritePreview(v)],
    ["verifyReceiptPreviewIntegrity", (v: unknown) => verifyReceiptPreviewIntegrity(v)],
    ["recomputePreviewHash", (v: unknown) => recomputePreviewHash(v)],
    ["capabilityFingerprint", (v: unknown) => capabilityFingerprint(v)],
  ] as Array<[string, (v: unknown) => unknown]>)("%s is TOTAL across every hostile input", (_l, call) => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const hostiles: unknown[] = [
      null, undefined, 7, "x", [], BigInt(10), Symbol("s"), () => 1, Number.NaN,
      cyclic, { amount: BigInt(10) }, new Proxy({}, { ownKeys() { throw new Error("trap"); } }),
      Object.assign(Object.create({ inherited: 1 }), { a: 1 }),
      { nested: { deep: { value: BigInt(10) } } },
    ];
    for (const h of hostiles) {
      expect(() => call(h), `${_l} threw on ${String(typeof h)}`).not.toThrow();
    }
  });

  it("the unobservable sentinel cannot be mistaken for a real fingerprint", () => {
    const sentinel = recomputePreviewHash({ request: { a: BigInt(10) }, receipt: {} });
    expect(sentinel).toContain("-unobservable/");
    const problems: SchemaProblem[] = [];
    checkFingerprint(sentinel, "sentinel", problems);
    expect(problems.length, "the sentinel must FAIL a fingerprint check").toBeGreaterThan(0);
  });

  it("BigInt at every D085 entrypoint blocks or refuses, deterministically", () => {
    const r = buildBudgetProposalDryRun(bestCase({ percent: BigInt(10) } as never));
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("input_not_observable");
    expect(r.wouldWriteRequest).toBeNull();
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C9 — B: scalar domains and an authoritative assembly boundary", () => {
  const genuine = (input: DryRunInput = bestCase()) => {
    const r = buildBudgetProposalDryRun(input);
    if (r.status !== "would_write_available") throw new Error(`baseline must preview: ${r.blockers.join(", ")}`);
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };
  const reseal = (request: WouldWriteRequest, receipt: ReceiptPreview): ReceiptPreview => {
    const withFp = receipt.capabilitySnapshot
      ? { ...receipt, capabilityFingerprint: capabilityFingerprint(receipt.capabilitySnapshot as never) }
      : { ...receipt };
    /*
      Sealed through the TEST-ONLY raw hash.

      Correction 13 gave `recomputePreviewHash` an eligibility gate, so from
      then on resealing a forgery through it returned a SENTINEL — and the
      "this forgery is self-consistent, so a hash-only verifier would accept
      it" assertion silently degraded into sentinel === sentinel. The raw
      helper restores the property these rows exist to test.
    */
    return { ...withFp, receiptHash: rawCanonicalPreviewHashForTests({ request, receipt: withFp }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
  };
  const refuses = (
    label: string,
    mutate: (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview],
    expected: string,
  ) => {
    const g = genuine();
    const [rq, rc] = mutate(g.request, g.receipt);
    const sealed = reseal(rq, rc);
    /*
      COHERENT by construction: it re-hashes cleanly under the raw algorithm,
      so a hash-only or agreement-only verifier accepts it. r9 did.
      `recomputePreviewHash` no longer will, which is asserted, not assumed.
    */
    expect(
      rawCanonicalPreviewHashForTests({ request: rq, receipt: sealed }, PREVIEW_CONTRACT_VERSION),
      `${label} is not self-consistent`,
    ).toBe(sealed.receiptHash);
    expect(recomputePreviewHash({ request: rq, receipt: sealed }), `${label} was blessed by the hash entrypoint`)
      .not.toBe(sealed.receiptHash);
    let v!: ReturnType<typeof verifyReceiptPreviewIntegrity>;
    expect(() => { v = verifyReceiptPreviewIntegrity({ request: rq, receipt: sealed }); }, `${label} threw`).not.toThrow();
    expect(v.verified, label).toBe(false);
    expect(v.problems.join(" | "), `${label} — expected a problem naming ${expected}`).toContain(expected);
  };

  it.each([
    ["B1 blank entityId both sides", (r, c) => [{ ...r, entityId: "" }, { ...c, scope: { ...c.scope, entityId: "" } }], "request.entityId"],
    ["B2 numeric entityId both sides", (r, c) => [{ ...r, entityId: 123 }, { ...c, scope: { ...c.scope, entityId: 123 } }], "request.entityId"],
    ["B3 receipt grain banana", (r, c) => [r, { ...c, scope: { ...c.scope, entityGrain: "banana" } }], "receipt.scope.entityGrain"],
    ["B4 accountIsWriteScope false", (r, c) => [r, { ...c, scope: { ...c.scope, accountIsWriteScope: false } }], "receipt.scope.accountIsWriteScope"],
    ["B5 blank business and account", (r, c) => [r, { ...c, scope: { ...c.scope, businessId: "", providerAccountId: "" } }], "receipt.scope.businessId"],
    ["B6 negative amount, coherently everywhere", (r, c) => [
      { ...r, currentMinorUnits: -10_000, casPrecondition: { ...r.casPrecondition, expectedMinorUnits: -10_000 } },
      { ...c, before: { ...c.before, minorUnits: -10_000 }, rollbackPreview: { ...c.rollbackPreview, restoreMinorUnits: -10_000 } },
    ], "may not be negative"],
    ["B7 fractional proposed both sides", (r, c) => [{ ...r, proposedMinorUnits: 11_000.5 }, { ...c, proposed: { ...c.proposed, minorUnits: 11_000.5 } }], "not a whole number"],
    ["B8 blank currency both sides", (r, c) => [{ ...r, currency: "" }, { ...c, currency: "" }], "request.currency"],
    ["B9 negative exponent both sides", (r, c) => [{ ...r, currencyExponent: -2 }, { ...c, currencyExponent: -2 }], "minor-unit exponent"],
    ["B10 blank actor.module", (r, c) => [r, { ...c, actor: { ...c.actor, module: "" } }], "receipt.actor.module"],
    ["B11 non-string decisionId", (r, c) => [r, { ...c, decisionId: 42 }], "receipt.decisionId"],
    ["B12 arbitrary readback fingerprint", (r, c) => [r, { ...c, readbackFingerprint: "anything-at-all" }], "receipt.readbackFingerprint"],
    ["B12b zero-change proposal", (r, c) => [
      { ...r, proposedMinorUnits: r.currentMinorUnits },
      { ...c, proposed: { ...c.proposed, minorUnits: c.before.minorUnits } },
    ], "zero-change proposal"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s — coherent, re-hashed, and still illegal", (label, mutate, expected) => {
      refuses(label, mutate, expected);
    });

  const validAssembly = () => {
    const input = bestCase();
    const v = validateBudgetIntent(input.rawIntent!, input.knownBindings);
    if (v.status !== "valid") throw new Error("fixture intent invalid");
    return {
      scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      intent: v.intent, budgetField: "daily_budget" as const,
      casBaseline: BASELINE, decisionId: "dec_1", writeSafety: input.writeSafety,
      capability: SYN, inputFingerprint: buildBudgetProposalDryRun(input).inputFingerprint,
    };
  };

  it.each([
    ["B13 a fabricated minimal intent", () => ({ ...validAssembly(), intent: {
      currentMinorUnits: 10_000, proposedMinorUnits: 11_000, currency: "USD",
      currencyExponent: 2, intentKey: "k", idempotencyKey: "i",
    } }), "not canonically equal"],
    ["B14 an EMPTY write-safety ceremony", () => ({ ...validAssembly(), writeSafety: {} }), "ceremony is not fully satisfied"],
    ["B15 a scope outside write scope", () => ({ ...validAssembly(), scope: { ...bestCase().scope, accountIsWriteScope: false } }), "not a write scope"],
    ["B16 blank business/provider identity", () => ({ ...validAssembly(), scope: { ...bestCase().scope, businessId: "", providerAccountId: "" } }), "non-empty business id"],
    ["a partial ceremony", () => ({ ...validAssembly(), writeSafety: { ...bestCase().writeSafety, persisted_preflight: "missing" } }), "ceremony is not fully satisfied"],
    ["a CAS baseline for another entity", () => ({ ...validAssembly(), casBaseline: { ...BASELINE, entityId: "99999999999999999" } }), "different entity"],
    ["a CAS amount disagreeing with the intent", () => ({ ...validAssembly(), casBaseline: { ...BASELINE, budgetMinorUnits: 1 } }), "minor units but the intent expects"],
    ["a capability that does not support the field", () => ({ ...validAssembly(), capability: { ...SYN, supportedFields: ["lifetime_budget"] } }), "does not permit daily_budget"],
    ["a non-canonical input fingerprint", () => ({ ...validAssembly(), inputFingerprint: "not-a-fingerprint" }), "fingerprint"],
    ["a non-string decision id", () => ({ ...validAssembly(), decisionId: 7 }), "decision id"],
  ] as Array<[string, () => unknown, string]>)("assembly REFUSES %s", (_l, build, expected) => {
    let out!: ReturnType<typeof assembleWouldWritePreview>;
    expect(() => { out = assembleWouldWritePreview(build() as never); }).not.toThrow();
    expect("refused" in out).toBe(true);
    if ("refused" in out) expect(out.why).toContain(expected);
  });

  it("POSITIVE: a genuine assembly input still assembles, at both grains", () => {
    expect("refused" in assembleWouldWritePreview(validAssembly())).toBe(false);
    for (const [grain, input] of [["adset", bestCase()], ["campaign", campaignGrain()]] as Array<[string, DryRunInput]>) {
      const g = genuine(input);
      const v = verifyReceiptPreviewIntegrity(g);
      expect(v.problems, grain).toEqual([]);
      expect(v.verified, grain).toBe(true);
    }
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C9 — C: one point-in-time policy", () => {
  const b = bestCase();
  const blocksPit = (over: Partial<DryRunInput>, expectedCode: DryRunBlocker, expectedWhy?: string) => {
    let r!: ReturnType<typeof buildBudgetProposalDryRun>;
    expect(() => { r = buildBudgetProposalDryRun(bestCase(over)); }).not.toThrow();
    expect(r.status).toBe("blocked");
    expect(r.wouldWriteRequest).toBeNull();
    expect(r.blockers).toContain(expectedCode);
    if (expectedWhy) {
      expect(r.blockerDetail.find((d) => d.code === expectedCode)!.why).toContain(expectedWhy);
    }
  };

  it("blocks a non-empty but INVALID capturedAt; non-empty is not provenance", () => {
    blocksPit(
      { budgetFact: { ...b.budgetFact, capturedAt: "not-an-instant" } },
      "budget_fact_provenance_incomplete",
      "not a strict instant or calendar day",
    );
  });

  it.each([
    ["not-an-instant", "not-an-instant"],
    ["a rollover date", "2026-02-30"],
    ["a bare year", "2026"],
    ["an empty-ish string", "   "],
    ["a number-like string", "0"],
  ])("blocks an invalid capturedAt: %s", (_l, capturedAt) => {
    const r = buildBudgetProposalDryRun(bestCase({ budgetFact: { ...b.budgetFact, capturedAt } }));
    expect(r.status).toBe("blocked");
    expect(r.wouldWriteRequest).toBeNull();
  });

  it("THE EXACT r9 CUTOFF LEAK: a valid Sep-1 intent may not preview behind an Aug-31 cutoff", () => {
    /*
      Reproduced verbatim from the Correction 9 report. Every clock is VALID;
      only the ordering is wrong, and r9 returned would_write_available with
      an empty blocker list because a date-only day was never related to an
      instant cutoff.
    */
    const leak: Partial<DryRunInput> = {
      originDate: "2026-09-01",
      knowledgeAsOf: "2026-08-31T23:59:59.000Z",
      decision: { ...b.decision, decidedAt: "2026-08-31T23:00:00.000Z" },
      budgetFact: { ...b.budgetFact, capturedAt: "2026-08-31T23:59:00.000Z", observedAt: "2026-08-31" },
      safety: Object.fromEntries(
        Object.entries(b.safety).map(([k, v]) => [k, { ...(v as SafetyFlag), asOf: "2026-08-31" }]),
      ) as unknown as DryRunInput["safety"],
      preflightEvidence: {
        ...b.preflightEvidence!,
        rawAttempt: { status: "succeeded", observedAt: "2026-08-31T23:59:00.000Z", projection: BASELINE },
        evaluatedAt: "2026-08-31T23:59:00.000Z",
      },
    };
    const r = buildBudgetProposalDryRun(bestCase(leak));
    expect(r.status).toBe("blocked");
    expect(r.wouldWriteRequest).toBeNull();
    expect(r.blockers).toContain("capture_after_knowledge_cutoff");
    const why = r.blockerDetail.find((d) => d.code === "capture_after_knowledge_cutoff")!.why;
    expect(why).toContain("2026-09-01");
    expect(why).toContain("calendar day is later than the cutoff");
  });

  it.each([
    ["rawIntent.originDate", "originDate"],
    ["rawIntent.effectiveAsOf", "effectiveAsOf"],
    ["rawIntent.knowledgeAsOf", "knowledgeAsOf"],
    ["rawIntent.authorityEvidenceAsOf", "authorityEvidenceAsOf"],
  ])("blocks a later calendar day on %s", (_l, key) => {
    blocksPit(
      { knowledgeAsOf: "2026-08-31T23:59:59.000Z", originDate: "2026-09-30",
        rawIntent: { ...b.rawIntent!, [key]: "2026-09-15" } } as Partial<DryRunInput>,
      "capture_after_knowledge_cutoff",
    );
  });

  it.each([
    ["role.asOf", { role: { ...b.role, asOf: "2026-09-05" } }],
    ["a safety flag as-of", { safety: { ...b.safety, killSwitch: { ...b.safety.killSwitch, asOf: "2026-09-05" } } }],
    ["the preflight evaluation", { preflightEvidence: { ...b.preflightEvidence!, evaluatedAt: "2026-09-05T00:00:00.000Z" } }],
  ] as Array<[string, Partial<DryRunInput>]>)("blocks a %s after the origin", (_l, over) => {
    const r = buildBudgetProposalDryRun(bestCase(over));
    expect(r.status).toBe("blocked");
    expect(r.wouldWriteRequest).toBeNull();
  });

  it("POSITIVE CONTROL — same day: a Sep-1 intent previews against a Sep-1 cutoff", () => {
    const r = buildBudgetProposalDryRun(bestCase());
    expect(r.blockers).toEqual([]);
    expect(r.status).toBe("would_write_available");
  });

  it("POSITIVE CONTROL — boundary: evidence exactly AT the cutoff instant previews", () => {
    const r = buildBudgetProposalDryRun(bestCase({
      knowledgeAsOf: "2026-09-01T12:00:00.000Z",
      budgetFact: { ...b.budgetFact, capturedAt: "2026-09-01T12:00:00.000Z" },
      decision: { ...b.decision, decidedAt: "2026-09-01T12:00:00.000Z" },
      preflightEvidence: {
        ...b.preflightEvidence!,
        rawAttempt: { status: "succeeded", observedAt: "2026-09-01T12:00:00.000Z", projection: BASELINE },
        evaluatedAt: "2026-09-01T12:00:00.000Z",
      },
    }));
    expect(r.blockers).toEqual([]);
    expect(r.status).toBe("would_write_available");
  });

  it("POSITIVE CONTROL — earlier evidence remains legitimate", () => {
    const r = buildBudgetProposalDryRun(bestCase({
      budgetFact: { ...b.budgetFact, capturedAt: "2026-08-30T00:00:00.000Z", observedAt: "2026-08-30" },
    }));
    expect(r.status).toBe("would_write_available");
  });

  it("publishes ONE documented date-only interpretation", () => {
    expect(PIT_POLICY.dateOnlyInterpretation).toContain("day-to-day");
    expect(PIT_POLICY.invalidTimestamps).toContain("BLOCKS");
  });
});

// ---------------------------------------------------------------------------
// Correction 10 — the 35 escapes, made permanent
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C10 — A: the snapshot preserves what it observes", () => {
  it("A1 preserves an own enumerable data property named __proto__", () => {
    /*
      r10 built its output with `{}` and `out[key] = …`, so this key hit the
      inherited setter: the snapshot returned ok:true while SILENTLY LOSING
      the key. A snapshot that drops what it observed is not a snapshot.
    */
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "__proto__", { value: "own-data", enumerable: true, writable: true, configurable: true });
    const snap = safeSnapshot(o, "o");
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    const v = snap.value as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(v, "__proto__"), "the own key must be preserved").toBe(true);
    expect(v["__proto__"]).toBe("own-data");
    // ...and it must not have mutated the output's prototype.
    expect(Object.getPrototypeOf(v)).toBeNull();
  });

  it.each([
    ["A2 a non-enumerable element at index 0", () => { const a: unknown[] = [1]; Object.defineProperty(a, "0", { value: 1, enumerable: false, writable: true, configurable: true }); return a; }],
    ["A3 an enumerable own array key 01", () => { const a: unknown[] & Record<string, unknown> = [1] as never; a["01"] = "x"; return a; }],
    ["A4 an enumerable own array key 4294967295", () => { const a: unknown[] & Record<string, unknown> = [1] as never; a["4294967295"] = "x"; return a; }],
    ["a non-canonical key 1e2", () => { const a: unknown[] & Record<string, unknown> = [1] as never; a["1e2"] = "x"; return a; }],
    ["a negative-looking key -1", () => { const a: unknown[] & Record<string, unknown> = [1] as never; a["-1"] = "x"; return a; }],
  ])("rejects %s rather than silently omitting it", (_l, build) => {
    const snap = safeSnapshot(build(), "a");
    expect(snap.ok, "must not return ok:true and drop the key").toBe(false);
  });

  it.each([
    ["a getOwnPropertyDescriptor trap that throws", () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } })],
    ["a getPrototypeOf trap that throws", () => new Proxy({}, { getPrototypeOf() { throw new Error("proto trap"); } })],
    ["an ownKeys trap that throws", () => new Proxy({}, { ownKeys() { throw new Error("ownKeys trap"); } })],
  ])("contains %s inside the boundary", (_l, build) => {
    let snap!: ReturnType<typeof safeSnapshot>;
    expect(() => { snap = safeSnapshot(build(), "x"); }).not.toThrow();
    expect(snap.ok).toBe(false);
  });

  it("A5 a get trap throwing for length no longer escapes, because length comes from the descriptor", () => {
    /*
      r10 read `arr.length` AFTER observation, so this Proxy's `get` trap threw
      out of the boundary. Length is now taken from the captured own data
      descriptor, which never invokes `get` — so the trap is not reached at
      all. The requirement is a DETERMINISTIC result rather than a throw, and
      a faithful observation is that result.
    */
    const build = () => new Proxy([1, 2], { get(t, k, r) { if (k === "length") throw new Error("length trap"); return Reflect.get(t, k, r); } });
    let first!: ReturnType<typeof safeSnapshot>;
    let second!: ReturnType<typeof safeSnapshot>;
    expect(() => { first = safeSnapshot(build(), "a"); }).not.toThrow();
    expect(() => { second = safeSnapshot(build(), "a"); }).not.toThrow();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    if (first.ok) expect(first.value).toEqual([1, 2]);
  });

  it("A6 never invokes a thrown value while describing a failure", () => {
    /*
      The error-rendering path was itself an attack surface: r10 interpolated
      `(error as Error).message`, so a trap throwing a non-Error whose
      `message` is a throwing getter escaped the boundary entirely.
    */
    let messageGetterCalls = 0;
    const hostile = new Proxy({}, {
      ownKeys() {
        const err: Record<string, unknown> = {};
        Object.defineProperty(err, "message", { get() { messageGetterCalls += 1; throw new Error("secondary message trap"); } });
        Object.defineProperty(err, "name", { get() { messageGetterCalls += 1; throw new Error("name trap"); } });
        throw err;
      },
    });
    let snap!: ReturnType<typeof safeSnapshot>;
    expect(() => { snap = safeSnapshot(hostile, "o"); }).not.toThrow();
    expect(snap.ok).toBe(false);
    expect(messageGetterCalls, "no getter on the thrown value may be invoked").toBe(0);
    if (!snap.ok) expect(snap.problems.map((p) => p.why).join("; ")).toContain("a thrown object");
  });

  it.each([
    ["a plain object", () => ({ a: 1, b: "x", c: null, d: [1, 2], e: { f: true } })],
    ["a null-prototype object", () => Object.assign(Object.create(null), { a: 1 })],
    ["a canonical array", () => [1, "x", null, { a: 1 }]],
    ["an empty object", () => ({})],
    ["an empty array", () => []],
  ])("POSITIVE CONTROL: %s snapshots faithfully", (_l, build) => {
    const snap = safeSnapshot(build(), "$");
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(JSON.parse(JSON.stringify(snap.value))).toEqual(JSON.parse(JSON.stringify(build())));
  });

  it("the OUTPUT satisfies the plain-data invariant this module advertises", () => {
    // The module's own promise, asserted against its output rather than only
    // against its inputs.
    for (const input of [bestCase(), campaignGrain(), { a: [1, { b: null }] }, Object.assign(Object.create(null), { z: 1 })]) {
      const snap = safeSnapshot(input, "$");
      expect(snap.ok).toBe(true);
      if (snap.ok) expect(isPlainDataInvariant(snap.value)).toEqual([]);
    }
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C10 — B: assembly re-derives, it does not inspect", () => {
  const derived = () => {
    const v = validateBudgetIntent(bestCase().rawIntent!, bestCase().knownBindings);
    if (v.status !== "valid") throw new Error("fixture intent invalid");
    return v.intent;
  };
  const baseAsm = () => ({
    scope: bestCase().scope,
    rawIntent: bestCase().rawIntent!,
    knownBindings: bestCase().knownBindings,
    intent: derived(),
    budgetField: "daily_budget" as const,
    casBaseline: BASELINE,
    decisionId: "dec_1",
    writeSafety: bestCase().writeSafety,
    capability: SYN,
    inputFingerprint: buildBudgetProposalDryRun(bestCase()).inputFingerprint,
  });
  const refuses = (label: string, build: () => unknown, expected?: string) => {
    let out!: ReturnType<typeof assembleWouldWritePreview>;
    expect(() => { out = assembleWouldWritePreview(build() as never); }, `${label} threw`).not.toThrow();
    expect("refused" in out, label).toBe(true);
    if ("refused" in out && expected) expect(out.why, label).toContain(expected);
  };

  it("POSITIVE CONTROL: a genuine raw intent plus bindings assembles, at both grains", () => {
    expect("refused" in assembleWouldWritePreview(baseAsm())).toBe(false);
    for (const [grain, input] of [["adset", bestCase()], ["campaign", campaignGrain()]] as Array<[string, DryRunInput]>) {
      const r = buildBudgetProposalDryRun(input);
      expect(r.status, grain).toBe("would_write_available");
    }
  });

  it("assembles WITHOUT any supplied intent — the derivation is the authority", () => {
    const { intent: _dropped, ...withoutIntent } = baseAsm();
    expect("refused" in assembleWouldWritePreview(withoutIntent)).toBe(false);
  });

  it.each([
    ["B1 authorityStatus unauthorised", { authorityStatus: "unauthorised" }],
    ["B2 blockerCodes non-empty", { blockerCodes: ["authority_missing"] }],
    ["B3 blank intentKey", { intentKey: "" }],
    ["B4 blank durable idempotencyKey", { idempotencyKey: "" }],
    ["B5 blank currency", { currency: "" }],
    ["B6 currencyExponent -1", { currencyExponent: -1 }],
  ])("refuses %s on a full-shaped supplied intent", (label, patch) => {
    // Each of these previewed under r10, which inspected a key set instead of
    // deriving. None can survive canonical equality with a re-derivation.
    refuses(label, () => ({ ...baseAsm(), intent: { ...derived(), ...patch } }), "not canonically equal");
  });

  it("B7 refuses a zero-change proposal made coherent through delta and readback", () => {
    const i = derived();
    refuses("B7", () => ({ ...baseAsm(), intent: {
      ...i, proposedMinorUnits: i.currentMinorUnits, deltaMinorUnits: 0,
      readback: { ...i.readback, expectedMinorUnits: i.currentMinorUnits },
    } }), "not canonically equal");
  });

  it.each([
    ["B8 rollback.priorMinorUnits inconsistent", (i: ReturnType<typeof derived>) => ({ ...i, rollback: { ...i.rollback, priorMinorUnits: 1 } })],
    ["B9 readback.expectedMinorUnits inconsistent", (i: ReturnType<typeof derived>) => ({ ...i, readback: { ...i.readback, expectedMinorUnits: 1 } })],
    ["B10 configStateHash not-a-hash", (i: ReturnType<typeof derived>) => ({ ...i, sourceFingerprints: { ...i.sourceFingerprints, configStateHash: "not-a-hash" } })],
    ["B11 intent.scope.parentCampaignId changed", (i: ReturnType<typeof derived>) => ({ ...i, scope: { ...i.scope, parentCampaignId: "23850000000000000" } })],
  ])("refuses %s", (label, mutate) => {
    refuses(label, () => ({ ...baseAsm(), intent: mutate(derived()) }), "not canonically equal");
  });

  it("B12 refuses a CAS baseline naming a different parent campaign", () => {
    refuses("B12", () => ({ ...baseAsm(), casBaseline: { ...BASELINE, parentCampaignId: "23850000000000000" } }), "parent campaign");
  });

  it.each([
    ["a raw intent that does not validate", () => ({ ...baseAsm(), rawIntent: { ...bestCase().rawIntent!, percent: 999 } }), "does not validate"],
    ["a raw intent scope naming another entity", () => { const { intent: _d, ...rest } = baseAsm(); return { ...rest, rawIntent: { ...bestCase().rawIntent!, scope: { ...bestCase().rawIntent!.scope, entityId: "99999999999999999" } } }; }, "different entity"],
    ["a CAS baseline with a mismatched owner mode", () => ({ ...baseAsm(), casBaseline: { ...BASELINE, ownerMode: "campaign_budget_optimization" } }), "owner mode"],
    ["a daily field whose CAS baseline carries a flight", () => ({ ...baseAsm(), casBaseline: { ...BASELINE, scheduleStart: "2026-08-01", scheduleEnd: "2026-09-01" } }), "must not carry a lifetime flight"],
    ["a blank business name on the scope", () => ({ ...baseAsm(), scope: { ...bestCase().scope, business: "" } }), "non-empty business name"],
    ["knownBindings that do not cover the scope", () => ({ ...baseAsm(), knownBindings: [{ businessId: "other", providerAccountId: "act_other" }] }), "does not validate"],
  ] as Array<[string, () => unknown, string]>)("refuses %s", (label, build, expected) => {
    refuses(label, build, expected);
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C10 — C: receipt domains and mechanical coverage", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error("baseline must preview");
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };
  const reseal = (request: WouldWriteRequest, receipt: ReceiptPreview): ReceiptPreview => {
    const withFp = receipt.capabilitySnapshot
      ? { ...receipt, capabilityFingerprint: capabilityFingerprint(receipt.capabilitySnapshot as never) }
      : { ...receipt };
    /*
      Sealed through the TEST-ONLY raw hash.

      Correction 13 gave `recomputePreviewHash` an eligibility gate, so from
      then on resealing a forgery through it returned a SENTINEL — and the
      "this forgery is self-consistent, so a hash-only verifier would accept
      it" assertion silently degraded into sentinel === sentinel. The raw
      helper restores the property these rows exist to test.
    */
    return { ...withFp, receiptHash: rawCanonicalPreviewHashForTests({ request, receipt: withFp }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
  };
  const refuses = (
    label: string,
    mutate: (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview],
    expected: string,
  ) => {
    const g = genuine();
    const [rq, rc] = mutate(g.request, g.receipt);
    const sealed = reseal(rq, rc);
    // Coherent under the raw algorithm — a hash-only verifier accepts it —
    // while our own hash entrypoint refuses to bless it. Both are asserted.
    expect(
      rawCanonicalPreviewHashForTests({ request: rq, receipt: sealed }, PREVIEW_CONTRACT_VERSION),
      `${label} is not self-consistent`,
    ).toBe(sealed.receiptHash);
    expect(recomputePreviewHash({ request: rq, receipt: sealed }), `${label} was blessed by the hash entrypoint`)
      .not.toBe(sealed.receiptHash);
    const v = verifyReceiptPreviewIntegrity({ request: rq, receipt: sealed });
    expect(v.verified, label).toBe(false);
    expect(v.problems.join(" | "), `${label} — expected a problem naming ${expected}`).toContain(expected);
  };

  it.each([
    ["C1 actor.module arbitrary", (r, c) => [r, { ...c, actor: { ...c.actor, module: "arbitrary-module" } }], "receipt.actor.module"],
    ["C2 inputFingerprint arbitrary", (r, c) => [r, { ...c, inputFingerprint: "anything" }], "receipt.inputFingerprint"],
    ["C3 previewKey prefix-only", (r, c) => [r, { ...c, previewKey: `${c.previewKeyNamespace}:anything` }], "receipt.previewKey"],
    ["C4 idempotencyKeyPreview prefix-only", (r, c) => [{ ...r, idempotencyKeyPreview: `${c.previewKeyNamespace}-idem:anything` }, c], "request.idempotencyKeyPreview"],
    ["C5 scope.business blank", (r, c) => [r, { ...c, scope: { ...c.scope, business: "" } }], "receipt.scope.business"],
    ["an uppercase-hex previewKey", (r, c) => [r, { ...c, previewKey: `${c.previewKeyNamespace}:${"A".repeat(64)}` }], "receipt.previewKey"],
    ["an inputFingerprint naming an older contract", (r, c) => [r, { ...c, inputFingerprint: `d085.budget-proposal-dry-run.v1:${"a".repeat(64)}` }], "receipt.inputFingerprint"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s, coherently re-hashed", (label, mutate, expected) => { refuses(label, mutate, expected); });

  it.skip("SUPERSEDED by the recursive dotted-path ledger in the C11 block: top-level-only coverage was itself the r11 rejection", () => {
    /*
      The structural answer to five corrections of example-by-example
      checking: a field that exists in the contract with no ledger entry FAILS
      here, so a new field cannot be added without declaring how it is checked.
    */
    const covered = REQUEST_FIELD_COVERAGE.map((e) => e.field).sort();
    expect(covered).toEqual([...WOULD_WRITE_REQUEST_KEYS].sort());
    expect(new Set(covered).size, "no duplicate ledger entries").toBe(covered.length);
    for (const entry of REQUEST_FIELD_COVERAGE) {
      expect(entry.domain.length, `${entry.field} has no stated domain`).toBeGreaterThan(0);
      expect(["derivable", "cross_bound", "literal", "domain", "opaque"]).toContain(entry.classification);
    }
  });

  it.skip("SUPERSEDED by the recursive dotted-path ledger in the C11 block", () => {
    const covered = RECEIPT_FIELD_COVERAGE.map((e) => e.field).sort();
    expect(covered).toEqual([...RECEIPT_REQUIRED_KEYS, ...RECEIPT_PROOF_KEYS].sort());
    for (const entry of RECEIPT_FIELD_COVERAGE) {
      expect(entry.domain.length, `${entry.field} has no stated domain`).toBeGreaterThan(0);
    }
  });

  it("declares no OPAQUE fields, and publishes the non-recomputable ones honestly", () => {
    /*
      r11 paired a "zero opaque fields" claim with three fields classified
      `derivable` that nothing could derive. Correction 11 keeps zero opaque
      fields — but only because the two preview keys became genuinely
      derivable, and the one field that is not is published as
      `attested_domain` with its reason.
    */
    const opaque = [...REQUEST_FIELD_COVERAGE, ...RECEIPT_FIELD_COVERAGE].filter((e) => e.classification === "opaque");
    expect(opaque.map((e) => e.field)).toEqual([]);
    /*
      Correction 12 reclassified the two seed digests (and their container)
      from `cross_bound` to `attested_domain`, because a coherent substitution
      of both is undetectable without a trust anchor. Every attested field is
      published as non-recomputable.
    */
    /*
      Correction 14 additionally reclassified the CAS and read-back
      fingerprints from `cross_bound` to `attested_domain`: no provider read
      has occurred, so their equality is receipt-INTERNAL agreement and any
      other coherent digest is locally indistinguishable. The completeness
      invariant below binds this list to the published guarantee.
    */
    const attested = [...REQUEST_FIELD_COVERAGE, ...RECEIPT_FIELD_COVERAGE]
      .filter((e) => e.classification === "attested_domain").map((e) => e.field).sort();
    expect(attested).toEqual([
      "casBaselineFingerprint", "casPrecondition.fingerprint", "inputFingerprint",
      "keySeed", "keySeed.idempotencyKeyDigest", "keySeed.intentKeyDigest", "readbackFingerprint",
    ]);
    const published = RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields.map((f) => f.field);
    for (const leaf of ["receipt.inputFingerprint", "receipt.keySeed.intentKeyDigest", "receipt.keySeed.idempotencyKeyDigest"]) {
      expect(published, `${leaf} must be published as non-recomputable`).toContain(leaf);
    }
  });

  it("EVERY ledgered field, mutated, is actually caught", () => {
    /*
      The ledger is only worth something if its entries are enforced. Each
      literal and cross-bound field is perturbed and must produce a problem.
    */
    const g = genuine();
    /*
      HASH-ONLY re-seal here. The general `reseal` helper recomputes the
      capability fingerprint from the published snapshot, which would silently
      UNDO a perturbation of `capabilityFingerprint` itself — the harness
      erasing the very mutation it is testing. Each perturbation must stand.
    */
    const sealHashOnly = (request: WouldWriteRequest, receipt: ReceiptPreview): ReceiptPreview =>
      ({ ...receipt, receiptHash: recomputePreviewHash({ request, receipt }) }) as ReceiptPreview;
    const perturb = (v: unknown): unknown =>
      typeof v === "boolean" ? !v
      : typeof v === "number" ? v + 1
      : typeof v === "string" ? `${v}-perturbed`
      : Array.isArray(v) ? (v.length === 0 ? ["perturbed"] : [])
      : v === null ? "not-null"
      : { ...(v as object), perturbed: true };
    for (const entry of REQUEST_FIELD_COVERAGE) {
      if (entry.classification === "domain") continue;
      const rq = { ...g.request, [entry.field]: perturb((g.request as unknown as Record<string, unknown>)[entry.field]) } as WouldWriteRequest;
      const sealed = sealHashOnly(rq, g.receipt);
      const v = verifyReceiptPreviewIntegrity({ request: rq, receipt: sealed });
      expect(v.verified, `request.${entry.field} was perturbed and still verified`).toBe(false);
    }
    for (const entry of RECEIPT_FIELD_COVERAGE) {
      if (entry.classification === "domain" || entry.field === "receiptHash") continue;
      const rc = { ...g.receipt, [entry.field]: perturb((g.receipt as unknown as Record<string, unknown>)[entry.field]) } as ReceiptPreview;
      const sealed = sealHashOnly(g.request, rc);
      const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: sealed });
      expect(v.verified, `receipt.${entry.field} was perturbed and still verified`).toBe(false);
    }
  });

  it("POSITIVE CONTROL: the genuine pair still verifies", () => {
    const v = verifyReceiptPreviewIntegrity(genuine());
    expect(v.problems).toEqual([]);
    expect(v.verified).toBe(true);
  });
});

describe("D085 C10 — E: the policy prose matches the policy constant", () => {
  it("carries no superseded end-of-day description in source", () => {
    // One comment still described an interpretation the shipped policy never
    // used. The prose is bound to the constant so the two cannot drift again.
    for (const file of ["lib/meta/point-in-time-policy.ts", "lib/meta/budget-proposal-dry-run.ts"]) {
      const src = readFileSync(resolve(file), "utf8");
      expect(src, `${file} still describes the superseded end-of-day reading`).not.toMatch(/last instant of (its|that) UTC day/);
    }
  });

  it("states the day-to-day rule in the constant the artifact publishes", () => {
    expect(PIT_POLICY.dateOnlyInterpretation).toContain("day-to-day");
    expect(PIT_POLICY.ordering).toContain("coarser");
  });
});

// ---------------------------------------------------------------------------
// Correction 11 — rows 29-43, made permanent
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C11 — B: receipt v9 closes every in-domain substitution", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error(`baseline must preview: ${r.blockers.join(", ")}`);
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };
  /** Coherent reseal: capability fingerprint AND receipt hash recomputed. */
  const reseal = (request: WouldWriteRequest, receipt: ReceiptPreview): ReceiptPreview => {
    const withFp = receipt.capabilitySnapshot
      ? { ...receipt, capabilityFingerprint: capabilityFingerprint(receipt.capabilitySnapshot as never) }
      : { ...receipt };
    /*
      Sealed through the TEST-ONLY raw hash.

      Correction 13 gave `recomputePreviewHash` an eligibility gate, so from
      then on resealing a forgery through it returned a SENTINEL — and the
      "this forgery is self-consistent, so a hash-only verifier would accept
      it" assertion silently degraded into sentinel === sentinel. The raw
      helper restores the property these rows exist to test.
    */
    return { ...withFp, receiptHash: rawCanonicalPreviewHashForTests({ request, receipt: withFp }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
  };
  const refuses = (
    label: string,
    mutate: (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview],
    expected: string,
  ) => {
    const g = genuine();
    const [rq, rc] = mutate(g.request, g.receipt);
    const sealed = reseal(rq, rc);
    // Coherent by construction: a hash-only check accepts this. r11 did.
    // Coherent under the raw algorithm — a hash-only verifier accepts it —
    // while our own hash entrypoint refuses to bless it. Both are asserted.
    expect(
      rawCanonicalPreviewHashForTests({ request: rq, receipt: sealed }, PREVIEW_CONTRACT_VERSION),
      `${label} is not self-consistent`,
    ).toBe(sealed.receiptHash);
    expect(recomputePreviewHash({ request: rq, receipt: sealed }), `${label} was blessed by the hash entrypoint`)
      .not.toBe(sealed.receiptHash);
    const v = verifyReceiptPreviewIntegrity({ request: rq, receipt: sealed });
    expect(v.verified, label).toBe(false);
    expect(v.problems.join(" | "), `${label} — expected a problem naming ${expected}`).toContain(expected);
  };
  const HEX = "a".repeat(64), HEX2 = "b".repeat(64);

  it("POSITIVE CONTROL: the genuine pair verifies at both grains", () => {
    for (const [grain, input] of [["adset", bestCase()], ["campaign", campaignGrain()]] as Array<[string, DryRunInput]>) {
      const r = buildBudgetProposalDryRun(input);
      expect(r.status, grain).toBe("would_write_available");
      if (r.status !== "would_write_available") return;
      const v = verifyReceiptPreviewIntegrity({ request: r.wouldWriteRequest, receipt: r.receiptPreview });
      expect(v.problems, grain).toEqual([]);
      expect(v.verified, grain).toBe(true);
    }
  });

  it("#29 assembly refuses a foreign inputFingerprint, so it cannot mint a self-invalid receipt", () => {
    const input = bestCase();
    const out = assembleWouldWritePreview({
      scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      budgetField: "daily_budget", casBaseline: BASELINE, decisionId: "dec_1",
      writeSafety: input.writeSafety, capability: SYN, inputFingerprint: `foreign.contract:${HEX}`,
    } as never);
    expect("refused" in out).toBe(true);
    if ("refused" in out) expect(out.why).toContain("meta.budget-proposal-dry-run");
  });

  it("ASSEMBLY AND VERIFICATION SHARE ONE INVARIANT SET", () => {
    // Whatever assembly mints must verify. r11 could mint a receipt its own
    // verifier rejected, which is the defect this asserts against.
    const input = bestCase();
    const out = assembleWouldWritePreview({
      scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      budgetField: "daily_budget", casBaseline: BASELINE, decisionId: "dec_1",
      writeSafety: input.writeSafety, capability: SYN,
      inputFingerprint: buildBudgetProposalDryRun(input).inputFingerprint,
    } as never);
    expect("refused" in out).toBe(false);
    if ("refused" in out) return;
    const v = verifyReceiptPreviewIntegrity({ request: out.request, receipt: out.receipt });
    expect(v.problems).toEqual([]);
    expect(v.verified).toBe(true);
  });

  it.each([
    ["#30 {}", {}],
    ["#31 {request:null,receipt:null}", { request: null, receipt: null }],
    ["#32 {request:{},receipt:{}}", { request: {}, receipt: {} }],
    ["a request missing keys", { request: { dryRun: true }, receipt: {} }],
    ["an array", []],
    ["a primitive", 7],
  ])("recomputePreviewHash returns a NON-canonical sentinel for %s", (_l, arg) => {
    let h!: string;
    expect(() => { h = recomputePreviewHash(arg as never); }).not.toThrow();
    // Never a plausible receipt hash. r11 returned a canonical-looking
    // `meta.budget-preview-receipt.v8:<64hex>` for `{request:{},receipt:{}}`.
    expect(h).toContain("-unobservable/");
    expect(h).not.toMatch(/^meta\.budget-preview-receipt\.v\d+:[0-9a-f]{64}$/);
    const problems: SchemaProblem[] = [];
    checkFingerprint(h, "sentinel", problems);
    expect(problems.length, "the sentinel must fail a fingerprint check").toBeGreaterThan(0);
  });

  it.each([
    ["#33 another well-formed previewKey", (r, c) => [r, { ...c, previewKey: `${c.previewKeyNamespace}:${HEX}` }], "receipt.previewKey"],
    ["#34 another well-formed idempotencyKeyPreview", (r, c) => [{ ...r, idempotencyKeyPreview: `${c.previewKeyNamespace}-idem:${HEX}` }, c], "request.idempotencyKeyPreview"],
    ["#35 another well-prefixed D085 inputFingerprint", (r, c) => [r, { ...c, inputFingerprint: `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${HEX2}` }], "receipt.previewKey"],
    ["#36 foreign CAS fingerprints on both sides", (r, c) => [
      { ...r, casPrecondition: { ...r.casPrecondition, fingerprint: `foreign.contract:${HEX}` } },
      { ...c, casBaselineFingerprint: `foreign.contract:${HEX}` }], "meta.provider-readback.v4"],
    ["#37 foreign readbackFingerprint", (r, c) => [r, { ...c, readbackFingerprint: `foreign.contract:${HEX}` }], "receipt.readbackFingerprint"],
    ["#38 unknown currency ZZZ, coherently", (r, c) => [{ ...r, currency: "ZZZ" }, { ...c, currency: "ZZZ" }], "registry"],
    ["#39 USD exponent 2 -> 3, coherently", (r, c) => [{ ...r, currencyExponent: 3 }, { ...c, currencyExponent: 3 }], "registry exponent"],
    ["#40 ad-set receipt parentCampaignId -> null", (r, c) => [r, { ...c, scope: { ...c.scope, parentCampaignId: null } }], "parentCampaignId"],
    ["#41 request fieldAllowlist reversed", (r, c) => [{ ...r, fieldAllowlist: [...r.fieldAllowlist].reverse() }, c], "canonical ordered"],
    ["#42 receipt gatesSatisfied reversed", (r, c) => [r, { ...c, gatesSatisfied: [...c.gatesSatisfied].reverse() }], "canonical ordered"],
  ] as Array<[string, (r: WouldWriteRequest, c: ReceiptPreview) => [WouldWriteRequest, ReceiptPreview], string]>)(
    "refuses %s, coherently rehashed", (label, mutate, expected) => { refuses(label, mutate, expected); });

  it("a campaign-grain receipt must carry a NULL parentCampaignId", () => {
    const r = buildBudgetProposalDryRun(campaignGrain());
    if (r.status !== "would_write_available") throw new Error("campaign baseline must preview");
    expect(r.receiptPreview.scope.parentCampaignId).toBeNull();
    const rc = { ...r.receiptPreview, scope: { ...r.receiptPreview.scope, parentCampaignId: CAMPAIGN } };
    const sealed = reseal(r.wouldWriteRequest, rc as ReceiptPreview);
    const v = verifyReceiptPreviewIntegrity({ request: r.wouldWriteRequest, receipt: sealed });
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toContain("null parentCampaignId");
  });

  it("BOTH preview keys are genuinely RECOMPUTED from the receipt's own seed", () => {
    // v9 publishes keySeed, which is what makes rows 33 and 34 closable at all.
    const g = genuine();
    expect(g.receipt.keySeed).toBeTruthy();
    expect(g.receipt.keySeed!.intentKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(g.receipt.keySeed!.idempotencyKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(g.receipt.previewKey).toBe(derivePreviewKey({
      inputFingerprint: g.receipt.inputFingerprint!,
      intentKeyDigest: g.receipt.keySeed!.intentKeyDigest,
      businessId: g.receipt.scope.businessId,
      providerAccountId: g.receipt.scope.providerAccountId,
      entityId: g.receipt.scope.entityId!,
    }));
    expect(g.request.idempotencyKeyPreview).toBe(
      previewIdempotencyKey(g.receipt.keySeed!.idempotencyKeyDigest, g.receipt.inputFingerprint!),
    );
    // A tampered seed breaks the derivation.
    const rc = { ...g.receipt, keySeed: { ...g.receipt.keySeed!, intentKeyDigest: HEX } };
    const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: reseal(g.request, rc as ReceiptPreview) });
    expect(v.verified).toBe(false);
  });

  it("the durable keys themselves never appear in a receipt", () => {
    // Digests, not keys — so a preview can never reserve a durable claim.
    const input = bestCase();
    const v = validateBudgetIntent(input.rawIntent!, input.knownBindings);
    if (v.status !== "valid") throw new Error("fixture intent invalid");
    const raw = JSON.stringify(genuine().receipt);
    expect(raw).not.toContain(v.intent.intentKey);
    expect(raw).not.toContain(v.intent.idempotencyKey);
  });

  it("earlier receipt contracts v1..v8 report UNVERIFIABLE", () => {
    const g = genuine();
    for (let n = 1; n <= 8; n += 1) {
      const legacy = { ...g.receipt, previewContractVersion: `meta.budget-preview-receipt.v${n}` } as unknown as ReceiptPreview;
      const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: legacy });
      expect(v.verified, `v${n}`).toBe(false);
      expect(v.problems.join("; "), `v${n}`).toContain("cannot be verified rather than being valid");
    }
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C11 — the recursive coverage ledger", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error("baseline must preview");
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };

  it("covers EVERY dotted path a real request carries", () => {
    // r11's ledger was top-level only, so every nested path was uncovered.
    const paths = enumerateSchemaPaths(genuine().request).sort();
    const covered = REQUEST_FIELD_COVERAGE.map((e) => e.field).sort();
    const uncovered = paths.filter((p) => !covered.includes(p));
    expect(uncovered, `request paths with no ledger entry: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("covers EVERY dotted path a real receipt carries", () => {
    const paths = enumerateSchemaPaths(genuine().receipt).sort();
    const covered = RECEIPT_FIELD_COVERAGE.map((e) => e.field).sort();
    const uncovered = paths.filter((p) => !covered.includes(p));
    expect(uncovered, `receipt paths with no ledger entry: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("FAILS when a schema path is added without coverage", () => {
    // The ledger's whole value is that it cannot be silently outgrown.
    const withNewField = { ...genuine().receipt, someNewFieldNobodyLedgered: 1 };
    const paths = enumerateSchemaPaths(withNewField);
    const covered = RECEIPT_FIELD_COVERAGE.map((e) => e.field);
    expect(paths.filter((p) => !covered.includes(p))).toEqual(["someNewFieldNobodyLedgered"]);
  });

  it("states each field's TRUE class, with no aspirational derivable", () => {
    const all = [...REQUEST_FIELD_COVERAGE, ...RECEIPT_FIELD_COVERAGE];
    for (const e of all) {
      expect(e.domain.length, `${e.field} has no stated domain`).toBeGreaterThan(0);
      expect(["derivable", "attested_domain", "cross_bound", "literal", "domain", "opaque"]).toContain(e.classification);
    }
    // inputFingerprint is honestly attested, not derivable, and the guarantee
    // publishes it as non-recomputable.
    const fp = RECEIPT_FIELD_COVERAGE.find((e) => e.field === "inputFingerprint")!;
    expect(fp.classification).toBe("attested_domain");
    expect(RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields.map((f) => f.field))
      .toContain("receipt.inputFingerprint");
    // ...and the two preview keys ARE derivable, because v9 made them so.
    expect(RECEIPT_FIELD_COVERAGE.find((e) => e.field === "previewKey")!.classification).toBe("derivable");
    expect(REQUEST_FIELD_COVERAGE.find((e) => e.field === "idempotencyKeyPreview")!.classification).toBe("derivable");
  });
});

describe("D085 C11 — C: snapshot resource limits (bounded, never allocating)", () => {
  it("#43 rejects a declared array length beyond the limit WITHOUT allocating", () => {
    /*
      r11 read `length` from the descriptor (correct) and then allocated a Set
      of that many index strings and iterated — with `length` legally up to
      4,294,967,295. This fixture DECLARES the huge length through a proxy
      descriptor and never allocates it, so the test itself stays small.
    */
    const arrayLike = new Proxy([], {
      getOwnPropertyDescriptor(t, k) {
        if (k === "length") return { value: 4294967295, writable: true, enumerable: false, configurable: false };
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      ownKeys() { return ["length"]; },
    });
    const before = process.memoryUsage().rss;
    const started = Date.now();
    const snap = safeSnapshot(arrayLike, "a");
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.problems[0].why).toContain("beyond the");
    // Bounded in time and memory, which is the point.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("publishes explicit conservative limits", () => {
    expect(SNAPSHOT_LIMITS.maxArrayLength).toBeLessThanOrEqual(100_000);
    expect(SNAPSHOT_LIMITS.maxKeysPerObject).toBeLessThanOrEqual(10_000);
    expect(SNAPSHOT_LIMITS.maxVisitedNodes).toBeLessThanOrEqual(1_000_000);
    expect(SNAPSHOT_LIMITS.maxTotalStringBytes).toBeLessThanOrEqual(64_000_000);
    expect(SNAPSHOT_LIMITS.maxProblems).toBeLessThanOrEqual(10_000);
  });

  it.each([
    ["too many keys", () => { const o: Record<string, number> = {}; for (let i = 0; i <= SNAPSHOT_LIMITS.maxKeysPerObject; i += 1) o[`k${i}`] = i; return o; }],
    ["an over-long array", () => Array.from({ length: SNAPSHOT_LIMITS.maxArrayLength + 1 }, () => 0)],
  ])("rejects %s", (_l, build) => {
    expect(safeSnapshot(build(), "x").ok).toBe(false);
  });

  it.each([
    ["a modest array", () => Array.from({ length: 100 }, (_, i) => i)],
    ["a modest object", () => { const o: Record<string, number> = {}; for (let i = 0; i < 100; i += 1) o[`k${i}`] = i; return o; }],
  ])("POSITIVE CONTROL: still accepts %s", (_l, build) => {
    expect(safeSnapshot(build(), "x").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Correction 12 — findings 1-9, made permanent
// ---------------------------------------------------------------------------

describe("D085 C12 — A: the snapshot's resource contract means what it says", () => {
  it("#1 counts UTF-8 BYTES, not UTF-16 code units", () => {
    /*
      r12 accumulated `string.length`. 4,200,000 two-byte characters are
      4,200,000 code units but 8,400,000 UTF-8 bytes, so they passed an
      8,000,000-byte budget. A budget denominated in the wrong unit is not a
      budget.
    */
    const twoByte = "é".repeat(4_200_000);
    expect(twoByte.length).toBeLessThan(SNAPSHOT_LIMITS.maxTotalStringBytes);
    expect(Buffer.byteLength(twoByte, "utf8")).toBeGreaterThan(SNAPSHOT_LIMITS.maxTotalStringBytes);
    expect(safeSnapshot({ s: twoByte }, "o").ok).toBe(false);
  });

  it.each([
    ["ASCII", "a", 1],
    ["2-byte", "é", 2],
    ["3-byte", "€", 3],
    ["4-byte surrogate pair", "𝄞", 4],
  ])("measures %s as %i byte(s)", (_l, ch, bytes) => {
    expect(utf8BytesUpTo(ch, 100)).toBe(bytes);
    expect(utf8BytesUpTo(ch, 100)).toBe(Buffer.byteLength(ch, "utf8"));
  });

  it("abandons measurement once the budget is exceeded, rather than walking the whole string", () => {
    // Bounded by the budget, not by the input.
    expect(utf8BytesUpTo("a".repeat(1000), 10)).toBe(11);
  });

  it("#2 counts object KEY bytes, not only values", () => {
    // r12 never counted keys at all: one 8,000,001-byte key returned ok:true.
    const key = "k".repeat(SNAPSHOT_LIMITS.maxTotalStringBytes + 1);
    const o = Object.create(null) as Record<string, unknown>;
    o[key] = 1;
    expect(safeSnapshot(o, "o").ok).toBe(false);
  });

  it("#3 no diagnostic helper reads the caller's object", () => {
    /*
      `exactMap` called `describe(originalValue)`, and `describe` read
      `value.length` — a SECOND observation, through which a stateful array
      Proxy threw straight out of the boundary.
    */
    let lengthReads = 0;
    const hostile = new Proxy([1, 2], {
      get(t, k, r) { if (k === "length") { lengthReads += 1; throw new Error("length trap"); } return Reflect.get(t, k, r); },
    });
    for (const call of [
      () => { const p: SchemaProblem[] = []; exactMap(hostile, "x", ["a"], [], p); return p; },
      () => { const p: SchemaProblem[] = []; typedArray({ not: "an array" }, "x", () => {}, p); return p; },
    ]) {
      let problems!: SchemaProblem[];
      expect(() => { problems = call(); }).not.toThrow();
      expect(problems.length).toBeGreaterThan(0);
    }
    expect(lengthReads, "the caller's length must never be read").toBe(0);
  });

  it("#4 takes exactly ONE ownKeys observation and drops nothing it saw", () => {
    /*
      r12 called `getOwnPropertyDescriptors` AND `getOwnPropertySymbols`. A
      Proxy returning ["visible", Symbol] then ["visible"] produced ok:true
      with the symbol silently dropped.
    */
    const sym = Symbol("hidden");
    const target: Record<string | symbol, unknown> = { visible: 1 };
    target[sym] = 2;
    let ownKeysCalls = 0;
    const p = new Proxy(target, {
      ownKeys(t) { ownKeysCalls += 1; return ownKeysCalls === 1 ? Reflect.ownKeys(t) : ["visible"]; },
    });
    const r = safeSnapshot(p, "o");
    expect(ownKeysCalls, "exactly one ownKeys observation").toBe(1);
    expect(r.ok, "the symbol seen in that observation must not be dropped").toBe(false);
  });

  it("#5 enforces the key bound BEFORE requesting descriptors", () => {
    /*
      A 5,000-key Proxy drove 5,000 getOwnPropertyDescriptor calls before a
      512-key refusal — the bound protected nothing it was meant to.
    */
    let descriptorCalls = 0;
    const keys = Array.from({ length: SNAPSHOT_LIMITS.maxKeysPerObject + 500 }, (_, i) => `k${i}`);
    const p = new Proxy({}, {
      ownKeys() { return keys; },
      getOwnPropertyDescriptor() { descriptorCalls += 1; return { value: 1, enumerable: true, writable: true, configurable: true }; },
    });
    expect(safeSnapshot(p, "o").ok).toBe(false);
    expect(descriptorCalls, "no descriptor may be requested once the key count is refused").toBe(0);
  });

  it("STATES the irreducible limit rather than overclaiming", () => {
    // Bounds limit what D085 ASKS a trap to do. They cannot bound what the
    // trap itself executes; JavaScript offers no pre-emption.
    const src = readFileSync(resolve("lib/meta/runtime-schema.ts"), "utf8");
    // The sentence wraps across lines in the source comment.
    expect(src.replace(/\s+/g, " ")).toMatch(/cannot pre-empt arbitrary work or nontermination/i);
  });

  it("#6 array and object bounds are coherent, at the exact boundary", () => {
    // r12 published maxArrayLength 10,000 while a 513-element array rejected.
    expect(SNAPSHOT_LIMITS.maxArrayLength).toBe(SNAPSHOT_LIMITS.maxKeysPerObject);
    expect(safeSnapshot(Array.from({ length: SNAPSHOT_LIMITS.maxArrayLength }, () => 0), "a").ok).toBe(true);
    expect(safeSnapshot(Array.from({ length: SNAPSHOT_LIMITS.maxArrayLength + 1 }, () => 0), "a").ok).toBe(false);
    const atKeyLimit: Record<string, number> = {};
    for (let i = 0; i < SNAPSHOT_LIMITS.maxKeysPerObject; i += 1) atKeyLimit[`k${i}`] = i;
    expect(safeSnapshot(atKeyLimit, "o").ok).toBe(true);
    atKeyLimit.oneMore = 1;
    expect(safeSnapshot(atKeyLimit, "o").ok).toBe(false);
  });

  it("#7 records at most exactly maxProblems, never one more", () => {
    // The sentinel used to push the list to maxProblems + 1.
    const o = Object.create(null) as Record<string, unknown>;
    for (let i = 0; i < SNAPSHOT_LIMITS.maxProblems + 200; i += 1) {
      Object.defineProperty(o, `k${i}`, { value: 1, enumerable: false, configurable: true });
    }
    const r = safeSnapshot(o, "o");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxProblems);
  });
});

describe.skipIf(!RESOLVER_APPROVED)("D085 C12 — B: hash and receipt honesty", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error("baseline must preview");
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };

  it("#8 refuses to mint a canonical hash for a fully-keyed NULL pair", () => {
    /*
      r12 validated only top-level key SETS, so a request and receipt carrying
      every required key with null values returned a canonical-looking
      `meta.budget-preview-receipt.v9:<64hex>`. A public function that mints
      plausible receipt hashes for invalid pairs is a forgery aid.
    */
    const req: Record<string, unknown> = {};
    for (const k of WOULD_WRITE_REQUEST_KEYS) req[k] = null;
    const rc: Record<string, unknown> = {};
    for (const k of RECEIPT_REQUIRED_KEYS) rc[k] = null;
    const h = recomputePreviewHash({ request: req, receipt: rc } as never);
    expect(h).toContain("-unobservable/");
    expect(h).not.toMatch(/^meta\.budget-preview-receipt\.v\d+:[0-9a-f]{64}$/);
  });

  it("#8b still hashes a GENUINE pair", () => {
    const g = genuine();
    expect(recomputePreviewHash(g)).toBe(g.receipt.receiptHash);
  });

  it("#9 classifies the seed digests HONESTLY as attested, not cross-bound", () => {
    /*
      Codex changed BOTH digests, recomputed both preview keys from them, and
      resealed: verification returned true. r12 called the seeds `cross_bound`
      and the keys "genuinely derivable". The keys derive only RELATIVE to the
      seeds; the seeds themselves are attested, because the durable keys that
      would falsify them are deliberately absent.
    */
    for (const f of ["keySeed", "keySeed.intentKeyDigest", "keySeed.idempotencyKeyDigest"]) {
      expect(RECEIPT_FIELD_COVERAGE.find((e) => e.field === f)?.classification, f).toBe("attested_domain");
    }
    const nonRecomputable = RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields.map((x) => x.field);
    expect(nonRecomputable).toContain("receipt.keySeed.intentKeyDigest");
    expect(nonRecomputable).toContain("receipt.keySeed.idempotencyKeyDigest");
    expect(JSON.stringify(RECEIPT_VERIFICATION_GUARANTEE.doesNotEstablish)).toContain("coherent substitution");
  });

  it("#9 accepts a fully coherent seed substitution — the PUBLISHED limitation", () => {
    // Asserted so the limitation is measured, not assumed. Detecting this
    // needs a server-held secret or an authoritative durable lookup.
    const g = genuine();
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    const intentKeyDigest = sha("forged-intent"), idempotencyKeyDigest = sha("forged-idem");
    const rc = { ...g.receipt, keySeed: { intentKeyDigest, idempotencyKeyDigest } } as ReceiptPreview;
    rc.previewKey = derivePreviewKey({
      inputFingerprint: rc.inputFingerprint!, intentKeyDigest,
      businessId: rc.scope.businessId, providerAccountId: rc.scope.providerAccountId, entityId: rc.scope.entityId!,
    });
    const rq = { ...g.request, idempotencyKeyPreview: previewIdempotencyKey(idempotencyKeyDigest, rc.inputFingerprint!) };
    rc.receiptHash = recomputePreviewHash({ request: rq, receipt: rc });
    expect(verifyReceiptPreviewIntegrity({ request: rq, receipt: rc }).verified).toBe(true);
  });

  it("#9 STILL rejects an isolated preview-key substitution", () => {
    // The seeds unchanged, one key swapped: the derivation catches it.
    const g = genuine();
    for (const mutate of [
      (): [WouldWriteRequest, ReceiptPreview] => [g.request, { ...g.receipt, previewKey: `${g.receipt.previewKeyNamespace}:${"c".repeat(64)}` }],
      (): [WouldWriteRequest, ReceiptPreview] => [{ ...g.request, idempotencyKeyPreview: `${g.receipt.previewKeyNamespace}-idem:${"d".repeat(64)}` }, g.receipt],
    ]) {
      const [rq, rc] = mutate();
      const sealed = { ...rc, receiptHash: recomputePreviewHash({ request: rq, receipt: rc }) } as ReceiptPreview;
      expect(verifyReceiptPreviewIntegrity({ request: rq, receipt: sealed }).verified).toBe(false);
    }
  });

  it("earlier receipt contracts v1..v9 report UNVERIFIABLE", () => {
    const g = genuine();
    for (let n = 1; n <= 9; n += 1) {
      const legacy = { ...g.receipt, previewContractVersion: `meta.budget-preview-receipt.v${n}` } as unknown as ReceiptPreview;
      const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: legacy });
      expect(v.verified, `v${n}`).toBe(false);
      expect(v.problems.join("; "), `v${n}`).toContain("cannot be verified rather than being valid");
    }
  });
});

// ---------------------------------------------------------------------------
// Correction 13 — finding 1: ONE shared pre-hash eligibility layer
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C13 — recompute and verify share one rule set", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error("baseline must preview");
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };
  const SENTINEL = /-unobservable\//;
  const CANONICAL = /^meta\.budget-preview-receipt\.v\d+:[0-9a-f]{64}$/;

  it("POSITIVE CONTROL: a genuine pair recomputes and verifies", () => {
    const g = genuine();
    expect(recomputePreviewHash(g)).toBe(g.receipt.receiptHash);
    expect(recomputePreviewHash(g)).toMatch(CANONICAL);
    const v = verifyReceiptPreviewIntegrity(g);
    expect(v.problems).toEqual([]);
    expect(v.verified).toBe(true);
  });

  it("#1A budgetEndpointExists:false yields the SENTINEL, not a canonical hash", () => {
    /*
      The exact Codex case. r13 returned
      meta.budget-preview-receipt.v10:85ed82d9… because the hash function ran
      only `validateWouldWriteSemantics` while the capability layer lived
      inside the verifier — two rule sets that drifted.
    */
    const g = genuine();
    const rc = { ...g.receipt, capabilitySnapshot: { ...g.receipt.capabilitySnapshot!, budgetEndpointExists: false } } as ReceiptPreview;
    const h = recomputePreviewHash({ request: g.request, receipt: rc });
    expect(h).toMatch(SENTINEL);
    expect(h).not.toMatch(CANONICAL);
  });

  it("#1B a stale previewContractVersion yields the SENTINEL", () => {
    // The second exact Codex case: r13 returned …v10:6615388c… for a v9 receipt.
    const g = genuine();
    const rc = { ...g.receipt, previewContractVersion: "meta.budget-preview-receipt.v10" } as unknown as ReceiptPreview;
    const h = recomputePreviewHash({ request: g.request, receipt: rc });
    expect(h).toMatch(SENTINEL);
    expect(h).not.toMatch(CANONICAL);
  });

  it.each([
    ["dispatchVerbExists:false", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, dispatchVerbExists: false } })],
    ["an empty supportedFields", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, supportedFields: [] } })],
    ["an unsupported requested field", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, supportedFields: ["lifetime_budget"] } })],
    ["non-canonical supportedFields order", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, supportedFields: ["lifetime_budget", "daily_budget"] } })],
    ["duplicated supportedFields", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, supportedFields: ["daily_budget", "daily_budget"] } })],
    ["a blank capability source", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, source: "" } })],
    ["a blank capability why", (c: ReceiptPreview) => ({ ...c, capabilitySnapshot: { ...c.capabilitySnapshot!, why: "" } })],
    ["a mismatched capabilityFingerprint", (c: ReceiptPreview) => ({ ...c, capabilityFingerprint: `x-cap:${"a".repeat(64)}` })],
    ["an absent previewContractVersion", (c: ReceiptPreview) => { const { previewContractVersion: _d, ...rest } = c; return rest as ReceiptPreview; }],
    ["an unversioned previewContractVersion", (c: ReceiptPreview) => ({ ...c, previewContractVersion: "" })],
  ] as Array<[string, (c: ReceiptPreview) => ReceiptPreview]>)(
    "the whole shared boundary: %s yields the SENTINEL", (_l, mutate) => {
      const g = genuine();
      const h = recomputePreviewHash({ request: g.request, receipt: mutate(g.receipt) });
      expect(h).toMatch(SENTINEL);
      expect(h).not.toMatch(CANONICAL);
    });

  it("the two callers consume the SAME eligibility result, not two rule sets", () => {
    /*
      The structural assertion. For every case below, `recomputePreviewHash`
      returning the sentinel and `verifyReceiptPreviewIntegrity` refusing must
      agree, because both read `evaluateHashEligibility`.
    */
    const g = genuine();
    const cases: Array<[string, ReceiptPreview]> = [
      ["genuine", g.receipt],
      ["no endpoint", { ...g.receipt, capabilitySnapshot: { ...g.receipt.capabilitySnapshot!, budgetEndpointExists: false } } as ReceiptPreview],
      ["stale contract", { ...g.receipt, previewContractVersion: "meta.budget-preview-receipt.v10" } as unknown as ReceiptPreview],
      ["bad fingerprint", { ...g.receipt, capabilityFingerprint: `x-cap:${"b".repeat(64)}` } as ReceiptPreview],
      ["unsupported field", { ...g.receipt, capabilitySnapshot: { ...g.receipt.capabilitySnapshot!, supportedFields: ["lifetime_budget"] } } as ReceiptPreview],
    ];
    for (const [label, receipt] of cases) {
      const eligibility = evaluateHashEligibility({ request: g.request, receipt });
      const hash = recomputePreviewHash({ request: g.request, receipt });
      // Reseal through the TEST-ONLY raw helper so the verifier is judged on
      // eligibility, not on a hash the production path refused to mint.
      const sealed = { ...receipt, receiptHash: rawCanonicalPreviewHashForTests({ request: g.request, receipt }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
      const verified = verifyReceiptPreviewIntegrity({ request: g.request, receipt: sealed }).verified;
      expect(hash.includes("-unobservable/"), `${label}: hash sentinel must track eligibility`).toBe(!eligibility.eligible);
      expect(verified, `${label}: verification must track the same eligibility`).toBe(eligibility.eligible);
    }
  });

  /*
    The whole-graph production-boundary invariant MOVED to the always-run
    audit suite in Correction 15.

    The version that lived here walked four directories of eight, matched
    `.ts`/`.tsx` while this repository also ships production `.js`/`.mjs`, and
    sat inside `describe.skipIf(!RESOLVER_APPROVED)` — so the ordinary
    no-approval run skipped the guard entirely. A guard that only runs under
    approval does not run. See "D085 C15 #2" in
    `scripts/audits/d085-budget-proposal-dry-run.test.ts`.
  */

  it("the production module exports no raw-hash escape hatch at all", () => {
    const api = Object.keys(dryRunModule);
    expect(api.filter((k) => /raw|unsafe|forge/i.test(k))).toEqual([]);
  });

  it("the attested seed substitution remains ACCEPTED and recomputable", () => {
    /*
      Correction 13 must not quietly promote attested seeds to authenticated
      data in order to look stricter. A coherent substitution of BOTH digests,
      with both preview keys rederived, still recomputes and still verifies —
      exactly as published.
    */
    const g = genuine();
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    const intentKeyDigest = sha("forged-intent-c13"), idempotencyKeyDigest = sha("forged-idem-c13");
    const rc = { ...g.receipt, keySeed: { intentKeyDigest, idempotencyKeyDigest } } as ReceiptPreview;
    rc.previewKey = derivePreviewKey({
      inputFingerprint: rc.inputFingerprint!, intentKeyDigest,
      businessId: rc.scope.businessId, providerAccountId: rc.scope.providerAccountId, entityId: rc.scope.entityId!,
    });
    const rq = { ...g.request, idempotencyKeyPreview: previewIdempotencyKey(idempotencyKeyDigest, rc.inputFingerprint!) };
    const h = recomputePreviewHash({ request: rq, receipt: rc });
    expect(h, "an attested-seed substitution is eligible, by design").toMatch(CANONICAL);
    rc.receiptHash = h;
    expect(verifyReceiptPreviewIntegrity({ request: rq, receipt: rc }).verified).toBe(true);
  });

  it("an isolated preview-key substitution is still refused", () => {
    const g = genuine();
    const rc = { ...g.receipt, previewKey: `${g.receipt.previewKeyNamespace}:${"c".repeat(64)}` } as ReceiptPreview;
    expect(recomputePreviewHash({ request: g.request, receipt: rc })).toMatch(SENTINEL);
    const sealed = { ...rc, receiptHash: rawCanonicalPreviewHashForTests({ request: g.request, receipt: rc }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
    expect(verifyReceiptPreviewIntegrity({ request: g.request, receipt: sealed }).verified).toBe(false);
  });

  it("earlier receipt contracts v1..v10 report UNVERIFIABLE", () => {
    const g = genuine();
    for (let n = 1; n <= 10; n += 1) {
      const legacy = { ...g.receipt, previewContractVersion: `meta.budget-preview-receipt.v${n}` } as unknown as ReceiptPreview;
      const v = verifyReceiptPreviewIntegrity({ request: g.request, receipt: legacy });
      expect(v.verified, `v${n}`).toBe(false);
      expect(v.problems.join("; "), `v${n}`).toContain("cannot be verified rather than being valid");
      expect(evaluateHashEligibility({ request: g.request, receipt: legacy }).unverifiable, `v${n}`).toBe(true);
    }
  });

});

// ---------------------------------------------------------------------------
// Correction 14 — findings 1-7, made permanent
// ---------------------------------------------------------------------------

describe.skipIf(!RESOLVER_APPROVED)("D085 C14 — one rule source, wrapper included", () => {
  const genuine = () => {
    const r = buildBudgetProposalDryRun(bestCase());
    if (r.status !== "would_write_available") throw new Error("baseline must preview");
    return { request: r.wouldWriteRequest, receipt: r.receiptPreview };
  };
  const SENT = /-unobservable\//;

  it("POSITIVE CONTROL: a genuine pair verifies and recomputes", () => {
    const g = genuine();
    expect(verifyReceiptPreviewIntegrity(g).verified).toBe(true);
    expect(recomputePreviewHash(g)).toBe(g.receipt.receiptHash);
  });

  it.each([
    ["an extra enumerable top-level key", (g: { request: unknown; receipt: unknown }) => ({ ...g, extraTopLevelKey: 1 })],
    ["a missing request key", (g: { receipt: unknown }) => ({ receipt: g.receipt })],
    ["a missing receipt key", (g: { request: unknown }) => ({ request: g.request })],
    ["a third named section", (g: object) => ({ ...g, meta: {} })],
  ])("#1 both APIs agree on %s", (_l, wrap) => {
    /*
      r14 exact-validated the wrapper in `recomputePreviewHash` and NOT in
      `verifyReceiptPreviewIntegrity`, so a genuine pair plus one extra
      top-level key verified TRUE and hashed to the sentinel — one input, two
      answers, from the pair whose agreement r13 asserted.
    */
    const wrapper = wrap(genuine() as never);
    const verified = verifyReceiptPreviewIntegrity(wrapper).verified;
    const hashed = !SENT.test(recomputePreviewHash(wrapper));
    expect(verified, "verification must refuse a mis-shaped wrapper").toBe(false);
    expect(hashed, "hashing must refuse the same wrapper").toBe(false);
    expect(verified).toBe(hashed);
  });

  it("#2 every public hash/integrity boundary is TOTAL on hostile input", () => {
    const g = genuine();
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const cyclic: Record<string, unknown> = { ...g.request };
    cyclic.self = cyclic;
    const throwingGetter = Object.defineProperty({ ...g.receipt }, "previewContractVersion", {
      get() { throw new Error("getter trap"); }, enumerable: true, configurable: true,
    });
    const statefulProxy = new Proxy({ ...g.receipt }, {
      get(t, k, r) { if (k === "previewContractVersion") throw new Error("stateful"); return Reflect.get(t, k, r); },
    });
    const symbolled: Record<string | symbol, unknown> = { ...g.receipt };
    symbolled[Symbol("s")] = 1;
    const nonEnumerable = { ...g.receipt };
    Object.defineProperty(nonEnumerable, "hidden", { value: 1, enumerable: false });

    const hostiles: unknown[] = [
      null, undefined, 7, "x", [], true, Symbol("s"), () => 1, BigInt(1),
      { request: null, receipt: null },
      { request: revoked, receipt: g.receipt },
      { request: g.request, receipt: revoked },
      { request: cyclic, receipt: g.receipt },
      { request: { ...g.request, currentMinorUnits: BigInt(1) }, receipt: g.receipt },
      { request: g.request, receipt: throwingGetter },
      { request: g.request, receipt: statefulProxy },
      { request: g.request, receipt: symbolled },
      { request: g.request, receipt: nonEnumerable },
    ];
    for (const h of hostiles) {
      const label = typeof h === "object" && h !== null ? "wrapper" : String(typeof h);
      expect(() => evaluateHashEligibility(h), `evaluateHashEligibility threw on ${label}`).not.toThrow();
      expect(() => recomputePreviewHash(h), `recomputePreviewHash threw on ${label}`).not.toThrow();
      expect(() => verifyReceiptPreviewIntegrity(h), `verify threw on ${label}`).not.toThrow();
      // Deterministic: the same hostile input twice gives the same answer.
      expect(recomputePreviewHash(h)).toBe(recomputePreviewHash(h));
    }
  });

  it("#3 ROUND TRIP: every successful assembly satisfies its own verifier", () => {
    /*
      r14 minted with the raw canonical hash and never consulted eligibility,
      so it PRODUCED receipts its own verifier rejects. This is the property,
      not a list of examples.
    */
    const variants: Array<[string, DryRunInput]> = [
      ["adset", bestCase()],
      ["campaign", campaignGrain()],
      ["adset, 25%", bestCase({ percent: 25, rawIntent: { ...bestCase().rawIntent!, percent: 25 } })],
    ];
    for (const [label, input] of variants) {
      const r = buildBudgetProposalDryRun(input);
      expect(r.status, label).toBe("would_write_available");
      if (r.status !== "would_write_available") continue;
      const pair = { request: r.wouldWriteRequest, receipt: r.receiptPreview };
      const v = verifyReceiptPreviewIntegrity(pair);
      expect(v.problems, label).toEqual([]);
      expect(v.verified, label).toBe(true);
      expect(recomputePreviewHash(pair), label).toBe(r.receiptPreview.receiptHash);
      expect(evaluateHashEligibility(pair).eligible, label).toBe(true);
    }
  });

  it.each([
    ["a blank outer accountSelectionWhy", { accountSelectionWhy: "" }],
    ["a foreign outer parentCampaignId on a campaign", { parentCampaignId: "foreign" }],
    ["a blank outer business name", { business: "" }],
  ])("#3 assembly REFUSES %s rather than minting a self-invalid receipt", (_l, over) => {
    const input = campaignGrain();
    const out = assembleWouldWritePreview({
      scope: { ...input.scope, ...over },
      rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      budgetField: "daily_budget", casBaseline: input.casBaseline!, decisionId: "dec_1",
      writeSafety: input.writeSafety, capability: SYN,
      inputFingerprint: buildBudgetProposalDryRun(input).inputFingerprint,
    } as never);
    expect("refused" in out).toBe(true);
  });

  it("#6 ONE lineage source: registry, contract and artifact agree and are contiguous", () => {
    // r14 exported a hand-maintained list stuck at v1-v5 while the contract was
    // v14 and the artifact reported v1-v13.
    const current = Number(/\.v(\d+)$/.exec(META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT)![1]);
    expect(META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS).toEqual(
      Array.from({ length: current - 1 }, (_, i) => `meta.budget-proposal-dry-run.v${i + 1}`),
    );
    const receiptCurrent = Number(/\.v(\d+)$/.exec(PREVIEW_CONTRACT_VERSION)![1]);
    expect(META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS).toEqual(
      Array.from({ length: receiptCurrent - 1 }, (_, i) => `meta.budget-preview-receipt.v${i + 1}`),
    );
  });

  it("#7 EVERY attested/opaque coverage entry is published as non-recomputable", () => {
    /*
      The anti-drift invariant. r14's guarantee listed three fields while the
      ledger classified more as attested — documentation and field ledger
      could disagree indefinitely.
    */
    const attested = [
      ...REQUEST_FIELD_COVERAGE.filter((e) => e.classification === "attested_domain").map((e) => `request.${e.field}`),
      ...RECEIPT_FIELD_COVERAGE.filter((e) => e.classification === "attested_domain").map((e) => `receipt.${e.field}`),
    ].sort();
    const published: string[] = RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields.map((f) => f.field);

    // Nothing may be published as non-recomputable that the ledger does not classify as attested.
    expect(published.filter((f) => !attested.includes(f)), "published but not classified attested").toEqual([]);
    /*
      ...and every attested entry must be published, either itself or — for a
      container such as `receipt.keySeed`, which is exactly a map of attested
      leaves — through every one of its attested leaves.
    */
    const unpublished = attested.filter((f) => {
      if (published.includes(f)) return false;
      const leaves = attested.filter((x) => x.startsWith(`${f}.`));
      return leaves.length === 0 || !leaves.every((l) => published.includes(l));
    });
    expect(unpublished, "attested but not published as non-recomputable").toEqual([]);
    for (const f of RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields) {
      expect(f.reason.length, `${f.field} needs a stated reason`).toBeGreaterThan(20);
    }
  });

  it("#7 the CAS and read-back fingerprints are honestly attested, not authenticated", () => {
    const g = genuine();
    const other = `meta.provider-readback.v4:${"e".repeat(64)}`;
    // A coherent replacement is ACCEPTED — published, tested, not overclaimed.
    const rc = { ...g.receipt, readbackFingerprint: other } as ReceiptPreview;
    const sealed = { ...rc, receiptHash: rawCanonicalPreviewHashForTests({ request: g.request, receipt: rc }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
    expect(verifyReceiptPreviewIntegrity({ request: g.request, receipt: sealed }).verified).toBe(true);
    // ...and the prose says so, and does not claim provider agreement.
    const text = JSON.stringify(RECEIPT_VERIFICATION_GUARANTEE);
    expect(text).toContain("receipt-internal");
    expect(text).toMatch(/any other valid meta\.provider-readback\.v4 digest is indistinguishable locally/);
    expect(text).toMatch(/not agreement with a provider baseline/);
  });

  it("#7 a CAS fingerprint that disagrees BETWEEN the two artefacts is still refused", () => {
    // Attested does not mean unchecked: receipt-internal equality still holds.
    const g = genuine();
    const rc = { ...g.receipt, casBaselineFingerprint: `meta.provider-readback.v4:${"f".repeat(64)}` } as ReceiptPreview;
    const sealed = { ...rc, receiptHash: rawCanonicalPreviewHashForTests({ request: g.request, receipt: rc }, PREVIEW_CONTRACT_VERSION) } as ReceiptPreview;
    expect(verifyReceiptPreviewIntegrity({ request: g.request, receipt: sealed }).verified).toBe(false);
  });
});
