import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";

import {
  D081_CONTRACT_ID,
  D081_JSON_OUT,
  D081_PINNED_INPUTS,
  D081_TARGET_BLOCKERS,
  TRUTH_LABELS,
  buildArtifact,
  buildRoleLeakageChecks,
  buildWorkedIntentExample,
  replayCapabilities,
  runVerify,
  sealArtifact,
} from "@/scripts/audits/d081-meta-budget-capability-foundations";

const ARTIFACT = JSON.parse(readFileSync(resolvePath(D081_JSON_OUT), "utf8")) as Record<string, any>;
const D080B = JSON.parse(
  readFileSync(resolvePath(D081_PINNED_INPUTS.d080bArtifactPath), "utf8"),
) as Record<string, any>;
const clone = () => JSON.parse(JSON.stringify(ARTIFACT)) as Record<string, any>;

describe("D081-D — the replay is pinned to the accepted D080B package", () => {
  it("verifies the pinned D080B hashes before using it", () => {
    const observed = createHash("sha256")
      .update(readFileSync(resolvePath(D081_PINNED_INPUTS.d080bArtifactPath)))
      .digest("hex");
    expect(observed).toBe(D081_PINNED_INPUTS.d080bArtifactSha256);
    expect(D080B.artifactHash).toBe(D081_PINNED_INPUTS.d080bArtifactHash);
    expect(D080B.snapshot.snapshotHash).toBe(D081_PINNED_INPUTS.d080bSnapshotHash);
  });

  it("does not duplicate the ten-megabyte snapshot", () => {
    const size = readFileSync(resolvePath(D081_JSON_OUT)).length;
    expect(size).toBeLessThan(200_000);
    expect(JSON.stringify(ARTIFACT)).not.toContain("\"reads\"");
  });

  it("is independently reproducible from the pinned artifact plus this code", () => {
    const rebuilt = buildArtifact(D080B);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(ARTIFACT));
    expect(runVerify().ok).toBe(true);
  });

  it("is deterministic across repeated builds", () => {
    expect(JSON.stringify(buildArtifact(D080B))).toBe(JSON.stringify(buildArtifact(D080B)));
  });
});

describe("D081-D — what the three capabilities actually resolve", () => {
  const replay = ARTIFACT.replay;

  it("keeps the same denominators D080B established", () => {
    expect(replay.denominators.proposals).toBe(247_050);
    expect(replay.denominators.origins).toBe(17);
    expect(replay.denominators.entities).toBe(2_430);
    expect(replay.denominators.businesses).toBe(6);
  });

  it("shows all three target blockers hit every row before D081", () => {
    for (const code of D081_TARGET_BLOCKERS) {
      expect(replay.before[code], code).toBe(247_050);
    }
  });

  it("closes the vocabulary and unit blockers, and reports the role blocker honestly", () => {
    expect(replay.resolvable.decision_vocabulary_absent.rows).toBe(247_050);
    expect(replay.resolvable.decision_vocabulary_absent.closure)
      .toBe("implemented_and_integrated_canonical_capability");
    expect(replay.resolvable.unit_exponent_unknown.rows).toBe(247_050);
    // Under the exact canonical rule — system_inferred, high confidence, and a
    // validated resolver version — the frozen snapshot resolves nothing,
    // because it never retained a resolver version at all.
    expect(replay.resolvable.role_authority_absent.rows).toBe(0);
    expect(replay.resolvable.role_authority_absent.closure).toBe("residual_data_gap");
    expect(String(replay.resolvable.role_authority_absent.evidence)).toContain("resolver_version");
    // BOTH missing provenances are named, not just one.
    expect(replay.resolvable.role_authority_absent.missingProvenance)
      .toEqual(["kind_source", "resolver_version"]);
    expect(replay.residual.blockerCensus.role_authority_absent).toBe(247_050);
  });

  it("distinguishes integrated capability from a resolved row and from a data gap", () => {
    const closures = Object.values(replay.resolvable as Record<string, { closure: string }>)
      .map((v) => v.closure);
    expect(new Set(closures).size).toBeGreaterThan(1);
    for (const c of closures) {
      expect([
        "implemented_and_integrated_canonical_capability",
        "frozen_data_resolvable_under_exact_canonical_authority",
        "residual_data_gap",
      ]).toContain(c);
    }
  });

  it("reports the canonical integration of the typed intent as verified fact", () => {
    const ci = ARTIFACT.capabilities.typedBudgetIntent.canonicalIntegration;
    expect(ci.member).toContain("MetaOsDecisionAction");
    expect(ci.adapter).toBe("toCanonicalDecisionAction");
    expect(ci.servedIntent).toBe("review");
    expect(ci.providerMutation).toBeNull();
    expect(ci.dispatchVerbAdded).toBe(false);
    expect(ci.proposalQueueWidened).toBe(false);
    expect(ci.payloadLossless).toBe(true);
    // The claim must name the REAL production chain: route -> builder ->
    // producer -> served block.
    expect(String(ci.runtimeConsumer)).toContain("app/api/meta/decisions-workspace/route.ts");
    expect(String(ci.runtimeConsumer)).toContain("buildMetaOsDecisionsPresentation");
    expect(String(ci.runtimeConsumer)).toContain("budgetReview");
    expect(String(ci.discriminatedUnion)).toContain("MetaOsBudgetDecisionAction");
    expect(ARTIFACT.capabilities.typedBudgetIntent.truth).toBe("verified_fact");
  });

  it("publishes the canonical role rule it enforces", () => {
    const rule = ARTIFACT.capabilities.accountScopedRoleAuthority.canonicalRule;
    expect(rule.requiredConfidence).toBe("high");
    expect(rule.requiresValidatedResolverVersion).toBe(true);
    expect(rule.manualLabelAccepted).toBe(false);
    expect(ARTIFACT.capabilities.accountScopedRoleAuthority.boundToCanonicalValidator)
      .toBe("isCampaignContextResolverAuthorityValidated");
    expect(String(ARTIFACT.capabilities.accountScopedRoleAuthority.runtimeConsumer))
      .toContain("decisions-workspace-read-model");
  });

  it("reconciles all four dimensional breakdowns to the headline", () => {
    const r = replay.reconciliation;
    expect(r.reconciles).toBe(true);
    for (const total of [r.perBusinessTotal, r.perAccountTotal, r.perGrainTotal, r.perFoldTotal]) {
      expect(total).toBe(247_050);
    }
    expect(replay.perBusiness).toHaveLength(6);
    expect(replay.perAccount).toHaveLength(7);
    expect(replay.perGrain.map((g: any) => g.grain).sort()).toEqual(["adset", "campaign"]);
    expect(replay.perFold).toHaveLength(4);
    // Every dimensional resolvable count is bounded by that dimension's rows.
    for (const dim of [replay.perBusiness, replay.perAccount, replay.perGrain, replay.perFold]) {
      for (const row of dim) {
        expect(row.unit_resolvable).toBeLessThanOrEqual(row.proposals);
        expect(row.role_resolvable).toBeLessThanOrEqual(row.proposals);
        expect(row.vocabulary_resolvable).toBe(row.proposals);
      }
    }
  });

  it("keeps selected and deselected accounts separate in the account dimension", () => {
    const deselected = replay.perAccount.filter((a: any) => a.is_selected === false);
    expect(deselected).toHaveLength(1);
    expect(deselected[0].proposals).toBeGreaterThan(0);
    const selectedTotal = replay.perAccount
      .filter((a: any) => a.is_selected)
      .reduce((n: number, a: any) => n + a.proposals, 0);
    expect(selectedTotal + deselected[0].proposals).toBe(247_050);
  });

  it("does not pretend anything became executable", () => {
    expect(replay.residual.proposalsWithNoResidualBlocker).toBe(0);
    expect(ARTIFACT.limits.executable).toBe(false);
    expect(ARTIFACT.capabilities.typedBudgetIntent.executable).toBe(false);
    expect(String(ARTIFACT.limits.note)).toContain("does not make any proposal executable");
  });

  it("removes only the blockers it genuinely closes", () => {
    // Every non-target blocker must survive unchanged.
    for (const [code, count] of Object.entries(replay.before as Record<string, number>)) {
      if ((D081_TARGET_BLOCKERS as readonly string[]).includes(code)) continue;
      expect(replay.residual.blockerCensus[code], code).toBe(count);
    }
    expect(replay.residual.blockerCensus.decision_vocabulary_absent).toBeUndefined();
    expect(replay.residual.blockerCensus.unit_exponent_unknown).toBeUndefined();
  });

  it("labels every claim with a truth label", () => {
    const labels = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") {
        const t = (node as Record<string, unknown>).truth;
        if (typeof t === "string") labels.add(t);
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(ARTIFACT);
    expect(labels.size).toBeGreaterThan(1);
    for (const l of labels) expect(TRUTH_LABELS as readonly string[]).toContain(l);
    // The overlay must never be presented as verified fact.
    expect(replay.resolvable.role_authority_absent.truth).toBe("capability_overlay");
    expect(replay.roleDiagnostics.truth).toBe("verified_fact");
  });

  it("claims no causal lift of any kind", () => {
    for (const k of ["roasLift", "revenueLift", "purchaseLift", "profitLift"]) {
      expect(ARTIFACT.limits.causalClaims[k]).toBeNull();
    }
    expect(String(ARTIFACT.limits.historicalTransitions)).toContain("observational only");
  });

  it("resolves every observed currency and names the exponent", () => {
    for (const row of replay.currencyDiagnostics.perAccount) {
      expect(row.status, String(row.provider_account_id)).toBe("resolved");
      expect(row.exponent).toBe(2);
    }
    expect(Object.keys(replay.currencyDiagnostics.observedCurrencies).sort()).toEqual(["TRY", "USD"]);
  });

  it("records why role authority stays unresolved", () => {
    const d = replay.roleDiagnostics;
    // Not one retained role row carries a provider account, and none carries a
    // resolver version either.
    expect(d.retainedRoleRowsWithAccount).toBe(0);
    expect(d.retainedRoleRows).toBeGreaterThan(0);
    expect(d.observedIdentities).toBeGreaterThan(0);
    // Under the exact canonical rule nothing resolves, so `resolved` is
    // legitimately absent. The census must still account for every row.
    expect(d.outcomeCensus.resolved ?? 0).toBe(0);
    // Both kind_source and resolver_version are missing; the source gate is
    // earlier in the ladder, so it is the code actually observed.
    expect(Object.keys(d.outcomeCensus)).toContain("role_source_not_system_inferred");
    const total = Object.values(d.outcomeCensus as Record<string, number>).reduce((s, n) => s + n, 0);
    expect(total).toBe(247_050);
  });

  it("keeps the deselected reference account fully out of action scope", () => {
    const deselected = replay.accountIsolation.filter((a: any) => a.is_selected === false);
    expect(deselected).toHaveLength(1);
    expect(deselected[0].proposals).toBeGreaterThan(0);
    // Every proposal on it is scope-blocked; none is merged into a sibling.
    expect(deselected[0].scope_blocked).toBe(deselected[0].proposals);
    for (const selected of replay.accountIsolation.filter((a: any) => a.is_selected)) {
      expect(selected.scope_blocked).toBe(0);
    }
  });

  it("proves no future leakage at the real selector boundary", () => {
    const checks = buildRoleLeakageChecks();
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const c of checks) {
      expect(c.authority_at_origin, String(c.check)).toBe(false);
      expect(c.negative_control_passes, String(c.check)).toBe(true);
    }
    expect(JSON.stringify(ARTIFACT.replay.leakage)).toBe(JSON.stringify(checks));
  });

  it("carries a worked typed intent that is validated but not authorised", () => {
    const worked = buildWorkedIntentExample();
    expect(worked.status).toBe("valid");
    const intent = worked.intent as Record<string, unknown>;
    expect(intent.executionState).toBe("validated_only");
    expect(intent.authorityStatus).toBe("not_determinable");
    expect(intent.proposedMinorUnits).toBe(270_000);
    expect(intent.currencyExponent).toBe(2);
  });
});

describe("D081-D — tamper attacks against the compact artifact", () => {
  const attack = (mutate: (a: Record<string, any>) => void) => {
    const a = clone();
    mutate(a);
    const resealed = sealArtifact(a);
    // Rebuild from the pinned source and compare, exactly as runVerify does.
    const rebuilt = buildArtifact(D080B);
    const differing = Object.keys(resealed).filter(
      (k) => k !== "artifactHash" && JSON.stringify(resealed[k]) !== JSON.stringify((rebuilt as Record<string, unknown>)[k]),
    );
    return { rejected: differing.length > 0, differing };
  };

  it.each([
    ["a forged headline resolvable count", (a: any) => { a.replay.resolvable.role_authority_absent.rows = 247_050; }, "replay"],
    ["a forged dimensional breakdown", (a: any) => { a.replay.perAccount[0].role_resolvable = 999; }, "replay"],
    ["a forged fold total", (a: any) => { a.replay.perFold[0].proposals = 1; }, "replay"],
    ["a forged reconciliation flag", (a: any) => { a.replay.reconciliation.reconciles = false; }, "replay"],
    ["a forged canonical-integration claim", (a: any) => { a.capabilities.typedBudgetIntent.canonicalIntegration.dispatchVerbAdded = true; }, "capabilities"],
    ["a forged role rule", (a: any) => { a.capabilities.accountScopedRoleAuthority.canonicalRule.requiredConfidence = "low"; }, "capabilities"],
    ["a forged missing-provenance list", (a: any) => { a.replay.resolvable.role_authority_absent.missingProvenance = []; }, "replay"],
    ["a forged losslessness claim", (a: any) => { a.capabilities.typedBudgetIntent.canonicalIntegration.payloadLossless = false; }, "capabilities"],
    ["a forged runtime-consumer claim", (a: any) => { a.capabilities.accountScopedRoleAuthority.runtimeConsumer = "nowhere"; }, "capabilities"],
    ["a forged name-authority claim", (a: any) => { a.nameAuthority.status = "open"; }, "nameAuthority"],
    ["a forged denominator", (a: any) => { a.replay.denominators.proposals = 1; }, "replay"],
    ["a forged residual census", (a: any) => { a.replay.residual.blockerCensus.role_authority_absent = 0; }, "replay"],
    ["an invented preview-eligible row", (a: any) => { a.replay.residual.proposalsWithNoResidualBlocker = 42; }, "replay"],
    ["a forged currency exponent", (a: any) => { a.replay.currencyDiagnostics.perAccount[0].exponent = 0; }, "replay"],
    ["a forged role diagnostic", (a: any) => { a.replay.roleDiagnostics.retainedRoleRowsWithAccount = 3_058; }, "replay"],
    ["a scope-isolation lie", (a: any) => { a.replay.accountIsolation.find((x: any) => !x.is_selected).scope_blocked = 0; }, "replay"],
    ["an erased leakage check", (a: any) => { a.replay.leakage = []; }, "replay"],
    ["a claimed executability", (a: any) => { a.limits.executable = true; }, "limits"],
    ["an asserted causal lift", (a: any) => { a.limits.causalClaims.roasLift = 1.4; }, "limits"],
    ["a forged pinned D080B hash", (a: any) => { a.pinnedInputs.d080bArtifactSha256 = "0".repeat(64); }, "pinnedInputs"],
    ["a forged capability claim", (a: any) => { a.capabilities.accountScopedRoleAuthority.manualLabelInput = true; }, "capabilities"],
    ["a forged worked example", (a: any) => { a.workedIntentExample.intent.proposedMinorUnits = 1; }, "workedIntentExample"],
  ])("rejects %s", (_label, mutate, section) => {
    const r = attack(mutate as (a: Record<string, any>) => void);
    expect(r.rejected).toBe(true);
    expect(r.differing).toContain(section);
  });

  it("does not accept a self-authored hash as the only check", () => {
    // Reseal makes the hash internally consistent; the rebuild still objects.
    const a = clone();
    a.replay.denominators.proposals = 1;
    const resealed = sealArtifact(a);
    expect(resealed.artifactHash).not.toBe(ARTIFACT.artifactHash);
    const consistent = sealArtifact(JSON.parse(JSON.stringify(resealed)));
    expect(consistent.artifactHash).toBe(resealed.artifactHash);
    // Internally consistent, and still wrong.
    const rebuilt = buildArtifact(D080B);
    expect(JSON.stringify(resealed.replay)).not.toBe(JSON.stringify((rebuilt as any).replay));
  });

  it("refuses to build from an unpinned D080B artifact", () => {
    const tampered = JSON.parse(JSON.stringify(D080B)) as Record<string, any>;
    tampered.snapshot.reads = tampered.snapshot.reads.slice(0, 5);
    const built = buildArtifact(tampered);
    expect((built as any).replay.denominators.proposals).not.toBe(247_050);
  });
});

describe("D081 — no write, no provider call, no migration, no automation", () => {
  const sources = [
    "lib/currency/iso-4217-minor-units.ts",
    "lib/meta/budget-intent-contract.ts",
    "lib/meta/campaign-role-authority.ts",
    "scripts/audits/d081-meta-budget-capability-foundations.ts",
  ];

  it("never contacts a provider", () => {
    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/graph\.facebook|fetch\(|axios|XMLHttpRequest/);
    }
  });

  it("never writes to a database and never runs a migration", () => {
    for (const file of sources) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // SQL verbs are matched in upper case and never after a dot, so crypto's
      // `.update(...)` is not mistaken for an UPDATE statement.
      expect(code, file).not.toMatch(/(?<!\.)\b(INSERT INTO|UPDATE \w|DELETE FROM|ALTER TABLE|DROP TABLE|CREATE TABLE)\b/);
      expect(code, file).not.toMatch(/runDbTransaction|getDb\(|runMigrations/);
    }
  });

  it("adds no migration of its own and leaves the migration file untouched", () => {
    // `lib/migrations.ts` carries unrelated pre-existing worktree changes that
    // this slice must preserve, so the check is that D081 added nothing to it,
    // not that the file is pristine.
    const migrations = readFileSync("lib/migrations.ts", "utf8");
    for (const marker of ["d081", "budget-intent", "budget_intent", "iso4217", "campaign-role-authority", "meta_budget_capability"]) {
      expect(migrations.toLowerCase(), marker).not.toContain(marker);
    }
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const untracked = execSync("git status --porcelain --untracked-files=all", { encoding: "utf8" })
      .split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3).trim());
    // No new SQL or migration file was introduced by this slice.
    expect(untracked.filter((f) => f.endsWith(".sql") || /migrations?\//.test(f))).toEqual([]);
  });

  it("sets no execution or automation flag", () => {
    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/process\.env\.[A-Z_]*\s*=/);
      expect(code, file).not.toMatch(/ENABLE_AUTOMATION|ENABLE_META_WRITES|ENABLE_PROVIDER_WRITES|ALLOW_LIVE_MUTATION/);
    }
    for (const flag of [
      "ENABLE_RUNTIME_MIGRATIONS", "ENABLE_META_WRITES", "ENABLE_AUTOMATION",
      "META_AUTOMATION_ENABLED", "ENABLE_PROVIDER_WRITES", "ALLOW_LIVE_MUTATION",
    ]) {
      const value = process.env[flag];
      expect(value === undefined || value === "" || value === "0" || value === "false", flag).toBe(true);
    }
  });

  it("introduces no row-level brief_variation", () => {
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toContain("brief_variation");
    }
  });

  it("keeps the contract identifier stable", () => {
    expect(ARTIFACT.contract).toBe(D081_CONTRACT_ID);
  });
});


describe("D081 C2 — the name-authority closure is recorded as verified fact", () => {
  it("reports the resolver-boundary change", () => {
    expect(ARTIFACT.nameAuthority.status).toBe("closed_at_the_resolver_boundary");
    expect(String(ARTIFACT.nameAuthority.change)).toContain("naming-free score");
    expect(ARTIFACT.nameAuthority.manualLabelsRestored).toBe(false);
    expect(ARTIFACT.nameAuthority.truth).toBe("verified_fact");
  });
});
