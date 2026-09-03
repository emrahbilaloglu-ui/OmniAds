// @vitest-environment jsdom

/**
 * D085 — the dry-run panel renders and computes nothing.
 *
 * Two properties matter most: the four layers stay visibly distinct (a reader
 * must never mistake a simulated receipt for a real one), and no control is
 * ever enabled.
 */

import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetDryRunPanel } from "./BudgetDryRunPanel";
import {
  META_BUDGET_DRY_RUN_PANEL_CONTRACT,
  projectBudgetDryRunPanel,
  unavailableDryRunPanel,
} from "@/lib/meta/budget-dry-run-panel";
import {
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  PROVIDER_CAPABILITY_TODAY,
  buildBudgetProposalDryRun,
  assembleWouldWritePreview,
  clearSafetyFlag,
  unknownSafetyFlag,
  type DryRunInput,
} from "@/lib/meta/budget-proposal-dry-run";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import { ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";
import { readbackFingerprint, type PreflightProjection } from "@/lib/meta/provider-readback-contract";
import { validateBudgetIntent } from "@/lib/meta/budget-intent-contract";
import type { BudgetProposalDryRun } from "@/lib/meta/budget-proposal-dry-run";

afterEach(cleanup);

function accountScopedInput(): DryRunInput {
  const writeSafety: DryRunInput["writeSafety"] = {};
  for (const s of WRITE_SAFETY_STEPS) writeSafety[s] = "missing";
  writeSafety.exact_business_access = "satisfied";
  return {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: { id: null, hash: null, version: null, decidedAt: null, maxAgeSeconds: 86_400 },
    scope: {
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", business: "IwaStore",
      providerAccountId: "act_1087566732415606", entityGrain: null, entityId: null,
      parentCampaignId: null, accountIsWriteScope: true,
      accountSelectionWhy: "selected serving account",
    },
    direction: null, percent: null, accountCurrency: null, currencyExponent: null,
    currencyRegistryVersion: null, unitConfidence: "unknown",
    role: { role: null, source: null, resolverVersion: null, confidence: null, asOf: null, accountScoped: true, businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", resolved: false, why: "no qualifying rows" },
    budgetFact: {
      contractVersion: "meta.budget-fact.v4", available: false, currentMinorUnits: null,
      budgetField: null, ownerMode: "unknown", scheduleStart: null, scheduleEnd: null,
      observedAt: null, capturedAt: null, lineage: "canonical contract defined", availabilityWhy: "no concrete entity",
    },
    commercial: {
      profileContractVersion: "adsecute.account-decision-profile.v1",
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606",
      sourceStatus: "output_not_retained", selectedAction: null, eligible: null,
      code: null, reason: null, blockerCodes: [], evidenceFloorsClear: null, changeSafetyClear: null,
    },
    safety: {
      killSwitch: unknownSafetyFlag("not read in this fixture"),
      admission: unknownSafetyFlag("not read in this fixture"),
      cap: unknownSafetyFlag("no history read"),
      cooldown: unknownSafetyFlag("no history read"),
      conflict: unknownSafetyFlag("no lock read"),
    },
    capability: PROVIDER_CAPABILITY_TODAY,
    rawIntent: null,
    knownBindings: [{ businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606" }],
    intent: null, intentRejections: ["current_value_missing"], casBaseline: null, preflight: null, preflightEvidence: null,
    writeSafety, originDate: "2026-09-01", knowledgeAsOf: "2026-09-01T00:00:00.000Z",
  };
}

const realPanel = () =>
  projectBudgetDryRunPanel({
    dryRun: buildBudgetProposalDryRun(accountScopedInput()),
    observedFacts: [{ label: "Automation", value: "off" }],
    writeSafetyMissing: WRITE_SAFETY_STEPS.filter((s) => s !== "exact_business_access"),
  });

const root = () => document.querySelector('[data-el="budget-dry-run"]');

describe("D085 — the panel renders the server result verbatim", () => {
  it("renders nothing when the server sent nothing", () => {
    render(<BudgetDryRunPanel panel={null} />);
    expect(root()).toBeNull();
  });

  it("keeps observed, proposed, simulated and required visibly distinct", () => {
    render(<BudgetDryRunPanel panel={realPanel()} />);
    for (const el of [
      "dry-run-observed-title", "dry-run-proposed-title",
      "dry-run-simulated-title", "dry-run-required-title",
    ]) {
      expect(root()?.querySelector(`[data-el="${el}"]`), el).not.toBeNull();
    }
    // A blocked run offers no request and no receipt, and says so.
    expect(root()?.querySelector('[data-el="dry-run-proposed-note"]')?.getAttribute("data-available")).toBe("false");
    expect(root()?.querySelector('[data-el="dry-run-simulated-note"]')?.getAttribute("data-available")).toBe("false");
    expect(root()?.querySelector('[data-el="dry-run-proposed"]')).toBeNull();
    expect(root()?.querySelector('[data-el="dry-run-simulated"]')).toBeNull();
  });

  it("shows every blocker with its own reason", () => {
    const panel = realPanel();
    render(<BudgetDryRunPanel panel={panel} />);
    const nodes = Array.from(root()?.querySelectorAll('[data-el="dry-run-blocker"]') ?? []);
    expect(nodes.length).toBe(panel.required.blockers.length);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.getAttribute("data-code")).toBeTruthy();
      expect((n.textContent ?? "").length).toBeGreaterThan(20);
    }
    // The structural blocker must be visible, not summarised away.
    expect(root()?.textContent).toContain("no_provider_write_path_exists");
  });

  it("states the execution posture explicitly and never enables a control", () => {
    render(<BudgetDryRunPanel panel={realPanel()} />);
    const exec = root()?.querySelector('[data-el="dry-run-execution"]');
    expect(exec?.getAttribute("data-execution-state")).toBe("validated_only");
    expect(exec?.getAttribute("data-executable")).toBe("false");
    expect(exec?.getAttribute("data-provider-write-attempted")).toBe("false");
    expect(exec?.getAttribute("data-provider-outcome")).toBe("not_attempted");
    expect(exec?.getAttribute("data-readback")).toBe("not_attempted");
    const cta = root()?.querySelector('[data-el="dry-run-cta"]') as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    expect(cta!.disabled).toBe(true);
    expect(cta!.textContent).toBe("Dry run only");
    // Every control in the subtree is disabled.
    for (const b of Array.from(root()?.querySelectorAll("button") ?? [])) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("says the next requirement exactly, never generic copy", () => {
    render(<BudgetDryRunPanel panel={realPanel()} />);
    const next = root()?.querySelector('[data-el="dry-run-next-requirement"]')?.textContent ?? "";
    expect(next.length).toBeGreaterThan(30);
    expect(next).not.toMatch(/something went wrong|unavailable right now|try again/i);
  });

  it("never presents the preview as a durable receipt or a success", () => {
    const text = (() => { render(<BudgetDryRunPanel panel={realPanel()} />); return root()?.textContent ?? ""; })();
    expect(text).not.toMatch(/\bapplied\b/i);
    expect(text).not.toMatch(/\bsucceeded\b/i);
    expect(text).not.toMatch(/change (was )?saved/i);
    expect(text).toContain("not_attempted");
  });

  it("renders an unavailable projection with its exact reason", () => {
    render(<BudgetDryRunPanel panel={unavailableDryRunPanel("dry_run_contract_unsupported")} />);
    const node = root()?.querySelector('[data-el="dry-run-unavailable"]');
    expect(node?.getAttribute("data-reason")).toBe("dry_run_contract_unsupported");
    expect(node?.textContent).toContain("dry_run_contract_unsupported");
    // Distinct from the other unavailable cause.
    cleanup();
    render(<BudgetDryRunPanel panel={unavailableDryRunPanel("no_dry_run_produced")} />);
    expect(root()?.querySelector('[data-el="dry-run-unavailable"]')?.getAttribute("data-reason"))
      .toBe("no_dry_run_produced");
  });

  it("declares its contract version on the rendered root", () => {
    render(<BudgetDryRunPanel panel={realPanel()} />);
    expect(root()?.getAttribute("data-contract")).toBe(META_BUDGET_DRY_RUN_PANEL_CONTRACT);
  });
});

describe("D085 — the component computes nothing", () => {
  const source = readFileSync(resolve("components/meta/decision-center/BudgetDryRunPanel.tsx"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("does no arithmetic and derives no decision", () => {
    for (const forbidden of [
      /Math\./, /\breduce\(/, /parseFloat/, /\bNumber\(/, /[)\w]\s[-+*/]\s[(\w]/,
      /eligible/, /buyerAction/, /threshold/, /brief_variation/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("issues no request and holds no mutation handler", () => {
    for (const forbidden of [/\bfetch\s*\(/, /onClick/, /"POST"/, /useMutation/, /router\.push/]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("hardcodes no blocker, endpoint or provider host", () => {
    expect(code).not.toMatch(/graph\.facebook\.com/);
    expect(code).not.toMatch(/no_provider_write_path_exists/);
    expect(code).not.toMatch(/daily_budget/);
  });
});

describe("D085 — desktop and mobile mount the same server object", () => {
  it("is mounted on both surfaces from viewModel.budgetDryRun", () => {
    const desktop = readFileSync(resolve("components/meta/decision-center/MetaDecisionCenterExact.tsx"), "utf8");
    const page = readFileSync(resolve("components/meta/redesign/MetaPlatformPage.tsx"), "utf8");
    const expression = "panel={viewModel.budgetDryRun ?? null}";
    expect(desktop).toContain(expression);
    // The mobile mount must be inside the mobile stage subtree.
    const start = page.indexOf("function MetaMobileDecisionsScreen(");
    const end = page.indexOf("\nfunction ", start + 10);
    const mobile = page.slice(start, end === -1 ? page.length : end);
    expect(mobile).toContain("<BudgetDryRunPanel");
    expect(mobile).toContain(expression);
    expect(mobile).toContain("meta-mobile-decision-stage");
  });
});

describe("D085 C1 — all four layers render from a real synthetic preview", () => {
  /**
   * The production dry run can never reach the preview branch, so without an
   * explicitly synthetic capability the proposed and simulated layers would
   * never be rendered by any test. Production still passes
   * `PROVIDER_CAPABILITY_TODAY`, so the real zero result is untouched.
   */
  const PREVIEW_BASELINE: PreflightProjection = {
    providerAccountId: "act_1087566732415606", entityGrain: "adset", entityId: "23851234567890123",
    parentCampaignId: "23859876543210987", budgetField: "daily_budget", budgetMinorUnits: 10_000,
    ownerMode: "adset_budget", effectiveStatus: "ACTIVE", scheduleStart: null, scheduleEnd: null,
    optimizationGoal: "OFFSITE_CONVERSIONS",
  };
  const SYNTHETIC = {
    budgetEndpointExists: true, dispatchVerbExists: true,
    supportedFields: ["daily_budget"] as const,
    source: "SYNTHETIC TEST CAPABILITY — no such endpoint exists in this codebase",
    why: "synthetic capability used only to exercise preview rendering",
  };

  function readyInput(): DryRunInput {
    const writeSafety: DryRunInput["writeSafety"] = {};
    for (const s of WRITE_SAFETY_STEPS) writeSafety[s] = "satisfied";
    return {
      ...accountScopedInput(),
      decision: { id: "dec_1", hash: "d".repeat(64), version: "v1", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 86_400 },
      scope: {
        ...accountScopedInput().scope,
        entityGrain: "adset", entityId: "23851234567890123", parentCampaignId: "23859876543210987",
      },
      direction: "increase", percent: 10, accountCurrency: "USD", currencyExponent: 2,
      currencyRegistryVersion: ISO_4217_REGISTRY_VERSION, unitConfidence: "exact",
      role: {
        // Canonical automatic role authority, per the D081 rule.
        role: "main", source: "system_inferred", resolverVersion: "role-resolver-2026-08-01",
        confidence: "high", asOf: "2026-09-01", accountScoped: true,
        satisfiesRoleAuthority: true, authorityBlockers: [], producer: "automatic_inference",
        campaignId: "23859876543210987",
        businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606",
        resolved: true, why: "resolved",
      },
      budgetFact: {
        contractVersion: "meta.budget-fact.v4", available: true, currentMinorUnits: 10_000,
        budgetField: "daily_budget", ownerMode: "adset_budget", scheduleStart: null, scheduleEnd: null,
        observedAt: "2026-09-01", capturedAt: "2026-09-01T00:00:00.000Z", lineage: "canonical", availabilityWhy: "available",
      },
      commercial: {
        profileContractVersion: "adsecute.account-decision-profile.v1",
        businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", sourceStatus: "resolved",
        selectedAction: "scale", eligible: true, code: null, reason: null, blockerCodes: [],
        evidenceFloorsClear: true, changeSafetyClear: true,
      },
      safety: {
        killSwitch: clearSafetyFlag("test", "2026-09-01", "disengaged"),
        admission: clearSafetyFlag("test", "2026-09-01", "allowed"),
        cap: clearSafetyFlag("test", "2026-09-01", "under cap"),
        cooldown: clearSafetyFlag("test", "2026-09-01", "none"),
        conflict: clearSafetyFlag("test", "2026-09-01", "none"),
      },
      capability: SYNTHETIC,
      // The RAW input the canonical validator re-derives from.
      rawIntent: {
        contractVersion: "meta.budget-intent.v1",
        scope: { businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", entityGrain: "adset", entityId: "23851234567890123", parentCampaignId: "23859876543210987" },
        ownerMode: "adset_budget", budgetField: "daily_budget",
        observedDailyMinorUnits: 10_000, observedLifetimeMinorUnits: null, lifetimeSchedule: null,
        direction: "increase", percent: 10, accountCurrency: "USD",
        originDate: "2026-09-01", effectiveAsOf: "2026-09-01", knowledgeAsOf: "2026-09-01",
        authorityEvidenceAsOf: "2026-09-01", maxAuthorityEvidenceAgeDays: 60,
        sourceFingerprints: { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64) },
        evidenceWindow: { from: "2026-08-01", to: "2026-09-01" },
        targetSource: null, authorityStatus: "authorised", blockerCodes: [],
      },
      knownBindings: [{ businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606" }],
      intent: null,
      intentRejections: [],
      casBaseline: PREVIEW_BASELINE,
      preflightEvidence: {
        rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: PREVIEW_BASELINE },
        evaluatedAt: "2026-09-01T00:00:00.000Z",
        baselineFingerprint: readbackFingerprint(PREVIEW_BASELINE),
      },
      preflight: {
        contractVersion: "meta.provider-readback.v4", outcome: "succeeded", claimedStatus: "succeeded",
        rejections: [], ageSeconds: 0, fresh: true, projectionComplete: true,
        driftedFields: [], driftDetail: [], matchesBaseline: true,
        why: "a fresh (0s old), complete provider read reproduces the baseline on every projected field",
      },
      writeSafety,
    };
  }

  /*
    The dry run is ASSEMBLED, not built.

    The canonical D081 resolver gate requires an environment-approved resolver
    identity, and this environment approves none, so the builder cannot reach
    a preview for any input at all. The panel is a pure projection of a dry
    run, so the preview branch is exercised with a genuinely assembled request
    and receipt rather than by weakening the gate to manufacture one.
  */
  const previewRun = (): BudgetProposalDryRun => {
    const input = readyInput();
    const blocked = buildBudgetProposalDryRun(input);
    const validated = validateBudgetIntent(input.rawIntent!, input.knownBindings);
    if (validated.status !== "valid") throw new Error(`fixture intent invalid: ${validated.rejections.join(", ")}`);
    const assembled = assembleWouldWritePreview({
      // Correction 10: the boundary re-derives the canonical intent; the
      // validated view is passed only as an equality cross-check.
      scope: input.scope, rawIntent: input.rawIntent!, knownBindings: input.knownBindings,
      intent: validated.intent, budgetField: "daily_budget",
      casBaseline: input.casBaseline!, decisionId: input.decision!.id,
      writeSafety: input.writeSafety, capability: SYNTHETIC,
      inputFingerprint: blocked.inputFingerprint,
    });
    if ("refused" in assembled) throw new Error(`preview refused: ${assembled.why}`);
    return {
      contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
      status: "would_write_available",
      blockers: [], blockerDetail: [],
      wouldWriteRequest: assembled.request,
      receiptPreview: assembled.receipt,
      inputFingerprint: blocked.inputFingerprint,
      policyFingerprint: blocked.policyFingerprint,
      preflightFingerprint: blocked.preflightFingerprint!,
      executionState: "validated_only", executable: false, ctaEnabled: false,
      providerWriteAttempted: false, providerOutcome: "not_attempted",
      readbackClassification: "not_attempted",
    };
  };

  const previewPanel = () =>
    projectBudgetDryRunPanel({ dryRun: previewRun(), observedFacts: [{ label: "Automation", value: "off" }], writeSafetyMissing: [] });

  it("renders the proposed request layer with the exact values", () => {
    render(<BudgetDryRunPanel panel={previewPanel()} />);
    const note = root()?.querySelector('[data-el="dry-run-proposed-note"]');
    expect(note?.getAttribute("data-available")).toBe("true");
    const facts = root()?.querySelector('[data-el="dry-run-proposed"]');
    expect(facts).not.toBeNull();
    const text = facts?.textContent ?? "";
    expect(text).toContain("meta.graph.node_field_update");
    expect(text).toContain("daily_budget");
    expect(text).toContain("10000");
    expect(text).toContain("11000");
    expect(text).toContain("absolute_desired_state");
  });

  it("renders the simulated receipt layer and marks it non-durable", () => {
    render(<BudgetDryRunPanel panel={previewPanel()} />);
    expect(root()?.querySelector('[data-el="dry-run-simulated-note"]')?.getAttribute("data-available")).toBe("true");
    const text = root()?.querySelector('[data-el="dry-run-simulated"]')?.textContent ?? "";
    expect(text).toContain("d085-preview:");
    expect(text).toContain("false");            // isDurableReceipt
    expect(text).toContain("system_dry_run");
    expect(text).toContain("restore_prior_amount");
    expect(root()?.querySelector('[data-el="dry-run-simulated-note"]')?.textContent)
      .toMatch(/SIMULATED preview|not a durable receipt/i);
  });

  it("shows all four layers at once, with the CTA still disabled", () => {
    render(<BudgetDryRunPanel panel={previewPanel()} />);
    for (const el of ["observed", "proposed", "simulated", "required"]) {
      expect(root()?.querySelector(`[data-el="dry-run-${el}-title"]`), el).not.toBeNull();
    }
    const cta = root()?.querySelector('[data-el="dry-run-cta"]') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(cta.textContent).toBe("Dry run only");
    const exec = root()?.querySelector('[data-el="dry-run-execution"]');
    expect(exec?.getAttribute("data-executable")).toBe("false");
    expect(exec?.getAttribute("data-provider-outcome")).toBe("not_attempted");
    expect(exec?.getAttribute("data-readback")).toBe("not_attempted");
  });

  it("renders no token, header or URL even with a request present", () => {
    render(<BudgetDryRunPanel panel={previewPanel()} />);
    const text = root()?.textContent ?? "";
    for (const forbidden of [/https?:\/\//, /graph\.facebook\.com/i, /access_token/i, /Bearer /i]) {
      expect(text, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
