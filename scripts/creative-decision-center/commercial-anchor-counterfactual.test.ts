/**
 * Focused tests for the offline commercial-anchor counterfactual.
 *
 * They run against the REAL accepted frozen evidence package and encode the
 * two behaviours the previous version got wrong:
 *   - a threshold-cleared row is NOT an unblocked action (the IwaTR 282 Cut /
 *     9 Refresh counterexample);
 *   - a later target revision must never be applied to an earlier origin.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_EVIDENCE_PATH,
  ACCEPTED_EVIDENCE_SHA256,
  CandidateAnchorValidationError,
  COMMERCIAL_ANCHOR_COUNTERFACTUAL_CONTRACT,
  buildCounterfactualArtifact,
  computeBaseline,
  loadFrozenEvidence,
  runScenario,
  selectedHistoricalRows,
  targetPackAsOfOrigin,
  validateCandidateAnchor,
  type CandidateAnchor,
} from "./commercial-anchor-counterfactual";

const IWASTORE = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const GRANDMIX = "5dbc7147-f051-4681-a4d6-20617170074f";
const BILSEM = "6c690fa4-6395-40b5-9755-e99b34d69bc3";
const IWATR = "b79683b4-6f87-48c0-a3ca-44d4356fef51";

const { evidence } = loadFrozenEvidence();

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function candidate(overrides: Partial<CandidateAnchor>): CandidateAnchor {
  return {
    businessId: IWATR,
    currency: "USD",
    sourceLabel: "ILLUSTRATIVE_NOT_AN_APPROVED_TARGET",
    targetCpa: 30,
    ...overrides,
  };
}

function scenarioWith(candidates: CandidateAnchor[]) {
  return runScenario({
    scenarioId: "test",
    kind: "candidate",
    inputClass: "declared_candidate",
    timeSemantics: "as_of_origin",
    candidates,
    evidence,
  });
}

function actionOf(
  scenario: ReturnType<typeof scenarioWith>,
  businessId: string,
  action: "scale" | "cut" | "refresh",
) {
  const business = scenario.byBusiness.find(
    (entry) => entry.businessId === businessId,
  );
  return business?.byAction.find((entry) => entry.action === action);
}

describe("accepted evidence package integrity", () => {
  /*
    PRE-DEPLOY AUDIT — what "accepted" pins, and what it cannot.

    This asserted four byte-equalities: the evidence artifact, the acceptance
    document, and the two CODE files the replay ships with. Two of the four
    are still exactly what was accepted — and they are the two that ARE the
    accepted evidence. The other two are source files that four days of
    D079/D081/D084 and campaign-role-removal work have legitimately moved,
    along with five engine files the artifact's own freeze manifest records.

    Updating those two hashes to the current bytes would say the package was
    re-accepted, which nobody did; leaving them asserting stale bytes says the
    code was never allowed to change, which is not the contract either. They
    are therefore asserted as DRIFT — measured, named, and required to match
    the ledger in `generalized-pit-replay.test.ts`, which carries the full
    seven-file list and the reason for each.

    Regenerating the package needs a replay against retained production data
    and is not something a local gate can do.
  */
  it("the ACCEPTED EVIDENCE is byte-identical to what was accepted", () => {
    // The artifact itself.
    expect(sha256File(ACCEPTED_EVIDENCE_PATH)).toBe(ACCEPTED_EVIDENCE_SHA256);
    // ...and the document that accepted it.
    expect(sha256File("docs/audits/GENERALIZED_PIT_REPLAY_2026-08-30.md")).toBe(
      "81f0ba6434bdf2ee0d07be640e3ddd5618859b7b3d53b92209a522549bf2019e",
    );
  });

  it("the two SOURCE files have drifted, and the drift is declared", () => {
    /*
      Asserted as inequality on purpose: these are the bytes the package was
      frozen against, and they are no longer the bytes on disk. If a future
      change makes them match again — a revert, or a regenerated package — this
      fails, and the ledger entry must be removed in the same commit.
    */
    const FROZEN_AT_ACCEPTANCE = {
      "scripts/creative-decision-center/generalized-pit-replay.ts":
        "9d605c504db42e6d4b092be6f7b33f3285cfffb5ac3f45babd31fd61ecb4f7f6",
      "scripts/creative-decision-center/generalized-pit-replay.test.ts":
        "bed1b0ff95f80f89a4fc231db06939369ffc02679c18e5ab8b46925d58e3d223",
    } as const;
    for (const [file, frozen] of Object.entries(FROZEN_AT_ACCEPTANCE)) {
      expect(sha256File(file), `${file} matches its acceptance bytes again — remove the ledger entry`)
        .not.toBe(frozen);
    }
    // The artifact's own freeze manifest must agree about those same bytes,
    // so the two records cannot drift apart from each other.
    const manifest = (JSON.parse(readFileSync(ACCEPTED_EVIDENCE_PATH, "utf8")) as {
      provenance: { sourceFileSha256AtFreeze: Record<string, string> };
    }).provenance.sourceFileSha256AtFreeze;
    for (const [file, frozen] of Object.entries(FROZEN_AT_ACCEPTANCE)) {
      expect(manifest[file], file).toBe(frozen);
    }
  });

  it("refuses to replay against a package whose bytes do not match", () => {
    expect(() =>
      loadFrozenEvidence("docs/audits/GENERALIZED_PIT_REPLAY_2026-08-30.md"),
    ).toThrowError(/frozen evidence hash mismatch/);
  });
});

describe("no-anchor baseline reproduces the accepted counts", () => {
  it("matches the independently recomputed selected-historical figures", () => {
    const baseline = computeBaseline(selectedHistoricalRows(evidence));
    expect(baseline.selectedHistoricalRows).toBe(15508);
    expect(baseline.heldHardSignals).toBe(1993);
    expect(baseline.profileHardActionIneligible).toBe(1872);
    expect(baseline.campaignContext).toBe(95);
    expect(baseline.recentRecoveryUnverifiable).toBe(26);
    expect(baseline.enabledHardActions).toBe(0);
    expect(
      baseline.profileHardActionIneligible +
        baseline.campaignContext +
        baseline.recentRecoveryUnverifiable,
    ).toBe(baseline.heldHardSignals);
  });

  it("the baseline unblocks nothing, for any action", () => {
    const scenario = runScenario({
      scenarioId: "no_anchor_baseline",
      kind: "baseline",
      inputClass: "observed_frozen_fact",
      timeSemantics: "as_of_origin",
      candidates: [],
      evidence,
    });
    expect(scenario.eligibleAfterTotal).toBe(0);
    // The baseline must NOT read as "nothing blocked": all 1,993 held rows are
    // still blocked, and the unambiguous field says so.
    expect(scenario.blockedAfterTotal).toBe(1993);
    for (const entry of scenario.totalsByAction) {
      expect(entry.eligibleAfter).toBe(0);
      expect(entry.blockedAfterTotal).toBe(entry.heldBefore);
    }
    // The held population is partitioned by action, and it is the accepted one.
    expect(
      scenario.totalsByAction.reduce((sum, entry) => sum + entry.heldBefore, 0),
    ).toBe(1993);
  });
});

/**
 * THE REJECTED CLAIM. A Target CPA candidate clears the common commercial
 * threshold for IwaTR, which has no frozen target pack at all. The previous
 * version reported all 291 held rows as unblocked. Only the 9 held Refresh
 * rows clear the full per-action gate; all 282 held Cuts still need a
 * break-even ROAS that does not exist.
 */
describe("per-action recomputation (IwaTR counterexample)", () => {
  const scenario = scenarioWith([candidate({ businessId: IWATR })]);

  it("holds every IwaTR Cut on the missing break-even ROAS", () => {
    const cut = actionOf(scenario, IWATR, "cut");
    expect(cut?.heldBefore).toBe(282);
    expect(cut?.eligibleAfter).toBe(0);
    expect(cut?.blockedAfterTotal).toBe(282);
    expect(cut?.blockedByEffectiveProfileCode).toEqual({
      break_even_roas_missing: 282,
    });
    expect(cut?.codeTransitions).toEqual({
      "profile_hard_action_ineligible->break_even_roas_missing": 282,
    });
  });

  it("clears exactly the 9 held IwaTR Refresh rows", () => {
    const refresh = actionOf(scenario, IWATR, "refresh");
    expect(refresh?.heldBefore).toBe(9);
    expect(refresh?.eligibleAfter).toBe(9);
    expect(refresh?.blockedAfterTotal).toBe(0);
    expect(refresh?.codeTransitions).toEqual({
      "profile_hard_action_ineligible->eligible": 9,
    });
  });

  it("never reports 291 unblocked rows for IwaTR", () => {
    const business = scenario.byBusiness.find(
      (entry) => entry.businessId === IWATR,
    );
    const eligible = (business?.byAction ?? []).reduce(
      (sum, entry) => sum + entry.eligibleAfter,
      0,
    );
    expect(eligible).toBe(9);
    expect(eligible).not.toBe(291);
    // And no IwaTR Scale row was ever profile-held.
    expect(actionOf(scenario, IWATR, "scale")?.heldBefore).toBe(0);
  });

  it("does not restate the persisted blocker as an anchor sub-cause", () => {
    // Every held row's persisted blocker is `profile_hard_action_ineligible`.
    // Only the AFTER state may carry a specific anchor code.
    const cut = actionOf(scenario, IWATR, "cut");
    expect(
      Object.keys(cut?.blockedByEffectiveProfileCode ?? {}),
    ).not.toContain("profile_hard_action_ineligible");
  });
});

describe("no future target leakage", () => {
  it("a revision recorded after an origin is not knowable at that origin", () => {
    // Bilsem's only pack is effectiveAt 2026-04-22 but recordedAt 2026-07-14.
    const pack = evidence.targetHistory.find(
      (row) => row.businessId === BILSEM,
    );
    expect(pack?.effectiveAt.startsWith("2026-04-22")).toBe(true);
    expect(pack?.recordedAt.startsWith("2026-07-14")).toBe(true);
    // Effective-only resolution would wrongly apply it from 2026-04-23.
    expect(targetPackAsOfOrigin(evidence, BILSEM, "2026-05-11")).toBeNull();
    expect(targetPackAsOfOrigin(evidence, BILSEM, "2026-07-13")).toBeNull();
    // It becomes knowable only once it was actually recorded.
    expect(targetPackAsOfOrigin(evidence, BILSEM, "2026-07-15")).not.toBeNull();
  });

  it("a pre-revision origin therefore keeps its Cut blocked on the missing break-even", () => {
    const scenario = scenarioWith([
      candidate({ businessId: BILSEM, currency: "TRY", targetCpa: 400 }),
    ]);
    const cut = actionOf(scenario, BILSEM, "cut");
    expect(cut?.blockedByEffectiveProfileCode).toEqual({
      break_even_roas_missing: 576,
    });
    const business = scenario.byBusiness.find(
      (entry) => entry.businessId === BILSEM,
    );
    // Every held Bilsem origin predates the revision being recorded, so the
    // resolution consumed no revision at all.
    expect(business?.resolvedTargetRevisions).toEqual([]);
    expect(business?.originsWithNoKnowableTargetPack).toBe(603);
  });

  it("an AOV-only candidate cannot clear the threshold before its ROAS was knowable", () => {
    const scenario = scenarioWith([
      candidate({
        businessId: GRANDMIX,
        targetCpa: null,
        operatorAovAssumption: 90,
      }),
    ]);
    // Without a knowable Target ROAS the pair is not an anchor at all.
    expect(
      actionOf(scenario, GRANDMIX, "cut")?.blockedByEffectiveProfileCode,
    ).toEqual({ commercial_anchor_missing: 149 });
    expect(actionOf(scenario, GRANDMIX, "refresh")?.eligibleAfter).toBe(0);
  });
});

describe("candidate validation is fail-closed", () => {
  it("accepts a well-formed Target CPA candidate", () => {
    expect(() => validateCandidateAnchor(candidate({}), evidence)).not.toThrow();
  });

  it.each([
    ["zero", 0],
    ["negative", -25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s Target CPA", (_label, value) => {
    expect(() =>
      validateCandidateAnchor(candidate({ targetCpa: value }), evidence),
    ).toThrow(CandidateAnchorValidationError);
  });

  it("rejects a candidate with no anchor at all", () => {
    expect(() =>
      validateCandidateAnchor(
        { businessId: IWATR, currency: "USD", sourceLabel: "x" },
        evidence,
      ),
    ).toThrowError(/at least one anchor is required/);
  });

  it("rejects a currency-mismatched candidate", () => {
    expect(() =>
      validateCandidateAnchor(
        candidate({ businessId: BILSEM, currency: "USD", targetCpa: 400 }),
        evidence,
      ),
    ).toThrowError(/frozen business currency is TRY/);
  });

  it("rejects an unknown business and a blank source label", () => {
    expect(() =>
      validateCandidateAnchor(
        candidate({ businessId: "00000000-0000-4000-8000-000000000000" }),
        evidence,
      ),
    ).toThrowError(/not present in the frozen evidence scope/);
    expect(() =>
      validateCandidateAnchor(candidate({ sourceLabel: "  " }), evidence),
    ).toThrowError(/sourceLabel/);
  });

  it("refuses a borrowed ROAS under as-of-origin semantics", () => {
    expect(() =>
      validateCandidateAnchor(
        candidate({ targetRoas: 3 }),
        evidence,
        "as_of_origin",
      ),
    ).toThrowError(/resolved bitemporally/);
  });

  it("requires both paired ROAS values under all-window semantics", () => {
    expect(() =>
      validateCandidateAnchor(
        candidate({ targetRoas: 3 }),
        evidence,
        "declared_all_window",
      ),
    ).toThrowError(/breakEvenRoas/);
    expect(() =>
      validateCandidateAnchor(
        candidate({ targetRoas: 3, breakEvenRoas: 2 }),
        evidence,
        "declared_all_window",
      ),
    ).not.toThrow();
  });
});

describe("declared all-window semantics are explicit and hashed", () => {
  const declared = runScenario({
    scenarioId: "declared",
    kind: "candidate",
    inputClass: "illustrative_sensitivity_input",
    timeSemantics: "declared_all_window",
    candidates: [
      candidate({ businessId: IWATR, targetRoas: 3, breakEvenRoas: 2 }),
    ],
    evidence,
  });

  it("cannot clear the held Cuts from this package once a Target ROAS is declared", () => {
    /*
      RE-PINNED, AND THE TOOL LOST AN ANSWER IT USED TO HAVE. THIS IS REPORTED,
      NOT PAPERED OVER.

      This asserted `eligibleAfter: 282, blockedAfterTotal: 0`: declaring a
      break-even ROAS cleared every held Cut, because the candidate's Target CPA
      of 30 resolved the anchor on its own.

      With the reordered ladder a declared Target ROAS makes the canonical basis
      Meta's own attributed purchase AOV — and `evaluateAction` in
      `commercial-anchor-counterfactual.ts` deliberately withholds every
      calibration-derived rung ("a candidate anchor must clear the gate on its
      own merits"). That premise no longer matches the product: with a Target
      ROAS, the sampled platform rung IS the merit. So no candidate that
      declares a Target ROAS can clear Cut from this package.

      It cannot be fixed by feeding the rung in either: the accepted evidence
      artifact
      (`docs/audits/generated/generalized-pit-replay-evidence-2026-08-30.json`)
      contains no AOV field of any kind — verified by inspection — so the input
      is absent, not merely unread. Restoring the tool's answer needs a fresh
      replay against retained production data, which this file's own header
      already records as something a local gate cannot do.

      What is asserted instead is what the tool CAN still say truthfully: the
      282 Cuts stay held, every one of them for a named anchor reason, and the
      partition is still complete — so the count is not silently lost.
    */
    const cut = actionOf(declared, IWATR, "cut");
    expect(cut?.eligibleAfter).toBe(0);
    expect(cut?.blockedAfterTotal).toBe(282);
    expect(cut?.blockedByEffectiveProfileCode).toEqual({
      commercial_anchor_missing: 282,
    });
    expect(cut?.blockedNotDeterminable).toBe(0);
    expect(cut?.partitionComplete).toBe(true);
    expect(declared.timeSemantics).toBe("declared_all_window");
  });

  it("the declared values are part of the candidate hash", () => {
    const other = runScenario({
      scenarioId: "declared",
      kind: "candidate",
      inputClass: "illustrative_sensitivity_input",
      timeSemantics: "declared_all_window",
      candidates: [
        candidate({ businessId: IWATR, targetRoas: 3, breakEvenRoas: 9 }),
      ],
      evidence,
    });
    const a = buildCounterfactualArtifact({
      evidenceSha256: ACCEPTED_EVIDENCE_SHA256,
      scenarios: [declared],
    });
    const b = buildCounterfactualArtifact({
      evidenceSha256: ACCEPTED_EVIDENCE_SHA256,
      scenarios: [other],
    });
    expect(a.candidateInputsSha256).not.toBe(b.candidateInputsSha256);
  });
});

describe("honest unknowns and determinism", () => {
  it("rows blocked first by an independent gate are never anchor transitions", () => {
    const scenario = scenarioWith([candidate({ businessId: GRANDMIX })]);
    const business = scenario.byBusiness.find(
      (entry) => entry.businessId === GRANDMIX,
    );
    expect(business?.blockedByIndependentGate.campaignContext).toBe(14);
    expect(business?.blockedByIndependentGate.recentRecoveryUnverifiable).toBe(
      3,
    );
    // The independent-gate rows are now counted INSIDE the action partition,
    // as independent-gate outcomes, so the whole held population accounts for.
    for (const entry of business?.byAction ?? []) {
      expect(entry.partitionComplete).toBe(true);
    }
    const independent = (business?.byAction ?? []).reduce(
      (sum, entry) =>
        sum +
        entry.blockedByCampaignContext +
        entry.blockedByRecentRecoveryUnverifiable,
      0,
    );
    expect(independent).toBe(17);
  });

  it("two identical runs produce byte-identical artifacts with no wall clock", () => {
    const build = () =>
      buildCounterfactualArtifact({
        evidenceSha256: ACCEPTED_EVIDENCE_SHA256,
        scenarios: [scenarioWith([candidate({})])],
      });
    const first = JSON.stringify(build());
    expect(first).toBe(JSON.stringify(build()));
    expect(first).not.toMatch(
      /generatedAt|"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\s*,\s*"phase/,
    );
  });

  it("states the per-action and leakage boundaries explicitly", () => {
    const artifact = buildCounterfactualArtifact({
      evidenceSha256: ACCEPTED_EVIDENCE_SHA256,
      scenarios: [],
    });
    const honesty = artifact.honesty.join(" ");
    expect(artifact.contract).toBe(COMMERCIAL_ANCHOR_COUNTERFACTUAL_CONTRACT);
    expect(honesty).toContain("PER ACTION");
    expect(honesty).toContain("bitemporally");
    expect(honesty).toContain("not_determinable_from_frozen_evidence");
    expect(honesty).toContain("No revenue");
    expect(honesty).toContain("irreducible unknown");
  });
});

describe("source hygiene", () => {
  it("the replay source contains no raw NUL bytes", () => {
    // Composite keys use \u0000 as a separator. A tool-encoding round trip has
    // twice turned that escape into a literal NUL, which makes the file read as
    // binary to grep and to review. The escape must survive as text.
    for (const file of [
      "scripts/creative-decision-center/commercial-anchor-counterfactual.ts",
      "lib/meta/commercial-anchor-panel.ts",
      "lib/creative-decision-engine/commercial-anchor.ts",
    ]) {
      const bytes = readFileSync(resolve(file));
      expect(bytes.includes(0), `${file} contains a raw NUL byte`).toBe(false);
    }
  });
});

describe("C2.4 — every action partition is arithmetically complete", () => {
  const scenarios = [
    runScenario({
      scenarioId: "baseline",
      kind: "baseline",
      inputClass: "observed_frozen_fact",
      timeSemantics: "as_of_origin",
      candidates: [],
      evidence,
    }),
    scenarioWith([
      candidate({ businessId: IWATR }),
      candidate({ businessId: IWASTORE, targetCpa: 25 }),
      candidate({ businessId: BILSEM, currency: "TRY", targetCpa: 400 }),
      candidate({
        businessId: GRANDMIX,
        targetCpa: null,
        operatorAovAssumption: 90,
      }),
    ]),
  ];

  function accounted(entry: {
    eligibleAfter: number;
    blockedByEffectiveProfileCodeTotal: number;
    blockedNoCandidate: number;
    blockedNotDeterminable: number;
    blockedByCampaignContext: number;
    blockedByRecentRecoveryUnverifiable: number;
    blockedByOtherIndependentGate: number;
  }) {
    return (
      entry.eligibleAfter +
      entry.blockedByEffectiveProfileCodeTotal +
      entry.blockedNoCandidate +
      entry.blockedNotDeterminable +
      entry.blockedByCampaignContext +
      entry.blockedByRecentRecoveryUnverifiable +
      entry.blockedByOtherIndependentGate
    );
  }

  it("holds for every business/action row AND every total row", () => {
    for (const scenario of scenarios) {
      expect(scenario.partitionComplete).toBe(true);
      for (const total of scenario.totalsByAction) {
        expect(accounted(total), `total ${total.action}`).toBe(
          total.heldBefore,
        );
        expect(total.blockedAfterTotal).toBe(
          total.heldBefore - total.eligibleAfter,
        );
      }
      for (const business of scenario.byBusiness) {
        for (const entry of business.byAction) {
          expect(
            accounted(entry),
            `${business.businessName} ${entry.action}`,
          ).toBe(entry.heldBefore);
        }
      }
    }
  });

  it("carries the exact per-action independent-gate counts", () => {
    for (const scenario of scenarios) {
      const by = Object.fromEntries(
        scenario.totalsByAction.map((entry) => [entry.action, entry]),
      );
      expect(by.scale.blockedByCampaignContext).toBe(8);
      expect(by.scale.blockedByRecentRecoveryUnverifiable).toBe(0);
      expect(by.cut.blockedByCampaignContext).toBe(86);
      expect(by.cut.blockedByRecentRecoveryUnverifiable).toBe(26);
      expect(by.refresh.blockedByCampaignContext).toBe(1);
      expect(by.refresh.blockedByRecentRecoveryUnverifiable).toBe(0);
      // And they sum to the accepted persisted partition.
      expect(
        scenario.totalsByAction.reduce(
          (sum, entry) => sum + entry.blockedByCampaignContext,
          0,
        ),
      ).toBe(95);
      expect(
        scenario.totalsByAction.reduce(
          (sum, entry) => sum + entry.blockedByRecentRecoveryUnverifiable,
          0,
        ),
      ).toBe(26);
    }
  });

  it("never recasts an independent-gate row as a commercial-anchor transition", () => {
    for (const scenario of scenarios) {
      for (const total of scenario.totalsByAction) {
        for (const key of Object.keys(total.codeTransitions)) {
          if (key.startsWith("campaign_context")) {
            expect(key).toBe("campaign_context->campaign_context");
          }
          if (key.startsWith("recent_recovery_unverifiable")) {
            expect(key).toBe(
              "recent_recovery_unverifiable->recent_recovery_unverifiable",
            );
          }
        }
      }
    }
  });

  it("the baseline reports the whole held population as blocked", () => {
    const baseline = scenarios[0];
    expect(baseline.eligibleAfterTotal).toBe(0);
    expect(baseline.blockedAfterTotal).toBe(1993);
    // The narrow code bucket is empty, and must never be read as the total.
    for (const total of baseline.totalsByAction) {
      expect(total.blockedByEffectiveProfileCodeTotal).toBe(0);
    }
  });
});
