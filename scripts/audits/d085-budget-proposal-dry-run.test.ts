/**
 * D085 — the six-business replay, its verifier, and tamper resistance.
 *
 * The replay's headline number is a ZERO: no binding-direction cell produces a
 * would-write request. These tests exist so that zero cannot be a vacuous
 * refusal — it must arrive with a balanced funnel, a populated blocker census
 * and a reason on every blocker — and so a re-sealed forgery of any of it
 * fails the independent verifier.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalDigest } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  D085_REJECTED_R13,
  D085_REPO_ROOT,
  d085TrustedPath,
  d085TrustedReader,
  readFailureCode,
  D085_REJECTED_R12,
  D085_FROZEN_ARTIFACTS,
  D085_REJECTED_R11,
  assertWritableArtifactPath,
  d085ArtifactPathFor,
  d085RevisionOf,
  D085_REJECTED_R10,
  D085_ACCEPTED_PINS,
  D085_CONTRACT_ID,
  D085_DIRECTIONS,
  D085_JSON_OUT,
  D085_PROVIDER_READ_PROBE,
  D085_REJECTED_FIRST_PASS,
  D085_REJECTED_R2,
  D085_REJECTED_R3,
  D085_REJECTED_R4,
  D085_REJECTED_R5,
  D085_REJECTED_R6,
  D085_REJECTED_R7,
  D085_REJECTED_R8,
  D085_RECEIPT_LINEAGE,
  D085_REJECTED_PASSES,
  D085_REJECTED_R15,
  canonicalReceiptLineage,
  canonicalRejectedLineage,
  publisherSelfTest,
  DIRECTION_TO_ACTION,
  assembleSnapshot,
  emptyProviderLedger,
  recordedProviderLedger,
  replay,
  verifyArtifact,
} from "@/scripts/audits/d085-budget-proposal-dry-run";
import {
  D085_REVISION,
  DRY_RUN_BLOCKERS,
  META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  PREVIEW_CONTRACT_VERSION,
} from "@/lib/meta/budget-proposal-dry-run";

const load = () => JSON.parse(readFileSync(resolve(D085_JSON_OUT), "utf8")) as Record<string, any>;

/** Mutate, re-seal every envelope hash, then verify. */
const reseal = (mutate: (a: Record<string, any>) => void) => {
  const artifact = load();
  mutate(artifact);
  artifact.snapshotHash = canonicalDigest(artifact.snapshot);
  artifact.analysisHash = canonicalDigest(artifact.analysis);
  delete artifact.artifactHash;
  artifact.artifactHash = canonicalDigest(
    Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash")),
  );
  return verifyArtifact(artifact);
};

describe("D085 — the shipped artifact", () => {
  const artifact = load();
  const analysis = artifact.analysis;

  it("verifies as shipped", () => {
    const result = verifyArtifact(artifact);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is DB-free, write-free and review-only", () => {
    const p = artifact.snapshot.provenance;
    expect(artifact.contract).toBe(D085_CONTRACT_ID);
    expect(p.databaseAccess).toBe("none");
    expect(p.queriesExecuted).toBe(0);
    expect(p.providerWritesAttempted).toBe(0);
    expect(p.automation).toBe("off");
    expect(p.maximumReachableAuthority).toBe("validated_only");
  });

  it("pins every accepted predecessor and reproduces them from disk", () => {
    const pins = artifact.snapshot.predecessorPins;
    expect(pins.d083Observed).toBe(D085_ACCEPTED_PINS.d083);
    expect(pins.d084FileObserved).toBe(D085_ACCEPTED_PINS.d084File);
    expect(pins.d084ArtifactObserved).toBe(D085_ACCEPTED_PINS.d084Artifact);
    for (const entry of artifact.snapshot.sourceManifest) {
      const observed = createHash("sha256").update(readFileSync(resolve(entry.path))).digest("hex");
      expect(observed, entry.path).toBe(entry.expectedSha256);
      expect(entry.matches, entry.path).toBe(true);
    }
  });

  it("covers exactly the charter scope, including the deselected account", () => {
    const accounts = analysis.perAccount.map((a: any) => a.providerAccountId).sort();
    expect(accounts).toHaveLength(7);
    const deselected = analysis.perAccount.filter((a: any) => !a.accountSelected);
    expect(deselected).toHaveLength(1);
    expect(deselected[0].providerAccountId).toBe("act_921275999286619");
    // A deselected account is never write scope.
    const cells = analysis.cells.filter((c: any) => c.providerAccountId === "act_921275999286619");
    expect(cells).toHaveLength(2);
    for (const c of cells) expect(c.blockers).toContain("account_not_write_scope");
    // ...and no selected account carries that blocker.
    for (const c of analysis.cells.filter((x: any) => x.accountSelected)) {
      expect(c.blockers).not.toContain("account_not_write_scope");
    }
    const businesses = new Set(analysis.cells.map((c: any) => c.business));
    expect(businesses.size).toBe(6);
  });

  it("produces zero would-write cells — non-vacuously", () => {
    expect(analysis.cells.filter((c: any) => c.wouldWriteAvailable)).toHaveLength(0);
    // The zero must be explained everywhere.
    expect(analysis.blockerCensus.length).toBeGreaterThan(5);
    for (const cell of analysis.cells) {
      expect(cell.blockers.length, `${cell.business}/${cell.direction}`).toBeGreaterThan(0);
      for (const d of cell.blockerDetail) expect(d.why.length).toBeGreaterThan(0);
      expect(cell.blockers).toContain("no_provider_write_path_exists");
      // Blockers are published in the declared reading order.
      const positions = cell.blockers.map((b: any) => DRY_RUN_BLOCKERS.indexOf(b));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("balances its funnel and its denominators", () => {
    const r = analysis.reconciliation;
    expect(r.cellsBalanced).toBe(true);
    expect(r.blockedPlusWouldWriteEqualsCells).toBe(true);
    expect(r.uniqueObservationsBalanced).toBe(true);
    expect(r.evaluationsBalanced).toBe(true);
    // TWO denominators, never one name.
    expect(r.uniqueEntityOriginObservations).toBe(16_887);
    expect(r.entityOriginDirectionEvaluations).toBe(33_774);
    expect(r.uniqueEntityOriginObservations * D085_DIRECTIONS.length)
      .toBe(r.entityOriginDirectionEvaluations);
    expect(r.denominatorSemantics).toContain("ONCE");
    expect(r).not.toHaveProperty("candidatePairsTotal");
    expect(r.expectedCells).toBe(r.bindings * D085_DIRECTIONS.length);
    for (let i = 1; i < analysis.funnel.length; i += 1) {
      const prev = analysis.funnel[i - 1], cur = analysis.funnel[i];
      expect(cur.survivors + cur.eliminated, cur.stage).toBe(prev.survivors);
    }
    // Business, account and direction denominators must each re-sum to the cells.
    const total = analysis.cells.length;
    expect(analysis.perBusiness.reduce((s: number, b: any) => s + b.cells, 0)).toBe(total);
    expect(analysis.perAccount.reduce((s: number, b: any) => s + b.cells, 0)).toBe(total);
    expect(analysis.perDirection.reduce((s: number, b: any) => s + b.cells, 0)).toBe(total);
    for (const d of analysis.perDirection) {
      expect(d.canonicalAction).toBe(DIRECTION_TO_ACTION[d.direction as "increase" | "decrease"]);
    }
  });

  it("claims no provider contact, no read-back and no causal lift", () => {
    // The corrected denominator: local route probes are NOT provider contact.
    expect(analysis.providerPreflight.localRouteProbes.attempted).toBe(3);
    expect(analysis.providerPreflight.localRouteProbes.methods).toEqual(["GET"]);
    expect(analysis.providerPreflight.providerContacts.attempted).toBe(0);
    expect(analysis.providerPreflight.providerContacts.succeeded).toBe(0);
    expect(analysis.providerPreflight.readbackAttempts.attempted).toBe(0);
    expect(analysis.providerPreflight.semantics).toContain("never provider contact");
    expect(artifact.snapshot.provenance.localRouteProbesAttempted).toBe(3);
    expect(artifact.snapshot.provenance.providerContactsAttempted).toBe(0);
    expect(artifact.snapshot.provenance.readbackAttempts).toBe(0);
    expect(D085_PROVIDER_READ_PROBE.providerContactProven).toBe(false);
    expect(analysis.readback.classification).toBe("not_attempted");
    expect(analysis.readback.everyCellNotAttempted).toBe(true);
    for (const c of analysis.cells) expect(c.readbackClassification).toBe("not_attempted");
    expect(analysis.exposure.spendMoved).toBeNull();
    expect(analysis.exposure.revenueMoved).toBeNull();
    expect(analysis.exposure.roasLift).toBeNull();
    expect(analysis.exposure.profitLift).toBeNull();
    expect(analysis.exposure.optimalPercent).toBeNull();
    expect(analysis.exposure.unit).toBe("raw_provider_minor_units");
  });

  it("carries no token, route, connection string or secret", () => {
    const raw = JSON.stringify(artifact);
    for (const forbidden of [
      /graph\.facebook\.com/i, /access_token/i, /Bearer\s+[A-Za-z0-9._-]{12,}/i,
      /postgres(ql)?:\/\//i, /set-cookie/i, /EAA[A-Za-z0-9]{20,}/, /https?:\/\/localhost/,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("preserves D084's accepted fleet result rather than restating it", () => {
    const fleet = artifact.snapshot.fleet;
    expect(fleet.proposalsEvaluatedByD080B).toBe(247050);
    expect(fleet.strictlyEligibleProposals).toBe(0);
    expect(fleet.canonicalProfileActionsNotDeterminable).toBe(18);
    expect(fleet.canonicalProfileActionsEligible).toBe(0);
    expect(fleet.automation).toBe("off");
    expect(fleet.maximumReachableAuthority).toBe("validated_only");
  });

  it("carries D083's upstream funnel ending at zero intent-ready", () => {
    const upstream = artifact.snapshot.upstreamFunnel;
    expect(upstream[0].survivors).toBe(41242);
    const exponentStage = upstream.find((s: any) => s.gate === "currency_exponent_not_captured");
    expect(exponentStage.eliminated).toBe(32859);
    expect(exponentStage.survivors).toBe(0);
    expect(upstream[upstream.length - 1].survivors).toBe(0);
  });
});

describe("D085 — the replay is a pure function of the snapshot", () => {
  it("reproduces the published analysis exactly", () => {
    const artifact = load();
    const recomputed = replay(artifact.snapshot, recordedProviderLedger(artifact.snapshot.bindings));
    expect(canonicalDigest(recomputed.cells)).toBe(canonicalDigest(artifact.analysis.cells));
    expect(canonicalDigest(recomputed.funnel)).toBe(canonicalDigest(artifact.analysis.funnel));
    expect(canonicalDigest(recomputed.blockerCensus)).toBe(canonicalDigest(artifact.analysis.blockerCensus));
  });

  it("is deterministic across repeated assembly", () => {
    const a = assembleSnapshot(emptyProviderLedger());
    const b = assembleSnapshot(emptyProviderLedger());
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it("refuses to assemble if an accepted predecessor drifts", () => {
    // The pins are asserted inside the assembler, so a drifted D083/D084 is a
    // throw rather than a silently different artifact.
    expect(D085_ACCEPTED_PINS.d083).toMatch(/^[0-9a-f]{64}$/);
    expect(D085_ACCEPTED_PINS.d084File).toMatch(/^[0-9a-f]{64}$/);
    expect(D085_ACCEPTED_PINS.d084Artifact).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("D085 — a re-sealed forgery cannot pass verification", () => {
  it("positive control: an untouched artifact verifies", () => {
    expect(verifyArtifact(load()).ok).toBe(true);
  });

  it("negative control: re-sealing WITHOUT mutating still verifies", () => {
    expect(reseal(() => {}).failures).toEqual([]);
  });

  it.each([
    ["a fabricated would-write cell", (a: any) => { a.analysis.cells[0].wouldWriteAvailable = true; a.analysis.cells[0].status = "would_write_available"; }],
    ["an emptied blocker list", (a: any) => { a.analysis.cells[0].blockers = []; }],
    ["a dropped structural blocker", (a: any) => {
      a.analysis.cells[0].blockers = a.analysis.cells[0].blockers.filter((b: string) => b !== "no_provider_write_path_exists");
    }],
    ["a blocker with no reason", (a: any) => { a.analysis.cells[0].blockerDetail[0].why = ""; }],
    ["an unbalanced funnel", (a: any) => { a.analysis.funnel[1].survivors += 1; }],
    ["a forged blocker census", (a: any) => { a.analysis.blockerCensus[0].cells = 0; }],
    ["a forged cell set", (a: any) => { a.analysis.cells.pop(); }],
    ["an unbalanced evaluation denominator", (a: any) => { a.analysis.reconciliation.entityOriginDirectionEvaluations += 1; a.analysis.reconciliation.evaluationsBalanced = true; }],
    ["a double-counted unique denominator", (a: any) => { a.analysis.reconciliation.uniqueEntityOriginObservations = 33_774; }],
    ["the two denominators swapped", (a: any) => {
      const r = a.analysis.reconciliation;
      [r.uniqueEntityOriginObservations, r.entityOriginDirectionEvaluations] =
        [r.entityOriginDirectionEvaluations, r.uniqueEntityOriginObservations];
    }],
    ["evaluations relabelled as unique observations", (a: any) => {
      a.analysis.reconciliation.uniqueEntityOriginObservations = a.analysis.reconciliation.entityOriginDirectionEvaluations;
    }],
    ["a dropped denominator semantics statement", (a: any) => { a.analysis.reconciliation.denominatorSemantics = "counts"; }],
    ["a claimed provider read-back", (a: any) => { a.analysis.readback.classification = "confirmed"; }],
    ["a cell claiming a read-back", (a: any) => { a.analysis.cells[0].readbackClassification = "confirmed"; a.analysis.readback.everyCellNotAttempted = true; }],
    ["a succeeded provider contact with zero attempts", (a: any) => { a.analysis.providerPreflight.providerContacts.succeeded = 3; }],
    ["route probes relabelled as provider contacts", (a: any) => {
      a.analysis.providerPreflight.providerContacts.attempted = 3;
      a.snapshot.provenance.providerContactsAttempted = 3;
    }],
    ["provider contacts relabelled as route probes", (a: any) => {
      a.analysis.providerPreflight.localRouteProbes.attempted = 0;
      a.snapshot.provenance.localRouteProbesAttempted = 0;
    }],
    ["a provenance/analysis denominator disagreement", (a: any) => { a.snapshot.provenance.localRouteProbesAttempted = 99; }],
    ["route probe outcomes that do not sum", (a: any) => { a.analysis.providerPreflight.localRouteProbes.succeeded = 1; }],
    ["a non-GET route probe method", (a: any) => { a.analysis.providerPreflight.localRouteProbes.methods = ["POST"]; }],
    ["a read-back attempt without any write", (a: any) => { a.analysis.providerPreflight.readbackAttempts.attempted = 1; }],
    ["a read-back classification other than not_attempted", (a: any) => { a.analysis.providerPreflight.readbackAttempts.classification = "confirmed"; }],
    ["a dropped ledger semantics statement", (a: any) => { a.analysis.providerPreflight.semantics = "reads happened"; }],
    ["a moved-spend figure", (a: any) => { a.analysis.exposure.spendMoved = 1234; }],
    ["a causal lift claim", (a: any) => { a.analysis.exposure.roasLift = 1.4; }],
    ["an optimal percent", (a: any) => { a.analysis.exposure.optimalPercent = 10; }],
    ["a relaxed authority ceiling", (a: any) => { a.snapshot.provenance.maximumReachableAuthority = "executable"; }],
    ["automation switched on", (a: any) => { a.snapshot.provenance.automation = "on"; }],
    ["a claimed provider write", (a: any) => { a.snapshot.provenance.providerWritesAttempted = 1; }],
    ["a claimed database query", (a: any) => { a.snapshot.provenance.queriesExecuted = 1; }],
    ["a forged predecessor pin", (a: any) => { a.snapshot.predecessorPins.d084FileObserved = "0".repeat(64); a.snapshot.sourceManifest[0].expectedSha256 = "0".repeat(64); }],
    ["a leaked provider host", (a: any) => { a.analysis.limits.push("read from https://graph.facebook.com/v21.0/act_1/adsets"); }],
    ["a leaked access token", (a: any) => { a.analysis.limits.push("access_token=EAAabcdefghijklmnopqrstuvwxyz012345"); }],
    ["a stale policy fingerprint", (a: any) => { a.analysis.policyFingerprint = "meta.budget-proposal-dry-run.v1:" + "0".repeat(64); }],
  ])("rejects %s", (_label, mutate) => {
    const result = reseal(mutate);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

describe("D085 C1 — the replay preserves unknown safety as unknown", () => {
  const artifact = load();
  it("publishes the five unverified safety blockers on every cell", () => {
    for (const cell of artifact.analysis.cells) {
      for (const code of [
        "kill_switch_unverified", "admission_unverified",
        "cap_unverified", "cooldown_unverified", "conflict_unverified",
      ]) {
        expect(cell.blockers, `${cell.business}/${cell.direction}`).toContain(code);
      }
      // ...and never claims a breach the pinned bytes do not prove.
      for (const code of ["kill_switch_engaged", "admission_blocked", "cap_exceeded", "cooldown_active", "conflict_lock_held"]) {
        expect(cell.blockers).not.toContain(code);
      }
    }
  });

  it("says WHY each control is unverified rather than asserting it is clear", () => {
    const detail = artifact.analysis.cells[0].blockerDetail as Array<{ code: string; why: string }>;
    const cap = detail.find((d) => d.code === "cap_unverified");
    expect(cap?.why).toMatch(/not read|unverified/i);
    // It must say the control CANNOT clear the proposal — never that it is clear.
    expect(cap?.why).toMatch(/cannot clear/i);
    expect(cap?.why).not.toMatch(/\bis clear\b|proved clear|under cap/i);
  });

  it("records EVERY rejected pass as history, never as accepted truth", () => {
    expect(D085_REJECTED_R2.status).toBe("rejected");
    expect(D085_REJECTED_R2.fileSha256).toBe("0495c156fcc2cf84eacf6c1a93b0efd7ac5fda2bcaed1159c5696181732af86d");
    expect(D085_REJECTED_R2.contract).toBe("d085.budget-proposal-dry-run.v2");
    expect(D085_REJECTED_R2.why).toMatch(/fail-open|candidatePairsTotal/);
    expect(D085_REJECTED_FIRST_PASS.status).toBe("rejected");
    expect(D085_REJECTED_FIRST_PASS.fileSha256)
      .toBe("4f728bef6c91ac5345d4f3b7c44c262c647f734d2c12547cef7dc4343bf4d18c");
    expect(D085_REJECTED_FIRST_PASS.contract).toBe("d085.budget-proposal-dry-run.v1");
    expect(D085_REJECTED_R3.status).toBe("rejected");
    expect(D085_REJECTED_R3.fileSha256).toBe("2848f8423b1875ddc2ab9d6910ce64172e2a29fc1478b53cb4246b50c45a4220");
    expect(D085_REJECTED_R3.contract).toBe("d085.budget-proposal-dry-run.v3");
    expect(D085_REJECTED_R3.why).toMatch(/rollover|BANANA|idempotencyKey/);
    expect(D085_REJECTED_R4.status).toBe("rejected");
    expect(D085_REJECTED_R4.fileSha256).toBe("992f0a599a6ddf41131511023b20112973fd502a9c2db8acffa13d1035b65dc9");
    expect(D085_REJECTED_R4.contract).toBe("d085.budget-proposal-dry-run.v4");
    expect(D085_REJECTED_R4.why).toMatch(/999,999|ageSeconds|banana/);
    expect(D085_REJECTED_R5.status).toBe("rejected");
    expect(D085_REJECTED_R5.fileSha256).toBe("a55a091ac3cb157b5389bbc65e418129cb54fffe800d41ded0e3902da2c6799f");
    expect(D085_REJECTED_R5.contract).toBe("d085.budget-proposal-dry-run.v5");
    expect(D085_REJECTED_R5.why).toMatch(/banana|manual_label|requestedField/);
    expect(D085_REJECTED_R6.status).toBe("rejected");
    expect(D085_REJECTED_R6.fileSha256).toBe("6771eb63574ba8d410809c62fc54394d93606622c2153adbf5e30d4abd311d32");
    expect(D085_REJECTED_R6.artifactHash).toBe("1bb5e7347ea1807afcb6dd505140e0b1316026ab0cd9460a8b328e72fb47d54b");
    expect(D085_REJECTED_R6.contract).toBe("d085.budget-proposal-dry-run.v6");
    // The exact 17-failure reason, named by its decisive facts.
    expect(D085_REJECTED_R6.why).toMatch(/17 probes/);
    expect(D085_REJECTED_R6.why).toMatch(/Cannot read properties of null/);
    expect(D085_REJECTED_R6.why).toMatch(/isCampaignContextResolverAuthorityValidated/);
    expect(D085_REJECTED_R6.why).toMatch(/self-verified as true/);
    expect(D085_REJECTED_R7.status).toBe("rejected");
    expect(D085_REJECTED_R7.fileSha256).toBe("b9e65b3d885fe2eb852c6ad2ed181a420cf66c2a6a33b29cab543ab7dd592c02");
    expect(D085_REJECTED_R7.artifactHash).toBe("c6de0030cfde880419bb71031ee1f3befb649de609bbdc61fa98c4b099b70c3f");
    expect(D085_REJECTED_R7.snapshotHash).toBe("8927546a5c59764ddfa5a6c360316be73c9e0b44beabe092b2164ef310b8fbf8");
    expect(D085_REJECTED_R7.analysisHash).toBe("de6182bf379f26699b0f76e0d8ca93db87e2bde160c826a867b673e5bed027c0");
    expect(D085_REJECTED_R7.contract).toBe("d085.budget-proposal-dry-run.v7");
    // The exact 11-failure reason, named by its decisive facts.
    expect(D085_REJECTED_R7.why).toMatch(/11 of 12 adversarial probes escaped/);
    expect(D085_REJECTED_R7.why).toMatch(/23850000000000000/);
    expect(D085_REJECTED_R7.why).toMatch(/is not iterable/);
    expect(D085_REJECTED_R7.why).toMatch(/Cannot read properties of null/);
    expect(D085_REJECTED_R7.why).toMatch(/byte-for-byte preservation rule/);
    expect(D085_REJECTED_R8.status).toBe("rejected");
    expect(D085_REJECTED_R8.fileSha256).toBe("6652bc4b599f3281ae1f4fde63a8584f23835ad2fce09208908ae2c59d98e260");
    expect(D085_REJECTED_R8.artifactHash).toBe("2200df84ded3884dc86170461921349895231a317e0a89b598aa81c2238c6649");
    expect(D085_REJECTED_R8.snapshotHash).toBe("984c17c2619cf3684400e514eab96967d46718c68efe2ec540f70f6265e750e7");
    expect(D085_REJECTED_R8.analysisHash).toBe("f8078bf7f685f824287e41a791ba0ea26350ec632b8ca1d8bf08fb1326f51c3f");
    expect(D085_REJECTED_R8.contract).toBe("d085.budget-proposal-dry-run.v8");
    // The exact 66-failure reason, named by its decisive facts.
    expect(D085_REJECTED_R8.why).toMatch(/66 independently reproduced escapes/);
    expect(D085_REJECTED_R8.why).toMatch(/41 self-consistent, re-hashed request\/receipt forgeries/);
    expect(D085_REJECTED_R8.why).toMatch(/8 exported boundaries threw/);
    expect(D085_REJECTED_R8.why).toMatch(/15 exact-map and malformed-element mutations/);
    expect(D085_REJECTED_R8.why).toMatch(/Cannot read properties of null/);
    expect(D085_REJECTED_R8.why).toMatch(/proves deterministic serialization, not authenticity/);
    expect(D085_REJECTED_R10.status).toBe("rejected");
    expect(D085_REJECTED_R10.fileSha256).toBe("3c73cc02866f1b39b3deacfc46bb2b669bb34f4d6ab93109b71c886825342185");
    expect(D085_REJECTED_R10.artifactHash).toBe("b0da05c71b1420aee911d4d700e7b04bb4ce63da172d5b62f9561dbdbe4b2525");
    expect(D085_REJECTED_R10.snapshotHash).toBe("a605b772834f33c49e62a50dc697961c0dd11e3479001ebf21ed455f1ca649bb");
    expect(D085_REJECTED_R10.analysisHash).toBe("8d1c47b9991b771b9d881025fccd5b7d5333ac87ab7074c02175add9d91efbe0");
    expect(D085_REJECTED_R10.contract).toBe("d085.budget-proposal-dry-run.v10");
    expect(D085_REJECTED_R10.why).toMatch(/35 independently reproduced local contract failures/);
    expect(D085_REJECTED_R10.why).toMatch(/__proto__/);
    expect(D085_REJECTED_R10.why).toMatch(/4294967295/);
    expect(D085_REJECTED_R10.why).toMatch(/secondary message trap/);
    expect(D085_REJECTED_R10.why).toMatch(/package\.json/);
    // Derived, not re-pinned: this literal was one correction stale every time.
    expect(D085_CONTRACT_ID).toBe(`d085.budget-proposal-dry-run.v${D085_REVISION}`);
    expect(D085_REJECTED_PASSES).toHaveLength(D085_REVISION - 1);
  });
});

// ---------------------------------------------------------------------------
// Correction 9 — the artifact verifier actually verifies the artifact
// ---------------------------------------------------------------------------

describe("D085 C9 — every material section is protected", () => {
  const load = () => JSON.parse(readFileSync(resolve(D085_JSON_OUT), "utf8")) as Record<string, any>;

  it("POSITIVE CONTROL: the untouched artifact verifies", () => {
    const r = verifyArtifact(load());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  /*
    THE FIVE r9 ESCAPES, verbatim.

    Each of these returned `ok:true` with `failures: []` under r9, because the
    verifier never recomputed a single hash and never checked a nested
    contract identifier. A verifier that reads a published hash and compares
    it to itself verifies nothing.
  */
  it.each([
    ["d1 replace the top-level artifactHash", (a: any) => { a.artifactHash = "0".repeat(64); }, "artifactHash"],
    ["d2 downgrade snapshot.contract to v1", (a: any) => { a.snapshot.contract = "d085.budget-proposal-dry-run.v1"; }, "snapshot.contract"],
    ["d3 downgrade analysis.contractVersion to v1", (a: any) => { a.analysis.contractVersion = "d085.budget-proposal-dry-run.v1"; }, "analysis.contractVersion"],
    // Correction 11 reconstructs the whole snapshot and analysis, so these now
    // fail at the reconstruction gate — an earlier and broader catch than the
    // per-section checks they used to trip.
    ["d4 empty analysis.writeSafetyCensus", (a: any) => { a.analysis.writeSafetyCensus = []; }, "reconstruction"],
    ["d5 remove the first sourceManifest entry", (a: any) => { a.snapshot.sourceManifest.shift(); }, "reconstruction"],
  ])("rejects %s", (_l, mutate, expected) => {
    const a = load();
    mutate(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" | ")).toContain(expected);
  });

  it.each([
    ["the published snapshotHash", (a: any) => { a.snapshotHash = "0".repeat(64); }],
    ["the published analysisHash", (a: any) => { a.analysisHash = "0".repeat(64); }],
    ["a cell", (a: any) => { a.analysis.cells[0].status = "would_write_available"; }],
    ["a blocker census count", (a: any) => { a.analysis.blockerCensus[0].cells = 1; }],
    ["a funnel stage", (a: any) => { a.analysis.funnel[0].survivors += 1; }],
    ["a binding", (a: any) => { a.snapshot.bindings[0].providerAccountId = "act_000"; }],
    ["a source-manifest hash", (a: any) => { a.snapshot.sourceManifest[0].expectedSha256 = "0".repeat(64); }],
    ["the provenance posture", (a: any) => { a.snapshot.provenance.automation = "on"; }],
    ["the rejected lineage", (a: any) => { a.rejectedLineage.pop(); }],
    ["the verification guarantee", (a: any) => { delete a.verificationGuarantee; }],
    ["the provider-contact evidence class", (a: any) => { a.providerContactEvidence.evidenceClass = "independent_transport_sentinel"; }],
  ])("rejects a mutation of %s", (_l, mutate) => {
    const a = load();
    mutate(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("rejects a COHERENT re-hash that still violates an invariant", () => {
    /*
      The honest boundary. Re-hashing everything defeats corruption detection,
      so the surviving defence is the invariant set: this artifact claims a
      would-write cell while no provider write path exists, and no amount of
      re-hashing makes that true.
    */
    const a = load();
    a.analysis.cells[0].wouldWriteAvailable = true;
    a.analysis.cells[0].blockers = [];
    a.analysis.cells[0].blockerDetail = [];
    a.snapshotHash = canonicalDigest(a.snapshot);
    a.analysisHash = canonicalDigest(a.analysis);
    const { artifactHash: _drop, ...bare } = a;
    a.artifactHash = canonicalDigest(bare);
    const r = verifyArtifact(a);
    expect(r.ok, "a coherent re-hash must still fail on the invariant").toBe(false);
  });

  it("rejects a coherent re-hash that drops a REQUIRED source-manifest entry", () => {
    const a = load();
    a.snapshot.sourceManifest.shift();
    a.snapshotHash = canonicalDigest(a.snapshot);
    a.analysisHash = canonicalDigest(a.analysis);
    const { artifactHash: _drop, ...bare } = a;
    a.artifactHash = canonicalDigest(bare);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
  });

  it("rejects a coherent re-hash under a DOWNGRADED contract", () => {
    const a = load();
    a.contract = "d085.budget-proposal-dry-run.v1";
    a.snapshot.contract = "d085.budget-proposal-dry-run.v1";
    a.analysis.contractVersion = "d085.budget-proposal-dry-run.v1";
    a.snapshotHash = canonicalDigest(a.snapshot);
    a.analysisHash = canonicalDigest(a.analysis);
    const { artifactHash: _drop, ...bare } = a;
    a.artifactHash = canonicalDigest(bare);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
  });

  it("does NOT claim to detect a fully coherent re-authoring", () => {
    // Stated, not implied. A local SHA cannot separate a genuine artifact from
    // one an actor re-authored consistently and re-hashed; only the invariants
    // above survive that, and they are not authenticity.
    const a = load();
    const g = a.verificationGuarantee;
    expect(JSON.stringify(g.doesNotEstablish).toLowerCase()).toContain("authenticity");
    expect(g.wouldRequire).toContain("server-held secret");
  });
});

describe("D085 C9 — the artifact says what it actually is", () => {
  const load = () => JSON.parse(readFileSync(resolve(D085_JSON_OUT), "utf8")) as Record<string, any>;

  it("publishes the COMPLETE rejected lineage, growing by exactly one each correction", () => {
    /*
      r9 published a list that stopped at v5 while the contract was v9, and
      Correction 14 found the same drift again. The expectation is now DERIVED
      from the contract version rather than re-typed each correction, so this
      test cannot itself fall behind — the drift it guards against.
    */
    const a = load();
    const rev = d085RevisionOf(D085_CONTRACT_ID);
    expect(a.rejectedLineage.map((r: any) => r.contract)).toEqual(
      Array.from({ length: rev - 1 }, (_, i) => `d085.budget-proposal-dry-run.v${i + 1}`),
    );
    expect(a.rejectedLineage.every((r: any) => r.status === "rejected")).toBe(true);
  });

  it("publishes the COMPLETE receipt migration lineage", () => {
    const a = load();
    const receiptRev = Number(/\.v(\d+)$/.exec(PREVIEW_CONTRACT_VERSION)![1]);
    expect(a.receiptLineage.current).toBe(PREVIEW_CONTRACT_VERSION);
    expect(a.receiptLineage.rejected).toEqual(
      Array.from({ length: receiptRev - 1 }, (_, i) => `meta.budget-preview-receipt.v${i + 1}`),
    );
    expect(a.receiptLineage.migration).toContain("UNVERIFIABLE");
  });

  it("publishes the machine-readable guarantee IN THE ARTIFACT", () => {
    // The r9 report said this was published here. It was not present at all.
    const a = load();
    expect(a.verificationGuarantee).toBeTruthy();
    expect(a.verificationGuarantee.establishes.length).toBeGreaterThan(0);
    expect(a.verificationGuarantee.doesNotEstablish.length).toBeGreaterThan(0);
  });

  it("classifies the provider-contact assertion as RECORDED, not proven", () => {
    /*
      r9 derived the zero-contact claim from a hard-coded probe constant, then
      re-derived it in the generator and the verifier from that same constant,
      and called it independent proof. No independent sentinel exists, so the
      honest class is `recorded_by_local_process`.
    */
    const a = load();
    expect(a.providerContactEvidence.evidenceClass).toBe("recorded_by_local_process");
    expect(a.providerContactEvidence.limitation.toLowerCase()).toContain("not independent");
    expect(a.providerContactEvidence.limitation).toContain("sentinel");
  });

  it("says unknown safety is recorded UNKNOWN, matching the implementation", () => {
    // The r9 limit text claimed those flags were recorded `false` "so that no
    // blocker is inflated", while the code records `unknown` and every replay
    // cell carries an unverified blocker.
    const a = load();
    const limits = JSON.stringify(a.analysis.limits ?? a.limits ?? []);
    expect(limits).toContain("recorded UNKNOWN, not false");
    expect(limits).toContain("_unverified");
    const census = a.analysis.blockerCensus.map((b: any) => b.code);
    for (const code of ["kill_switch_unverified", "admission_unverified", "cap_unverified", "cooldown_unverified", "conflict_unverified"]) {
      expect(census, `${code} must actually be in the census the prose describes`).toContain(code);
    }
  });

  it("publishes the point-in-time policy it enforces", () => {
    const a = load();
    expect(a.pointInTimePolicy.version).toBe("meta.point-in-time-policy.v1");
    expect(a.pointInTimePolicy.invalidTimestamps).toContain("BLOCKS");
  });

  it("preserves the real replay population unchanged", () => {
    const a = load();
    expect(a.analysis.cells.length).toBe(14);
    expect(a.snapshot.bindings.length).toBe(7);
    expect(a.analysis.cells.filter((c: any) => c.wouldWriteAvailable).length).toBe(0);
    expect(a.analysis.cells.filter((c: any) => c.accountSelected === false).length).toBe(2);
    expect(a.snapshot.provenance.queriesExecuted).toBe(0);
    expect(a.snapshot.provenance.providerWritesAttempted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Correction 10 — the artifact verifier is total and canonical
// ---------------------------------------------------------------------------

describe("D085 C10 — coherently re-sealed material changes all fail", () => {
  const load = () => JSON.parse(readFileSync(resolve(D085_JSON_OUT), "utf8")) as Record<string, any>;
  /** Re-seal exactly as a forger would: every hash recomputed. */
  const reseal = (a: Record<string, any>) => {
    a.snapshotHash = canonicalDigest(a.snapshot);
    a.analysisHash = canonicalDigest(a.analysis);
    const { artifactHash: _drop, ...bare } = a;
    a.artifactHash = canonicalDigest(bare);
    return a;
  };

  it("POSITIVE CONTROL: the untouched artifact verifies", () => {
    const r = verifyArtifact(load());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["D1 an extra top-level section", (a: any) => { a.unrecognisedSection = { x: 1 }; }, "topLevelSchema"],
    ["D2 an emptied writeSafetyCensus", (a: any) => { a.analysis.writeSafetyCensus = []; }, "writeSafetyCensus"],
    ["D3 a rewritten pointInTimePolicy.ordering", (a: any) => { a.pointInTimePolicy.ordering = "whatever"; }, "pointInTimePolicy"],
    ["D4 a removed receiptLineage", (a: any) => { delete a.receiptLineage; }, "receiptLineage"],
    ["D5 a verificationGuarantee of arbitrary prose", (a: any) => { a.verificationGuarantee = { establishes: ["x"], doesNotEstablish: ["authenticity y"], wouldRequire: "z" }; }, "verificationGuarantee"],
    ["D6 rewritten providerContactEvidence prose", (a: any) => { a.providerContactEvidence.assertion = "x"; a.providerContactEvidence.basis = "y"; a.providerContactEvidence.limitation = "z"; }, "providerContactEvidence"],
    ["D7 rewritten rejectedLineage hashes and statuses", (a: any) => { a.rejectedLineage = a.rejectedLineage.map((r: any) => ({ ...r, fileSha256: "0".repeat(64), status: "accepted" })); }, "rejectedLineage"],
    ["D8 replaced analysis.limits", (a: any) => { a.analysis.limits = ["arbitrary text"]; }, "limits"],
  ])("rejects %s even when every hash is recomputed", (_l, mutate, expectedSection) => {
    /*
      Each of these returned ok:true with failures [] under r10, because the
      only defence was the envelope hash — and a forger recomputes that. The
      failure must now come from the NAMED invariant, not a stale hash.
    */
    const a = load();
    mutate(a);
    reseal(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" | "), `${_l} must fail on ${expectedSection}`).toContain(expectedSection);
    // ...and NOT merely because a hash went stale.
    expect(r.failures.join(" | ")).not.toMatch(/^hashChain: [^|]*$/);
  });

  it("D9 rejects a manifest row whose path was substituted, hashes and all", () => {
    /*
      The sharpest of the twelve: keep the key `d079`, point its path at
      `package.json`, and set both hashes to that file's real hash. r10 read
      the artifact-supplied path and hashed whatever it named, so the
      substitution verified clean. A verifier must never let the document
      under inspection choose which file it is checked against.
    */
    const a = load();
    const entry = a.snapshot.sourceManifest.find((e: any) => e.key === "d079") ?? a.snapshot.sourceManifest[0];
    const packageHash = createHash("sha256").update(readFileSync(resolve("package.json"))).digest("hex");
    entry.path = "package.json";
    entry.expectedSha256 = packageHash;
    entry.observedSha256 = packageHash;
    reseal(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
    // The reconstruction gate catches the substituted path before the manifest
    // tuple comparison is even reached.
    expect(r.failures.join(" | ")).toMatch(/reconstruction|not the trusted/);
  });

  it.each([
    ["a substituted expected hash", (a: any) => { a.snapshot.sourceManifest[0].expectedSha256 = "0".repeat(64); }],
    ["a substituted observed hash", (a: any) => { a.snapshot.sourceManifest[0].observedSha256 = "0".repeat(64); }],
    ["matches flipped to false", (a: any) => { a.snapshot.sourceManifest[0].matches = false; }],
    ["an extra key on a manifest row", (a: any) => { a.snapshot.sourceManifest[0].extra = 1; }],
    ["an unknown manifest key", (a: any) => { a.snapshot.sourceManifest[0].key = "not-a-source"; }],
  ])("rejects %s", (_l, mutate) => {
    const a = load();
    mutate(a);
    reseal(a);
    expect(verifyArtifact(a).ok).toBe(false);
  });

  it.each([
    ["D10 null", () => null],
    ["D12 a null sourceManifest", () => { const a = load(); a.snapshot.sourceManifest = null; return a; }],
    ["undefined", () => undefined],
    ["a primitive", () => 7],
    ["an array", () => []],
    ["a null snapshot", () => { const a = load(); a.snapshot = null; return a; }],
    ["a null analysis", () => { const a = load(); a.analysis = null; return a; }],
    ["a BigInt inside the analysis", () => { const a = load(); a.analysis.cells[0].currentMinorUnits = BigInt(1); return a; }],
  ])("returns a failure rather than throwing for %s", (_l, build) => {
    let r!: ReturnType<typeof verifyArtifact>;
    expect(() => { r = verifyArtifact(build() as never); }, `${_l} threw`).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("D11 returns a failure for a root Proxy that throws on get", () => {
    const hostile = new Proxy({}, { get() { throw new Error("get trap"); } });
    let r!: ReturnType<typeof verifyArtifact>;
    expect(() => { r = verifyArtifact(hostile as never); }).not.toThrow();
    expect(r.ok).toBe(false);
  });

  it("publishes a CONTIGUOUS lineage that agrees with both live contract versions", () => {
    const a = load();
    const rev = d085RevisionOf(D085_CONTRACT_ID);
    const receiptRev = Number(/\.v(\d+)$/.exec(PREVIEW_CONTRACT_VERSION)![1]);
    expect(a.contract).toBe(D085_CONTRACT_ID);
    expect(a.rejectedLineage.map((r: any) => r.contract)).toEqual(
      Array.from({ length: rev - 1 }, (_, i) => `d085.budget-proposal-dry-run.v${i + 1}`),
    );
    expect(a.receiptLineage.current).toBe(PREVIEW_CONTRACT_VERSION);
    expect(a.receiptLineage.rejected).toEqual(
      Array.from({ length: receiptRev - 1 }, (_, i) => `meta.budget-preview-receipt.v${i + 1}`),
    );
  });

  it("still says plainly what a local SHA cannot establish", () => {
    const a = load();
    expect(JSON.stringify(a.verificationGuarantee.doesNotEstablish).toLowerCase()).toContain("authenticity");
    expect(a.verificationGuarantee.wouldRequire).toContain("server-held secret");
    expect(a.providerContactEvidence.evidenceClass).toBe("recorded_by_local_process");
  });

  it("preserves the real replay census unchanged", () => {
    const a = load();
    expect(a.analysis.cells.length).toBe(14);
    expect(a.snapshot.bindings.length).toBe(7);
    expect(a.analysis.cells.filter((c: any) => c.wouldWriteAvailable).length).toBe(0);
    expect(a.analysis.cells.filter((c: any) => c.accountSelected === false).length).toBe(2);
    expect(a.snapshot.provenance.queriesExecuted).toBe(0);
    expect(a.snapshot.provenance.providerWritesAttempted).toBe(0);
    expect(a.snapshot.provenance.localRouteProbesAttempted).toBe(3);
    expect(a.snapshot.provenance.providerContactsAttempted).toBe(0);
    expect(a.snapshot.provenance.readbackAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Correction 11 — Group A totality/exactness, and the output-path guard
// ---------------------------------------------------------------------------

describe("D085 C11 — the verifier is total across every malformed nested structure", () => {
  const load = () => JSON.parse(readFileSync(resolve(D085_JSON_OUT), "utf8")) as Record<string, any>;
  const reseal = (a: Record<string, any>) => {
    a.snapshotHash = canonicalDigest(a.snapshot);
    a.analysisHash = canonicalDigest(a.analysis);
    const { artifactHash: _drop, ...bare } = a;
    a.artifactHash = canonicalDigest(bare);
    return a;
  };

  it("POSITIVE CONTROL: the untouched r12 artifact verifies", () => {
    const r = verifyArtifact(load());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  /*
    ROWS 1-19. Each of these threw `TypeError` under r11, because the exact
    schema was enforced at the TOP LEVEL and every nested path below it was
    dereferenced on trust. They are closed structurally — the verifier now
    reconstructs the expected snapshot and analysis and compares them in full,
    so a malformed nested container simply differs from the reconstruction.
  */
  it.each([
    ["#1 snapshot.provenance", (a: any) => { a.snapshot.provenance = null; }],
    ["#2 snapshot.bindings", (a: any) => { a.snapshot.bindings = null; }],
    ["#3 snapshot.bindings[0]", (a: any) => { a.snapshot.bindings[0] = null; }],
    ["#4 analysis.providerPreflight", (a: any) => { a.analysis.providerPreflight = null; }],
    ["#5 …localRouteProbes", (a: any) => { a.analysis.providerPreflight.localRouteProbes = null; }],
    ["#6 …localRouteProbes.statuses", (a: any) => { a.analysis.providerPreflight.localRouteProbes.statuses = null; }],
    ["#7 …localRouteProbes.methods", (a: any) => { a.analysis.providerPreflight.localRouteProbes.methods = null; }],
    ["#8 …providerContacts", (a: any) => { a.analysis.providerPreflight.providerContacts = null; }],
    ["#9 …readbackAttempts", (a: any) => { a.analysis.providerPreflight.readbackAttempts = null; }],
    ["#10 analysis.reconciliation", (a: any) => { a.analysis.reconciliation = null; }],
    ["#11 analysis.cells", (a: any) => { a.analysis.cells = null; }],
    ["#12 analysis.cells[0]", (a: any) => { a.analysis.cells[0] = null; }],
    ["#13 analysis.perBusiness", (a: any) => { a.analysis.perBusiness = null; }],
    ["#14 analysis.perAccount", (a: any) => { a.analysis.perAccount = null; }],
    ["#15 analysis.perDirection", (a: any) => { a.analysis.perDirection = null; }],
    ["#16 analysis.funnel", (a: any) => { a.analysis.funnel = null; }],
    ["#17 analysis.blockerCensus", (a: any) => { a.analysis.blockerCensus = null; }],
    ["#18 analysis.readback", (a: any) => { a.analysis.readback = null; }],
    ["#19 analysis.exposure", (a: any) => { a.analysis.exposure = null; }],
  ])("returns a deterministic failure for a null %s, never a throw", (_l, mutate) => {
    const a = load();
    mutate(a);
    reseal(a);
    let r!: ReturnType<typeof verifyArtifact>;
    expect(() => { r = verifyArtifact(a); }, `${_l} threw`).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  /*
    ROWS 20-25. Each returned ok:true with zero failures under r11 — the exact
    schema simply did not reach these containers.
  */
  it.each([
    ["#20 snapshot top level", (a: any) => { a.snapshot.extraKey = 1; }],
    ["#21 analysis top level", (a: any) => { a.analysis.extraKey = 1; }],
    ["#22 snapshot.provenance", (a: any) => { a.snapshot.provenance.extraKey = 1; }],
    ["#23 analysis.reconciliation", (a: any) => { a.analysis.reconciliation.extraKey = 1; }],
    ["#24 analysis.providerPreflight", (a: any) => { a.analysis.providerPreflight.extraKey = 1; }],
    ["#25 snapshot.bindings[0]", (a: any) => { a.snapshot.bindings[0].extraKey = 1; }],
  ])("rejects an extra key on %s, coherently resealed", (_l, mutate) => {
    const a = load();
    mutate(a);
    reseal(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" | ")).toContain("reconstruction");
  });

  it("#26 reads the caller EXACTLY ONCE and never touches it again", () => {
    /*
      r11 ended its redaction step with `JSON.stringify(artifact)` on the
      CALLER's value, so a Proxy that satisfied the descriptor-based
      observation and threw on a later `get` escaped. The counter below is the
      proof: after the single snapshot, zero further property reads occur.
    */
    const doc = load();
    let gets = 0;
    const watched = new Proxy(doc, { get(t, k, r) { gets += 1; return Reflect.get(t, k, r); } });
    let result!: ReturnType<typeof verifyArtifact>;
    expect(() => { result = verifyArtifact(watched as never); }).not.toThrow();
    expect(gets, "the verifier must not read the caller's value after snapshotting").toBe(0);
    expect(result.ok).toBe(true);
  });

  it("#26b a Proxy that throws on a later get still returns a verdict", () => {
    const doc = load();
    let gets = 0;
    const hostile = new Proxy(doc, { get(t, k, r) { gets += 1; if (gets > 1) throw new Error("late get trap"); return Reflect.get(t, k, r); } });
    expect(() => verifyArtifact(hostile as never)).not.toThrow();
  });

  it.skip("SUPERSEDED by C12 #10: this asserted an ENOENT failure from cwd=/, which enshrined the cwd-dependence bug", () => {
    /*
      r11's `checkPinnedSources` and D083/D084 reads sat outside containment
      and resolved relative paths against the process cwd, so verifying from
      another directory threw ENOENT out of the verifier.
    */
    const doc = load();
    const original = process.cwd();
    try {
      process.chdir("/");
      let r!: ReturnType<typeof verifyArtifact>;
      expect(() => { r = verifyArtifact(doc); }).not.toThrow();
      expect(r.ok).toBe(false);
      // A stable code, and no attacker-controlled value in the message.
      expect(r.failures.join(" | ")).toMatch(/reconstruction: .*(ENOENT|READ_FAILED)/);
    } finally {
      process.chdir(original);
    }
  });

  it("#28 rejects a reversed sourceManifest, coherently resealed", () => {
    // Ordering was never canonical under r11, so a reversed manifest verified.
    const a = load();
    a.snapshot.sourceManifest.reverse();
    reseal(a);
    const r = verifyArtifact(a);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["a reversed bindings array", (a: any) => { a.snapshot.bindings.reverse(); }],
    ["a reversed cells array", (a: any) => { a.analysis.cells.reverse(); }],
    ["a reversed blockerCensus", (a: any) => { a.analysis.blockerCensus.reverse(); }],
    ["a reversed funnel", (a: any) => { a.analysis.funnel.reverse(); }],
  ])("rejects %s, coherently resealed", (_l, mutate) => {
    const a = load();
    mutate(a);
    reseal(a);
    expect(verifyArtifact(a).ok).toBe(false);
  });
});

describe("D085 C11 — the output-path guard that would have prevented the r11 overwrite", () => {
  it("derives the output path from the contract version", () => {
    // Advancing a version and advancing the artifact PATH were two edits under
    // r11; doing the first without the second pointed the generator at frozen
    // history and destroyed r11. They are one edit now.
    const rev = d085RevisionOf(D085_CONTRACT_ID);
    expect(D085_JSON_OUT).toBe(d085ArtifactPathFor(rev));
    expect(D085_JSON_OUT).toContain(`.r${rev}.json`);
  });

  it("lists every earlier revision as frozen", () => {
    // Every earlier revision, derived — one entry per rejected predecessor.
    expect(D085_FROZEN_ARTIFACTS.length).toBe(d085RevisionOf(D085_CONTRACT_ID) - 1);
    expect(D085_FROZEN_ARTIFACTS).toContain("docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.r14.json");
    expect(D085_FROZEN_ARTIFACTS).toContain("docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.r11.json");
    expect(D085_FROZEN_ARTIFACTS).toContain("docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.r12.json");
    expect(D085_FROZEN_ARTIFACTS).toContain("docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.r13.json");
    expect(D085_FROZEN_ARTIFACTS).toContain("docs/audits/generated/d085-budget-proposal-dry-run-2026-09-01.json");
  });

  it("REFUSES to write any frozen artifact — proven without touching one", () => {
    for (const frozen of D085_FROZEN_ARTIFACTS) {
      expect(() => assertWritableArtifactPath(frozen), `must refuse ${frozen}`).toThrow(/frozen|rejected/);
    }
  });

  it("refuses any path other than the current revision's", () => {
    expect(() => assertWritableArtifactPath("docs/audits/generated/elsewhere.json")).toThrow();
    expect(() => assertWritableArtifactPath("package.json")).toThrow();
  });

  it("permits exactly the current target", () => {
    expect(assertWritableArtifactPath(D085_JSON_OUT)).toBe(D085_JSON_OUT);
  });

  it("keeps r11 byte-identical to its recovered pin", () => {
    // The artifact this correction destroyed and Codex deterministically
    // recovered. Checked here so any future run that touches it fails loudly.
    const r11 = readFileSync(resolve(D085_REJECTED_R11.path));
    expect(createHash("sha256").update(r11).digest("hex")).toBe(D085_REJECTED_R11.fileSha256);
  });

  it("pins r11 as rejected with all four hashes", () => {
    expect(D085_REJECTED_R11.status).toBe("rejected");
    expect(D085_REJECTED_R11.fileSha256).toBe("245dcfac0ef48eae9e9962774edbabce3c8fb0567805646f0a99d0de6f025d00");
    expect(D085_REJECTED_R11.artifactHash).toBe("cbfd9c9918a292e2491cb2ef1f1e85450751359defedbe90994742ddbd2fbc1e");
    expect(D085_REJECTED_R11.snapshotHash).toBe("6ba00abf513cba4382a8956cefa4c067d6cc83ae1b6f9bfb4b68030f185cf111");
    expect(D085_REJECTED_R11.analysisHash).toBe("18632238774de0f383988335ad70e514adc6685f99243fd6c15b3f2ecbedc29f");
    expect(D085_REJECTED_R11.contract).toBe("d085.budget-proposal-dry-run.v11");
    expect(D085_REJECTED_R11.why).toMatch(/42 executable failures/);
    expect(D085_REJECTED_R11.why).toMatch(/4,294,967,295/);
  });
});

// ---------------------------------------------------------------------------
// Correction 12 — findings 10-12: filesystem identity, containment, safe temp
// ---------------------------------------------------------------------------

describe("D085 C12 — C: filesystem identity and containment", () => {
  it("#10 a VALID artifact verifies from ANY working directory", () => {
    /*
      r12 claimed canonical repository-root paths and used `resolve()`, which is
      cwd-relative — and the Correction 11 test changed cwd to `/` and asserted
      an ENOENT FAILURE, enshrining the bug as expected behaviour. The
      expectation is inverted here: a valid artifact must verify anywhere.
    */
    const doc = JSON.parse(readFileSync(d085TrustedPath(D085_JSON_OUT), "utf8")) as Record<string, unknown>;
    const original = process.cwd();
    try {
      for (const cwd of ["/", "/tmp"]) {
        process.chdir(cwd);
        const r = verifyArtifact(doc);
        expect(r.failures, `cwd=${cwd}`).toEqual([]);
        expect(r.ok, `cwd=${cwd}`).toBe(true);
      }
    } finally {
      process.chdir(original);
    }
  });

  it("#10b derives the repository root from the module, not the process", () => {
    expect(D085_REPO_ROOT).toMatch(/Adsecute$/);
    expect(d085TrustedPath(D085_JSON_OUT).startsWith(D085_REPO_ROOT)).toBe(true);
    // The output path is absolute and cwd-independent.
    const original = process.cwd();
    try {
      process.chdir("/");
      expect(d085TrustedPath(D085_JSON_OUT).startsWith(D085_REPO_ROOT)).toBe(true);
    } finally {
      process.chdir(original);
    }
  });

  it("#11 verifyArtifact performs NO filesystem read after reconstruction", () => {
    /*
      r12 re-ran `checkPinnedSources()` and re-read D083/D084 after the
      contained try/catch, so a later or racing I/O failure still escaped as a
      throw. This asserts the property structurally, over the function body
      with comments stripped.
    */
    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    const body = src.slice(src.indexOf("export function verifyArtifact("), src.indexOf("export function runVerify("));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    const after = code.slice(code.indexOf('checked.push("reconstruction")'));
    expect(after).not.toMatch(/readFileSync|checkPinnedSources\(/);
  });

  it("#11b an unreadable artifact yields a stable code, never a throw", () => {
    // Non-leaking: a filesystem errno class, not a path or attacker string.
    expect(readFailureCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(readFailureCode(new Error("boom"))).toBe("READ_FAILED");
    expect(readFailureCode({ code: "../../etc/passwd" })).toBe("READ_FAILED");
  });

  it("#11c injects the D085 trusted reader rather than modifying D084", () => {
    // d084-pinned-sources already accepts reader injection; it is not edited.
    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    expect(src).toContain("checkPinnedSources(d085TrustedReader)");
    expect(d085TrustedReader("package.json").length).toBeGreaterThan(0);
  });
});

describe("D085 C12 — D: the frozen-artifact write is symlink-safe", () => {
  it("#12 refuses to open a symlinked temp path, in an ISOLATED directory", () => {
    /*
      r12 wrote to the fixed sibling `<final>.writing` with `writeFileSync`,
      which FOLLOWS SYMLINKS: a pre-existing symlink at that name truncates the
      frozen target before the rename — the accident that destroyed r11, made
      deliberate. The attack symlink is created in a temp directory; nothing
      under docs/audits/generated is touched.
    */
    const dir = mkdtempSync(join(tmpdir(), "d085-symlink-guard-"));
    const victim = join(dir, "frozen-stand-in.json");
    const ORIGINAL = "FROZEN CONTENT\n";
    writeFileSync(victim, ORIGINAL, "utf8");
    const tempPath = join(dir, "r13.json.1234.abcdef.tmp");
    symlinkSync(victim, tempPath);

    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
    let refusedCode = "";
    try {
      const fd = openSync(tempPath, flags, 0o644);
      closeSync(fd);
    } catch (error) {
      refusedCode = String((error as { code?: string }).code);
    }
    expect(refusedCode, "an existing path of any kind must fail the exclusive open").not.toBe("");
    expect(readFileSync(victim, "utf8"), "the stand-in frozen file must be untouched").toBe(ORIGINAL);
    rmSync(dir, { recursive: true, force: true });
  });

  it("#12b uses a unique, exclusive, no-follow temp — not a predictable sibling", () => {
    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    expect(src, "the predictable `.writing` sibling must be gone").not.toContain("`${finalPath}.writing`");
    expect(src).toContain("O_EXCL");
    expect(src).toContain("O_NOFOLLOW");
    expect(src).toContain("randomBytes");
    /*
      Re-validated immediately before rename. Correction 14 extracted the
      publisher so its ownership rule is testable, so the re-validation now
      travels as an injected closure — the scan follows it there.
    */
    expect(src).toMatch(/args\.revalidate\(\);\s*renameSync\(args\.tempPath, args\.finalPath\);/);
    expect(src).toMatch(/revalidate: \(\) => \{[\s\S]{0,300}assertWritableArtifactPath\(outPath\);/);
  });

  it("#12c still refuses every frozen artifact, and permits only the current revision", () => {
    const rev = d085RevisionOf(D085_CONTRACT_ID);
    expect(D085_FROZEN_ARTIFACTS.length).toBe(rev - 1);
    for (const frozen of D085_FROZEN_ARTIFACTS) {
      expect(() => assertWritableArtifactPath(frozen), frozen).toThrow(/frozen|rejected/);
    }
    expect(assertWritableArtifactPath(D085_JSON_OUT)).toBe(D085_JSON_OUT);
    expect(D085_JSON_OUT).toContain(`.r${rev}.json`);
  });

  it("keeps r11 and r12 byte-identical to their pins", () => {
    for (const pin of [D085_REJECTED_R11, D085_REJECTED_R12]) {
      const bytes = readFileSync(d085TrustedPath(pin.path));
      expect(createHash("sha256").update(bytes).digest("hex"), pin.path).toBe(pin.fileSha256);
    }
  });

  it("pins r12 as rejected with all four hashes", () => {
    expect(D085_REJECTED_R12.status).toBe("rejected");
    expect(D085_REJECTED_R12.fileSha256).toBe("7c992a40267142d959d1ee0786e7d15cf6414a685a5d2a76f236883da249070d");
    expect(D085_REJECTED_R12.artifactHash).toBe("c394c387f684aa4c12b4e2437a970ea981787304a5922fc7fef41133c381c78d");
    expect(D085_REJECTED_R12.snapshotHash).toBe("3cf5b3aee0ce0ad3905a4c9782a7c6c99528cbd6ff6c2e881de8c74bac390006");
    expect(D085_REJECTED_R12.analysisHash).toBe("de37501078d8566ce27d28f0501dd0c7babc29489f27daa22ab07ef2c6d15468");
    expect(D085_REJECTED_R12.contract).toBe("d085.budget-proposal-dry-run.v12");
    expect(D085_REJECTED_R12.why).toMatch(/UTF-16 code units/);
    expect(D085_REJECTED_R12.why).toMatch(/follows symlinks/);
  });
});

// ---------------------------------------------------------------------------
// Correction 13 — finding 2: the write must be COMPLETE, not merely atomic
// ---------------------------------------------------------------------------

describe("D085 C13/C14 — publishing completeness and ownership, via the self-test", () => {
  /*
    The properties are unchanged; the AUTHORITY is not.

    r13 called `writeSync(fd, payload, 0, "utf8")` once and ignored the
    returned count, so a short write was closed and renamed — publishing a
    TRUNCATED artifact atomically. r14's `catch` unlinked a temp path a FAILED
    exclusive open had never acquired. Both are still proven here, but through
    `publisherSelfTest()`, which takes no arguments and works only inside a
    directory it creates and removes. r15 proved them by EXPORTING the
    publisher and the write loop, which handed every caller a destination of
    their choosing.
  */
  const report = publisherSelfTest();

  it("every byte is published, or nothing is", () => {
    expect(report.partialWrites.singleShotExact, "a well-behaved sink writes every byte").toBe(true);
    expect(report.partialWrites.chunkedExact, "a chunking sink still writes every byte").toBe(true);
    expect(report.partialWrites.shortFinalWriteExact, "a short final write is completed, not accepted").toBe(true);
  });

  it("a sink that never progresses fails loudly instead of looping", () => {
    expect(report.partialWrites.zeroProgressThrows).toBe(true);
    expect(report.partialWrites.negativeCountThrows).toBe(true);
  });

  it("an erroring sink propagates rather than publishing a partial file", () => {
    expect(report.partialWrites.throwingWriterPropagates).toBe(true);
  });

  it("a failed exclusive open owns nothing and removes nothing", () => {
    expect(report.collisionRegularFile.errorCode).toBe("EEXIST");
    expect(report.collisionRegularFile.sentinelSurvived).toBe(true);
    expect(report.collisionRegularFile.sentinelBytesUnchanged).toBe(true);
    expect(report.collisionRegularFile.finalPublished).toBe(false);
  });

  it("the whole self-test passes and leaves nothing behind", () => {
    expect(report.ok).toBe(true);
    expect(existsSync(report.directory)).toBe(false);
  });

  it("the assembler uses the loop, not a single unchecked writeSync", () => {
    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    expect(src).not.toMatch(/writeSync\(fd, payload, 0, "utf8"\)/);
    expect(src).toContain("writeAllBytes(fd, args.payload)");
    expect(src).toMatch(/const payload = Buffer\.from\(/);
  });
});


// ===========================================================================
// Correction 15 — five findings, made permanent
// ===========================================================================

/** The one revision, read back through the audit contract that derives from it. */
const REVISION = d085RevisionOf(D085_CONTRACT_ID);

describe("D085 — the artifact and the pins Codex reported independently", () => {
  it("the published current-revision artifact is byte-complete and round-trips exactly", () => {
    const raw = readFileSync(d085TrustedPath(D085_JSON_OUT));
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    expect(Buffer.from(`${JSON.stringify(parsed, null, 1)}\n`, "utf8")).toEqual(raw);
  });

  /*
    The ONE deliberate second copy in this file.

    Everywhere else a repeated literal is the defect this correction exists to
    remove. These four-hash rows are different in kind: they are what CODEX
    reported from its own independent reconciliation, transcribed here so the
    records can be checked against a source outside this repository's own
    constants. A record that agrees only with itself is what let r15's v2
    digest survive.
  */
  it.each([
    ["r13", 13, "150277bab191a92ea68a82bf6cb258cbc8d87b9e116947679c5d1864365342cc",
      "d4e88e1127918a267d643ea2969331011706deea1bed8b9e4a3abd6f7360a60b",
      "95cc2bcbcbf98d86cd9ea8e004914a9795c83de8a601ee2464ccf7882cb6223b",
      "a17edd1e56a05084647fe1fdbfcd2825cf19289c5ee59e0a56b4d0ae962d11c9"],
    ["r14", 14, "4ae8676b7a65bab4306e4960625c5c075a137c9dd91bd7363069fa0b5f1625dd",
      "0d5209e80f242663a071bcc006966a203aef15eb1c5b0966f9aea09c04faeb4a",
      "dfd2c36fc0ae40b99ed2944da464e2140319934527d3aada5626cccc4ab55455",
      "b5d316ee987599ed2ff93d6dc213e10bcf06cf85c492701091f89f897556b76d"],
    ["r15", 15, "26523fcb7ab1ec09a469b6ec6777f2c93c1068033348745c456af85c6aee0862",
      "16a35da886c4dfc1a438484c08fe0416147d97496b8e046fc3c19ee528d81485",
      "17439f003ea32fd3f81503f8c468ffb7f479e638de6d28aa82daec33a180ec68",
      "9c7df7af8aaae631680a298afe43ccf8d040ef8caec68d6fea18c6599491b728"],
  ])("pins %s as rejected with all four independently reported hashes", (_l, rev, file, artifact, snapshot, analysis) => {
    const rec = D085_REJECTED_PASSES.find((r) => r.revision === rev)!;
    expect(rec.status).toBe("rejected");
    expect(rec.contract).toBe(`d085.budget-proposal-dry-run.v${rev}`);
    expect(rec.fileSha256).toBe(file);
    expect(rec.artifactHash).toBe(artifact);
    expect(rec.snapshotHash).toBe(snapshot);
    expect(rec.analysisHash).toBe(analysis);
    // ...and the file on disk still hashes to the value Codex reported.
    expect(createHash("sha256").update(d085TrustedReader(rec.path)).digest("hex")).toBe(file);
  });

  it("r13's stated reason is still the reason it was rejected for", () => {
    expect(D085_REJECTED_R13.why).toMatch(/TWO rule sets that drifted/);
    expect(D085_REJECTED_R13.why).toMatch(/ignored the returned byte count/);
  });

  it("r15's stated reason names all five findings", () => {
    const why = D085_REJECTED_R15.why;
    expect(why).toMatch(/0495c156cc2/);            // the false digest
    expect(why).toMatch(/skipIf\(!RESOLVER_APPROVED\)/);
    expect(why).toMatch(/atomicPublish/);
    expect(why).toMatch(/contiguousRejectedVersions/);
    expect(why).toMatch(/v1 through v9/);
  });
});

describe("D085 C15 #1 — the published historical record must match the bytes", () => {
  /*
    r15 published `0495c156cc2…` as the SHA-256 of r2. The file's actual digest
    is `0495c156fcc2…` — an `f` dropped from a hand-copied literal, leaving a
    63-character string where a SHA-256 has 64. `verifyArtifact` compared the
    artifact's lineage against `canonicalRejectedLineage()`: one authored
    constant against another. It never opened a historical file, so fourteen
    corrections of "independently verified" rested on a check that re-reads
    nothing, and a lineage that is not even well-formed hex passed it.
  */
  const lineage = () => canonicalRejectedLineage();

  it("every published lineage hash is a well-formed lowercase 64-hex digest", () => {
    const malformed = lineage()
      .filter((r) => !/^[0-9a-f]{64}$/.test(r.fileSha256))
      .map((r) => `${r.contract}=${r.fileSha256} (len ${r.fileSha256.length})`);
    expect(malformed, "a SHA-256 has 64 hex characters").toEqual([]);
  });

  it("every published lineage hash equals the ACTUAL bytes of its frozen file", () => {
    const wrong: string[] = [];
    for (const row of lineage()) {
      const path = d085ArtifactPathFor(d085RevisionOf(row.contract));
      const actual = createHash("sha256").update(d085TrustedReader(path)).digest("hex");
      if (actual !== row.fileSha256) wrong.push(`${row.contract}: published ${row.fileSha256}, actual ${actual}`);
    }
    expect(wrong, "the record must describe the files that exist").toEqual([]);
  });

  it("the lineage covers EXACTLY the contiguous rejected revisions, in order", () => {
    expect(lineage().map((r) => r.contract)).toEqual(
      Array.from({ length: REVISION - 1 }, (_, i) => `d085.budget-proposal-dry-run.v${i + 1}`),
    );
  });

  it("the named rejected-pass records cannot disagree with the lineage", () => {
    // The same fact in two places is the defect; these must be one source.
    const byContract = new Map(lineage().map((r) => [r.contract, r.fileSha256]));
    for (const rec of [D085_REJECTED_FIRST_PASS, D085_REJECTED_R2, D085_REJECTED_R3, D085_REJECTED_R4,
      D085_REJECTED_R5, D085_REJECTED_R6, D085_REJECTED_R7, D085_REJECTED_R8, D085_REJECTED_R10,
      D085_REJECTED_R11, D085_REJECTED_R12, D085_REJECTED_R13] as ReadonlyArray<{ contract: string; fileSha256: string; path: string }>) {
      expect(byContract.get(rec.contract), `${rec.contract} lineage/record disagreement`).toBe(rec.fileSha256);
      const actual = createHash("sha256").update(d085TrustedReader(rec.path)).digest("hex");
      expect(actual, `${rec.contract} record does not match its file`).toBe(rec.fileSha256);
    }
  });

  it("the frozen path list is derived from the same records, not a second list", () => {
    expect([...D085_FROZEN_ARTIFACTS]).toEqual(lineage().map((r) => d085ArtifactPathFor(d085RevisionOf(r.contract))));
  });

  it("verifyArtifact FAILS when a frozen artifact's bytes disagree with the record", () => {
    /*
      Proven with an injected reader, so the check is shown capable of failing
      without touching frozen history. r15's verifier had no such step at all.
    */
    const artifact = load();
    const victim = d085ArtifactPathFor(2);
    const tamperedReader = (rel: string): Buffer =>
      rel === victim ? Buffer.from("TAMPERED BYTES\n", "utf8") : d085TrustedReader(rel);
    const result = verifyArtifact(artifact, tamperedReader);
    expect(result.ok, "a changed historical file must fail verification").toBe(false);
    expect(result.failures.join(" | ")).toMatch(/r2\.json|budget-proposal-dry-run\.v2/);
  });

  it("verifyArtifact FAILS when a frozen artifact is missing or unreadable", () => {
    const artifact = load();
    const missing = d085ArtifactPathFor(7);
    const enoent = (rel: string): Buffer => {
      if (rel !== missing) return d085TrustedReader(rel);
      const error = new Error("no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    const result = verifyArtifact(artifact, enoent);
    expect(result.ok, "an unreadable historical file must fail verification").toBe(false);
    expect(result.failures.join(" | ")).toMatch(/ENOENT|could not be read/);
  });

  it("POSITIVE CONTROL: with the real reader the historical check passes", () => {
    const result = verifyArtifact(load(), d085TrustedReader);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toContain("historicalArtifacts");
  });

  it("the EMITTED artifact agrees with the canonical sources and the real files", () => {
    // Always-run: the published document, not just the constants that made it.
    const a = load();
    expect(a.contract).toBe(D085_CONTRACT_ID);
    expect(a.rejectedLineage).toEqual(canonicalRejectedLineage());
    expect(a.receiptLineage).toEqual(canonicalReceiptLineage());
    expect(a.receiptLineage.current).toBe(PREVIEW_CONTRACT_VERSION);
    for (const row of a.rejectedLineage as ReadonlyArray<{ contract: string; fileSha256: string }>) {
      const actual = createHash("sha256")
        .update(d085TrustedReader(d085ArtifactPathFor(d085RevisionOf(row.contract)))).digest("hex");
      expect(actual, `${row.contract} in the emitted artifact`).toBe(row.fileSha256);
    }
  });

  it("the receipt lineage is DERIVED from the runtime source, not retyped", () => {
    expect([...D085_RECEIPT_LINEAGE]).toEqual([...META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS]);
    expect(canonicalReceiptLineage().rejected).toEqual([...META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS]);
    expect(canonicalReceiptLineage().current).toBe(PREVIEW_CONTRACT_VERSION);
  });

  it("ONE revision source feeds the runtime contract and the audit contract", () => {
    expect(D085_CONTRACT_ID).toBe(`d085.budget-proposal-dry-run.v${D085_REVISION}`);
    expect(META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT).toBe(`meta.budget-proposal-dry-run.v${D085_REVISION}`);
    expect(d085RevisionOf(D085_CONTRACT_ID)).toBe(D085_REVISION);
  });
});

// ---------------------------------------------------------------------------

/**
 * Walk a tree the way a production-boundary invariant must: from the ROOT,
 * across every production code extension, excluding only what is explicitly
 * not production.
 */
const NON_PRODUCTION_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", "out",
  "playwright-report", "test-results", "playwright", "public", "certificates",
  "docs", "_analysis", "deploy", "__tests__", "__mocks__", "__fixtures__", "e2e",
]);
const PRODUCTION_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const IS_TEST_FILE = /\.(test|spec)\.[a-z]+$/;

const productionFiles = (root: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (NON_PRODUCTION_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!PRODUCTION_EXTENSIONS.test(entry.name)) continue;
      if (IS_TEST_FILE.test(entry.name)) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
};

/** Real linkage to a forge helper: an import/require or an export of one. */
const reachesForgeHelper = (src: string): boolean =>
  /\b(?:from|import)\s*\(?\s*["'][^"']*(?:__testing__|raw-preview-hash)/.test(src)
  || /\brequire\s*\(\s*["'][^"']*(?:__testing__|raw-preview-hash)/.test(src)
  || /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+\w*(?:[Uu]nsafeRaw|rawCanonical)\w*/.test(src)
  || /\bexport\s*\{[^}]*(?:unsafeRaw|rawCanonical)/i.test(src);

describe("D085 C15 #2 — the production-boundary invariant, whole-graph and always-run", () => {
  /*
    The Correction 14 version walked four hand-picked directories, matched two
    extensions, and sat inside `describe.skipIf(!RESOLVER_APPROVED)` — so the
    ordinary no-approval run skipped it. This repository also has `src`,
    `store`, `providers`, `hooks` and 27 root-level code and config files, many
    of them `.js`/`.mjs`. This suite has no approval gate.
  */
  it("NO importable forge module exists anywhere in the repository", () => {
    // The r15 remedy was a test-only module that production could still import.
    // The remedy is now that the module does not exist.
    expect(existsSync(join(D085_REPO_ROOT, "lib/meta/__testing__/raw-preview-hash.testing.ts")),
      "the forge module must be gone, not merely conventionally avoided").toBe(false);
    expect(existsSync(join(D085_REPO_ROOT, "lib/meta/__testing__")),
      "no __testing__ escape hatch directory").toBe(false);
  });

  it("no production file in the WHOLE repository reaches a raw-hash forge helper", () => {
    const offenders = productionFiles(D085_REPO_ROOT)
      .filter((f) => reachesForgeHelper(readFileSync(f, "utf8")))
      .map((f) => f.slice(D085_REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("the traversal actually covers the roots and extensions r15 omitted", () => {
    const rel = productionFiles(D085_REPO_ROOT).map((f) => f.slice(D085_REPO_ROOT.length + 1));
    for (const root of ["src", "store", "providers", "hooks", "lib", "app", "components", "scripts"]) {
      expect(rel.some((f) => f.startsWith(`${root}/`)), `root '${root}' must be traversed`).toBe(true);
    }
    expect(rel.some((f) => !f.includes("/")), "root-level files must be traversed").toBe(true);
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
      expect(rel.some((f) => f.endsWith(ext)), `extension '${ext}' must be scanned`).toBe(true);
    }
  });

  it("ISOLATED FIXTURES: an offender in an omitted root or a .mjs goes red", () => {
    /*
      Built in a temp tree rather than in this repository, so the detector is
      proven without writing a fixture into the worktree. If a future edit
      narrows the roots or the extensions back down, these go red.
    */
    const dir = mkdtempSync(join(tmpdir(), "d085-c15-graph-"));
    try {
      for (const [rel, body] of [
        ["src/lib/sneaky.ts", 'import { rawCanonicalPreviewHashForTests } from "@/lib/meta/__testing__/raw-preview-hash.testing";\n'],
        ["store/forge.js", 'const h = require("../lib/meta/__testing__/raw-preview-hash.testing");\n'],
        ["providers/reseal.mjs", 'import { rawCanonicalPreviewHashForTests } from "./raw-preview-hash.testing.mjs";\n'],
        ["hooks/useForge.tsx", 'export const rawCanonicalPreviewHash = () => "";\nexport function rawCanonicalHelper() { return ""; }\n'],
        ["root-level.cjs", 'const x = require("./lib/meta/__testing__/raw-preview-hash.testing");\n'],
        ["clean/ordinary.ts", 'export const fine = 1;\n'],
        ["clean/mentions-in-prose.ts", '// the forge helper rawCanonicalPreviewHashForTests was removed in v16\nexport const ok = 1;\n'],
      ] as Array<[string, string]>) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
      }
      const flagged = productionFiles(dir)
        .filter((f) => reachesForgeHelper(readFileSync(f, "utf8")))
        .map((f) => f.slice(dir.length + 1))
        .sort();
      expect(flagged).toEqual([
        "hooks/useForge.tsx", "providers/reseal.mjs", "root-level.cjs", "src/lib/sneaky.ts", "store/forge.js",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the runtime module exports no raw or unsafe hash helper", async () => {
    const mod = await import("@/lib/meta/budget-proposal-dry-run");
    expect(Object.keys(mod).filter((k) => /raw|unsafe|forge/i.test(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("D085 C15 #3 — testability may not widen write authority", () => {
  /*
    r15 exported `atomicPublish({finalPath, tempPath, payload, revalidate})`.
    Any caller could name any destination, name any temp path, pass a no-op
    policy, and overwrite an accessible file — a frozen D085 artifact included.
    `assertWritableArtifactPath` guards `runAssemble`'s closure, not that
    export. Making a guard exercisable must not hand out the capability.
  */
  it("the audit module exports NO arbitrary-path writer", async () => {
    const mod = await import("@/scripts/audits/d085-budget-proposal-dry-run") as Record<string, unknown>;
    expect(Object.keys(mod)).not.toContain("atomicPublish");
    expect(Object.keys(mod)).not.toContain("writeAllBytes");
    const writers = Object.keys(mod).filter((k) => /publish|atomicWrite|writeAll|writeBytes/i.test(k));
    expect(writers, "only the no-argument self-test may remain").toEqual(["publisherSelfTest"]);
  });

  it("no exported function accepts a caller-selected destination", async () => {
    /*
      Read from the SOURCE, not from the function object.

      TypeScript erases parameter types, so `Function.prototype.toString` on a
      built `(args: { finalPath: string }) => …` reports only `args` — a
      runtime scan cannot see the shape that matters. The exported signatures
      are read from the module text instead, and the extractor is proven on
      the exact r15 declaration.
    */
    const exportedParameters = (src: string): Array<[string, string]> => {
      const out: Array<[string, string]> = [];
      const re = /export\s+function\s+(\w+)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        let depth = 0;
        const open = m.index + m[0].length - 1;
        for (let i = open; i < src.length; i += 1) {
          if (src[i] === "(") depth += 1;
          else if (src[i] === ")") {
            depth -= 1;
            if (depth === 0) { out.push([m[1], src.slice(open + 1, i)]); break; }
          }
        }
      }
      return out;
    };
    const leaks = ([, params]: [string, string]) => /\bfinalPath\b|\btempPath\b|\brevalidate\b/.test(params);

    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    const signatures = exportedParameters(src);
    expect(signatures.length, "the extractor must find the exported functions").toBeGreaterThan(5);
    expect(signatures.filter(leaks).map(([n]) => n),
      "an exported function must not take a caller-chosen path or policy").toEqual([]);

    // POSITIVE CONTROL: the r15 declaration, verbatim, is detected.
    const r15Source = `export function atomicPublish(args: {\n  finalPath: string;\n  tempPath: string;\n  payload: Buffer;\n  revalidate: () => void;\n}): void {}\n`;
    expect(exportedParameters(r15Source).filter(leaks).map(([n]) => n)).toEqual(["atomicPublish"]);

    // ...and anything that publishes must choose its own destination.
    const mod = await import("@/scripts/audits/d085-budget-proposal-dry-run") as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function" && /publish/i.test(name)) {
        expect((value as (...a: unknown[]) => unknown).length, `${name} must take no arguments`).toBe(0);
      }
    }
  });

  it("the r15 capability is GONE: a sentinel final path cannot be overwritten", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d085-c15-authority-"));
    try {
      const sentinel = join(dir, "frozen-artifact.json");
      const bytes = Buffer.from("FROZEN SENTINEL — MUST NOT BE OVERWRITTEN\n", "utf8");
      writeFileSync(sentinel, bytes);
      const mod = await import("@/scripts/audits/d085-budget-proposal-dry-run") as Record<string, any>;
      // Exactly the r15 call that succeeded.
      try {
        mod.atomicPublish?.({
          finalPath: sentinel,
          tempPath: join(dir, "anything.tmp"),
          payload: Buffer.from("OVERWRITTEN\n", "utf8"),
          revalidate: () => {},
        });
      } catch { /* an absent or refusing export is the point */ }
      expect(readFileSync(sentinel), "the sentinel must survive the r15 call shape").toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publisherSelfTest takes no arguments and cleans up after itself", () => {
    expect(publisherSelfTest.length, "no caller-selectable authority").toBe(0);
    const report = publisherSelfTest();
    expect(existsSync(report.directory), "the self-test must remove its own directory").toBe(false);
    expect(report.ok).toBe(true);
  });

  it("SELF-TEST: an EEXIST regular-file sentinel survives and nothing is published", () => {
    const r = publisherSelfTest();
    expect(r.collisionRegularFile).toEqual({
      openFailed: true, errorCode: "EEXIST", ownedTemp: false,
      sentinelSurvived: true, sentinelBytesUnchanged: true,
      revalidateRan: false, finalPublished: false,
    });
  });

  it("SELF-TEST: a colliding SYMLINK is neither followed nor removed", () => {
    const r = publisherSelfTest();
    expect(r.collisionSymlink).toEqual({
      openFailed: true, ownedTemp: false, symlinkSurvived: true,
      targetBytesUnchanged: true, finalPublished: false,
    });
  });

  it("SELF-TEST: a temp this call DID create is removed when a later step fails", () => {
    const r = publisherSelfTest();
    expect(r.ownedTempCleanup).toEqual({ threw: true, tempRemoved: true, finalPublished: false });
  });

  it("SELF-TEST: the positive control publishes every byte and leaves no temp", () => {
    const r = publisherSelfTest();
    expect(r.positiveControl).toEqual({ published: true, bytesExact: true, tempRemoved: true });
  });

  it("SELF-TEST: the partial-write loop publishes every byte or nothing", () => {
    // The complete r13 loop coverage, retained — now behind an entrypoint with
    // no caller-selectable fd, writer or path.
    const r = publisherSelfTest();
    expect(r.partialWrites).toEqual({
      singleShotExact: true, chunkedExact: true, shortFinalWriteExact: true,
      zeroProgressThrows: true, throwingWriterPropagates: true, negativeCountThrows: true,
    });
  });
});

// ---------------------------------------------------------------------------

describe("D085 C15 #4 — the runtime exposes constants, not lineage machinery", () => {
  /*
    r15 exported `contiguousRejectedVersions` from the production runtime. It
    threw on malformed input, existed only to build two constants, and widened
    the public surface for no product reason. Derivation is internal; only the
    immutable results are public.
  */
  it("no lineage-derivation helper is exported from the runtime", async () => {
    const mod = await import("@/lib/meta/budget-proposal-dry-run") as Record<string, unknown>;
    expect(Object.keys(mod)).not.toContain("contiguousRejectedVersions");
    const builders = Object.entries(mod)
      .filter(([k, v]) => typeof v === "function" && /lineage|rejectedVersions|contiguous/i.test(k))
      .map(([k]) => k);
    expect(builders, "lineage derivation belongs inside the module").toEqual([]);
  });

  it("the exported lineage constants are immutable and contiguous", async () => {
    const mod = await import("@/lib/meta/budget-proposal-dry-run");
    expect(Object.isFrozen(mod.META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS)).toBe(true);
    expect(Object.isFrozen(mod.META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS)).toBe(true);
    expect([...mod.META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS]).toEqual(
      Array.from({ length: D085_REVISION - 1 }, (_, i) => `meta.budget-proposal-dry-run.v${i + 1}`),
    );
    expect([...mod.META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS]).toEqual(
      Array.from({ length: mod.PREVIEW_RECEIPT_REVISION - 1 }, (_, i) => `meta.budget-preview-receipt.v${i + 1}`),
    );
  });

  it("the receipt contract did NOT move: no receipt semantics changed here", () => {
    expect(PREVIEW_CONTRACT_VERSION).toBe("meta.budget-preview-receipt.v12");
    expect(META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS).toHaveLength(11);
  });
});

describe("D085 C15 #5 — reader-facing claims follow the derived revision", () => {
  it("no comment in the audit source names a stale rejected-version range", () => {
    const src = readFileSync(d085TrustedPath("scripts/audits/d085-budget-proposal-dry-run.ts"), "utf8");
    /*
      COMMENTS only. A rejected pass's `why` quotes the defect it was rejected
      for — including r15's "v1 through v9" — and quoted history is a record,
      not a live claim. Stripping string literals keeps this test aimed at what
      a reader is being told is true NOW.
    */
    const commentsOnly = src
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const claims = [...commentsOnly.matchAll(/v1 through v(\d+)/g)].map((m) => Number(m[1]));
    for (const claimed of claims) {
      expect(claimed, `a comment claims v1 through v${claimed}; the lineage ends at v${REVISION - 1}`)
        .toBe(REVISION - 1);
    }
  });
});
