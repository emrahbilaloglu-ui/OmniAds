// D074b closure guard (acceptance-corrected): manual Test/Main label
// vocabulary must not be EMITTED by active runtime, must never surface as a
// buyer-facing label request, and — since the acceptance rejection — legacy
// aliases must never RESOLVE into role authority. Legacy names survive only
// as parse-time recognition at documented compatibility boundaries, and every
// surviving occurrence is counted below per file per token: an extra
// occurrence anywhere (a new emission, a new branch) fails this guard even
// inside a boundary file. Update the ledger only for a deliberate,
// reviewed boundary change.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalCampaignRoleStatus,
  hasResolvedCampaignRole,
  isCampaignRoleUnresolved,
  resolveCampaignRoleStatus,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { resolveRequireResolvedCampaignRole } from "@/lib/meta/automation-control-plane";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "archive" ||
      entry === "__tests__"
    )
      continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(full);
  }
  return out;
}

// scripts/ is part of the scanned surface (acceptance correction): active
// harnesses must not reintroduce the vocabulary either. Frozen/offline
// comparator artifacts are excluded only through categorized ledger entries.
const ACTIVE_FILES = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "lib")),
  ...walk(join(ROOT, "scripts")),
];

const LEGACY_TOKENS = [
  "campaignLabelStatus",
  "label_status",
  "unlabeled_campaign_context",
  "unlabeled_campaign_soft_only",
  "missing_campaign_label",
  "waiting_on_labels",
  "campaign_label_status_drift",
  "campaign_label_missing",
  "requireCampaignLabel",
] as const;
type LegacyToken = (typeof LEGACY_TOKENS)[number];

function countToken(content: string, token: LegacyToken): number {
  const raw = content.split(token).length - 1;
  if (token === "label_status") {
    // "label_status" also occurs inside "campaign_label_status_drift";
    // that longer token is counted on its own line of the ledger.
    return raw - (content.split("campaign_label_status_drift").length - 1);
  }
  return raw;
}

/**
 * Exact-count ledger. Every legacy-token occurrence in the active tree must
 * be accounted for here, per file per token, with the category that makes it
 * legitimate:
 *  - compat-boundary: documented parse/recognition arm folding legacy names
 *    into canonical vocabulary (never granting authority).
 *  - parse-only-type: deprecated union member / optional field kept so older
 *    persisted payloads deserialize; never emitted by writers.
 *  - frozen-offline: SELECT-only historical comparator or replay harness
 *    (D033/H11 lineage); not part of serving runtime.
 *  - parse-fixture: test-harness fixture exercising a legacy parse arm.
 * A count that drifts in EITHER direction fails: up means a reintroduction,
 * down means the ledger is stale and must be trimmed with the change.
 */
const LEGACY_TOKEN_LEDGER: ReadonlyArray<{
  file: string;
  category:
    "compat-boundary" | "parse-only-type" | "frozen-offline" | "parse-fixture";
  why: string;
  tokens: Partial<Record<LegacyToken, number>>;
}> = [
  {
    file: "app/api/creatives/briefing/card-serialization.ts",
    category: "compat-boundary",
    why: "legacy badge fold into the canonical badge label",
    tokens: { unlabeled_campaign_context: 1 },
  },
  {
    file: "app/api/creatives/briefing/route.ts",
    category: "compat-boundary",
    why: "legacy sub-bucket recognition in counts",
    tokens: { waiting_on_labels: 1 },
  },
  {
    file: "app/api/meta/lane-classify/route.ts",
    category: "compat-boundary",
    why: "legacy signal-key recognition returning canonical lane",
    tokens: {
      label_status: 1,
      missing_campaign_label: 1,
      unlabeled_campaign_soft_only: 1,
    },
  },
  {
    file: "components/creatives/briefing/CreativesBriefingPage.tsx",
    category: "compat-boundary",
    why: "legacy sub-bucket ordering recognition",
    tokens: { waiting_on_labels: 2 },
  },
  {
    file: "components/creatives/briefing/card-utils.tsx",
    category: "compat-boundary",
    why: "fail-closed render fold + gated row helper + legacy badge recognition",
    tokens: { campaignLabelStatus: 5, unlabeled_campaign_context: 1 },
  },
  {
    file: "components/creatives/briefing/types.ts",
    category: "parse-only-type",
    why: "deprecated optional card field + sub-bucket member",
    tokens: { campaignLabelStatus: 1, waiting_on_labels: 1 },
  },
  {
    file: "components/meta/decision-center/meta-decision-center-exact-adapter.ts",
    category: "compat-boundary",
    why: "legacy readiness and creative blocker codes mapped to fail-closed buyer copy",
    tokens: {
      missing_campaign_label: 3,
      campaign_label_missing: 1,
      unlabeled_campaign_context: 1,
      unlabeled_campaign_soft_only: 1,
    },
  },
  {
    file: "lib/creative-decision-center/observability.ts",
    category: "compat-boundary",
    why: "legacy reason-tag recognition into the canonical bucket",
    tokens: { campaign_label_missing: 2 },
  },
  {
    file: "lib/creative-decision-center/v3-bridge.ts",
    category: "compat-boundary",
    why: "isolated fail-closed status fold + legacy badge recognition",
    tokens: { campaignLabelStatus: 1, unlabeled_campaign_context: 2 },
  },
  {
    file: "lib/creative-decision-engine/campaign-label-guard.ts",
    category: "compat-boundary",
    why: "the documented fail-closed alias fold + explicit-stamp checks",
    tokens: { campaignLabelStatus: 8, unlabeled_campaign_context: 2 },
  },
  {
    file: "lib/creative-decision-engine/execution-safety.ts",
    category: "parse-only-type",
    why: "deprecated drift-code union member",
    tokens: { campaign_label_status_drift: 1 },
  },
  {
    file: "lib/creative-decision-engine/types.ts",
    category: "parse-only-type",
    why: "deprecated optional field + badge union member",
    tokens: { campaignLabelStatus: 1, unlabeled_campaign_context: 2 },
  },
  {
    file: "lib/meta/automation-control-plane.ts",
    category: "compat-boundary",
    why: "parses the pre-D074b guardrail key; writers emit canonical",
    tokens: { requireCampaignLabel: 2 },
  },
  {
    file: "lib/meta/automation-readiness.ts",
    category: "compat-boundary",
    why: "legacy signal recognition folded into canonical blockers",
    tokens: {
      label_status: 1,
      missing_campaign_label: 3,
      unlabeled_campaign_soft_only: 1,
    },
  },
  {
    file: "lib/meta/campaign-label-guard.ts",
    category: "compat-boundary",
    why: "deprecated guard-reason constant kept for parse recognition",
    tokens: { unlabeled_campaign_soft_only: 1 },
  },
  {
    file: "lib/meta/decision-semantics.ts",
    category: "compat-boundary",
    why: "legacy resolution-code recognition arm",
    tokens: { campaign_label_missing: 1, unlabeled_campaign_context: 1 },
  },
  {
    file: "lib/meta/decisions-workspace-read-model.ts",
    category: "compat-boundary",
    why: "legacy copy-map key recognition",
    tokens: { campaign_label_missing: 1 },
  },
  {
    file: "lib/meta/engine-v1/state-rows.ts",
    category: "parse-only-type",
    why: "deprecated state union member",
    tokens: { unlabeled_campaign_context: 1 },
  },
  {
    file: "scripts/_phase5-extract-live.ts",
    category: "frozen-offline",
    why: "phase-5 extraction harness; historical, not runtime",
    tokens: { campaignLabelStatus: 1, label_status: 2 },
  },
  {
    file: "scripts/audits/d078-hard-action-recompute.ts",
    category: "frozen-offline",
    why:
      "D078 audit recompute reads persisted 07-18-engine decision outputs; " +
      "the key presence check documents legacy-only provenance, never emits",
    tokens: { campaignLabelStatus: 1 },
  },
  {
    file: "scripts/creative-decision-center/automatic-campaign-context-shadow.ts",
    category: "frozen-offline",
    why: "D033 shadow/eval harness; SELECT-only comparator",
    tokens: { unlabeled_campaign_context: 1 },
  },
  {
    file: "scripts/creative-decision-center/current-engine-historical-replay.ts",
    category: "frozen-offline",
    why: "historical replay comparator",
    tokens: { campaignLabelStatus: 4 },
  },
  {
    file: "scripts/creative-decision-center/phase0-current-engine-simulation.ts",
    category: "frozen-offline",
    why: "phase-0 simulation comparator",
    tokens: { campaignLabelStatus: 12, unlabeled_campaign_context: 1 },
  },
  {
    file: "scripts/creative-decision-center/phase1-outcome-baseline-checkpoint.ts",
    category: "frozen-offline",
    why: "phase-1 baseline checkpoint comparator",
    tokens: { unlabeled_campaign_context: 1 },
  },
  {
    file: "scripts/zero-base/fixtures/automation-control-plane.ts",
    category: "parse-fixture",
    why: "harness fixture exercising the legacy guardrail-key parse arm",
    tokens: { requireCampaignLabel: 1 },
  },
];
const LEDGER_BY_FILE = new Map(
  LEGACY_TOKEN_LEDGER.map((entry) => [entry.file, entry]),
);

describe("D074b vocabulary closure", () => {
  it("every legacy-token occurrence matches the per-file per-token ledger exactly", () => {
    const mismatches: string[] = [];
    const seenFiles = new Set<string>();
    for (const file of ACTIVE_FILES) {
      const rel = relative(ROOT, file);
      const content = readFileSync(file, "utf8");
      const ledger = LEDGER_BY_FILE.get(rel);
      if (ledger) seenFiles.add(rel);
      for (const token of LEGACY_TOKENS) {
        const actual = countToken(content, token);
        const allowed = ledger?.tokens[token] ?? 0;
        if (actual !== allowed) {
          mismatches.push(
            `${rel}: ${token} expected ${allowed}, found ${actual}`,
          );
        }
      }
    }
    for (const entry of LEGACY_TOKEN_LEDGER) {
      if (!seenFiles.has(entry.file)) {
        mismatches.push(`${entry.file}: ledger entry has no matching file`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("no buyer-facing copy asks for, saves, or corrects a campaign label/role anywhere", () => {
    // Broadened after the acceptance rejection: the original regex missed
    // "save an explicit correction only when the provisional role is wrong"
    // and "(campaign label missing; execution move blocked)".
    const labelRequestCopy =
      /[Ll]abel (the )?campaign\b|campaign (role )?label is required|[Aa]dd a label|[Ss]upply a label|[Aa]ssign a label|[Ss]ave an explicit correction|provisional role is wrong|campaign label missing|[Cc]orrect the (campaign )?role|[Ss]ave a (campaign )?(role|label)/;
    const offenders = ACTIVE_FILES.filter((file) =>
      labelRequestCopy.test(readFileSync(file, "utf8")),
    ).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("active writers never EMIT the legacy names (assignment/push positions)", () => {
    // Emission shapes: object-literal assignment of a legacy field or key,
    // pushing the legacy blocker, or returning the legacy segment/bucket.
    // No file is exempt from this scan; the parse fixture is the single
    // documented carrier of a legacy guardrail-key literal.
    const emission =
      /campaignLabelStatus:\s*"(labeled|unlabeled|no_campaign)"|label_status:\s*"|blockers\.push\("missing_campaign_label"\)|blockers\.push\("campaign_label_missing"\)|reasonTags:\s*\["campaign_label_missing"\]|return "unlabeled";|return "waiting_on_labels"|watchingSubBucket:\s*"waiting_on_labels"|type:\s*"unlabeled_campaign_context"|requireCampaignLabel:\s*(true|false)/;
    const emissionFixtureException =
      "scripts/zero-base/fixtures/automation-control-plane.ts";
    const offenders = ACTIVE_FILES.filter((file) => {
      const rel = relative(ROOT, file);
      if (rel === emissionFixtureException) return false;
      return emission.test(readFileSync(file, "utf8"));
    }).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("legacy aliases deserialize but can NEVER become resolved authority", () => {
    // Acceptance correction: pre-correction, canonicalCampaignRoleStatus
    // mapped legacy "labeled" to "resolved" — a manual-era label granting
    // automatic-role authority. The fold is now fail-closed.
    expect(canonicalCampaignRoleStatus("labeled")).toBe("unresolved");
    expect(canonicalCampaignRoleStatus("unlabeled")).toBe("unresolved");
    expect(canonicalCampaignRoleStatus("no_campaign")).toBe("no_campaign");
    expect(canonicalCampaignRoleStatus(undefined)).toBeNull();

    // Legacy-only "labeled" parses but grants nothing.
    const legacyOnlyLabeled = {
      campaignRoleStatus: undefined,
      campaignLabelStatus: "labeled" as const,
    };
    expect(resolveCampaignRoleStatus(legacyOnlyLabeled)).toBe("unresolved");
    expect(hasResolvedCampaignRole(legacyOnlyLabeled)).toBe(false);
    expect(isCampaignRoleUnresolved(legacyOnlyLabeled)).toBe(true);
  });

  it("missing status fails closed as unresolved", () => {
    // Pre-correction pin was the opposite (missing-both => not unresolved).
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: undefined,
        campaignLabelStatus: undefined,
      }),
    ).toBe("unresolved");
    expect(
      isCampaignRoleUnresolved({
        campaignRoleStatus: undefined,
        campaignLabelStatus: undefined,
      }),
    ).toBe(true);
    expect(resolveCampaignRoleStatus(null)).toBe("unresolved");
    expect(isCampaignRoleUnresolved(undefined)).toBe(true);
  });

  it("contradictory canonical/legacy statuses fail closed instead of preferring the authority-granting side", () => {
    // Pre-correction, canonical won unconditionally — so a resolved stamp
    // beside a conflicting legacy alias still granted authority.
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: "resolved",
        campaignLabelStatus: "unlabeled",
      }),
    ).toBe("unresolved");
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: "resolved",
        campaignLabelStatus: "no_campaign",
      }),
    ).toBe("unresolved");
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: "no_campaign",
        campaignLabelStatus: "labeled",
      }),
    ).toBe("unresolved");
    // Same-claim pairs are agreement, not contradiction.
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: "resolved",
        campaignLabelStatus: "labeled",
      }),
    ).toBe("resolved");
    expect(
      resolveCampaignRoleStatus({
        campaignRoleStatus: "no_campaign",
        campaignLabelStatus: "no_campaign",
      }),
    ).toBe("no_campaign");
  });

  it("only canonical uncontradicted resolved status grants role authority", () => {
    expect(
      hasResolvedCampaignRole({
        campaignRoleStatus: "resolved",
        campaignLabelStatus: undefined,
      }),
    ).toBe(true);
    expect(
      hasResolvedCampaignRole({
        campaignRoleStatus: "resolved",
        campaignLabelStatus: "unlabeled",
      }),
    ).toBe(false);
    expect(
      hasResolvedCampaignRole({
        campaignRoleStatus: undefined,
        campaignLabelStatus: "labeled",
      }),
    ).toBe(false);
    expect(
      hasResolvedCampaignRole({
        campaignRoleStatus: undefined,
        campaignLabelStatus: undefined,
      }),
    ).toBe(false);
  });

  it("the legacy guardrail alias can only tighten requireResolvedCampaignRole, never relax it", () => {
    // Pre-correction a persisted legacy `false` disabled the resolved-role
    // requirement outright.
    expect(
      resolveRequireResolvedCampaignRole({ requireCampaignLabel: false }),
    ).toBe(true);
    expect(
      resolveRequireResolvedCampaignRole({ requireCampaignLabel: true }),
    ).toBe(true);
    expect(resolveRequireResolvedCampaignRole({})).toBe(true);
    // Only the canonical key may relax the guardrail.
    expect(
      resolveRequireResolvedCampaignRole({
        requireResolvedCampaignRole: false,
      }),
    ).toBe(false);
    expect(
      resolveRequireResolvedCampaignRole({
        requireResolvedCampaignRole: true,
        requireCampaignLabel: false,
      }),
    ).toBe(true);
  });

  it("the v3-bridge mirror of the fold stays byte-identical in its decision table", () => {
    // The module-isolation contract forbids the bridge from value-importing
    // the guard, so it carries a local mirror. Pin the same-claim table so
    // the two folds cannot drift silently.
    const bridge = readFileSync(
      join(ROOT, "lib/creative-decision-center/v3-bridge.ts"),
      "utf8",
    );
    for (const line of [
      '(canonical === "resolved" && legacy === "labeled")',
      '(canonical === "unresolved" && legacy === "unlabeled")',
      '(canonical === "no_campaign" && legacy === "no_campaign")',
      'return sameClaim ? canonical : "unresolved";',
      'if (legacy === "no_campaign") return "no_campaign";',
      'return "unresolved";',
    ]) {
      expect(bridge).toContain(line);
    }
  });

  it("a Decision Center row's execution action stays gated behind resolved role AND current-decision agreement (D074b corrections 2+3)", () => {
    // Server precedence gate: the row-derived primary requires the current
    // unblocked Scale decision, resolved status, kind agreement, AND exact
    // agreement with the decision-derived primary. These byte pins fail if
    // any leg of the gate is weakened.
    const serialization = readFileSync(
      join(ROOT, "app/api/creatives/briefing/card-serialization.ts"),
      "utf8",
    );
    expect(serialization).toContain(
      "primaryActionForDecisionCenterRow(decisionCenterRow, decision)",
    );
    for (const line of [
      'if (decision.label !== "scale") return null;',
      "if (decision.blockedActionType != null) return null;",
      "if (decision.authorityBlocker != null) return null;",
      'if (resolveCampaignRoleStatus(decision) !== "resolved") return null;',
      "const current = primaryActionForDecision(decision);",
      "return current.kind === rowMapped.kind ? rowMapped : null;",
    ]) {
      expect(serialization).toContain(line);
    }

    // Client gate: ActionNowCard must consume the gated helper, never the
    // raw row field.
    const actionNowCard = readFileSync(
      join(ROOT, "components/creatives/briefing/ActionNowCard.tsx"),
      "utf8",
    );
    expect(actionNowCard).toContain("cardCurrentRowScaleAction(card)");
    expect(actionNowCard).not.toMatch(/decisionCenterRow\??\.executionAction/);

    const cardUtils = readFileSync(
      join(ROOT, "components/creatives/briefing/card-utils.tsx"),
      "utf8",
    );
    for (const line of [
      "if (card.blockedActionType != null) return null;",
      "if (card.authorityBlocker != null) return null;",
      'if (cardCampaignRoleStatus(card) !== "resolved") return null;',
      '(action === "promote_to_main" && card.campaignKind === "test") ||',
      '(action === "scale_budget" && card.campaignKind === "main") ||',
      '(action === "controlled_scale" && card.campaignKind === "mixed");',
      "if (card.primary?.kind !== ROW_ACTION_TO_PRIMARY_KIND[action]) return null;",
    ]) {
      expect(cardUtils).toContain(line);
    }

    // Consumer census: every active `.executionAction` read on the briefing
    // surface must be one of the documented sites — the two gates above, the
    // evidence drawer's provenance block, and canonical-projection writing
    // the field from the canonical decision contract (a fresh-by-construction
    // producer, not a stale-row consumer). A new read site fails here until
    // it is gated and added deliberately.
    const EXECUTION_ACTION_READ_BUDGET: Record<string, number> = {
      "app/api/creatives/briefing/card-serialization.ts": 3,
      "app/api/creatives/briefing/canonical-projection.ts": 2,
      "components/creatives/briefing/card-utils.tsx": 1,
      "components/creatives/briefing/CreativeEvidenceDrawer.tsx": 1,
    };
    const briefingFiles = ACTIVE_FILES.filter((file) => {
      const rel = relative(ROOT, file);
      return (
        rel.startsWith("components/creatives/briefing/") ||
        rel.startsWith("app/api/creatives/briefing/")
      );
    });
    const mismatches: string[] = [];
    for (const file of briefingFiles) {
      const rel = relative(ROOT, file);
      const count = (
        readFileSync(file, "utf8").match(/\.executionAction/g) ?? []
      ).length;
      const allowed = EXECUTION_ACTION_READ_BUDGET[rel] ?? 0;
      if (count !== allowed) {
        mismatches.push(
          `${rel}: .executionAction expected ${allowed}, found ${count}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("raw compatibility-row decision fields cannot silently drive a visible current surface (D074b correction 4)", () => {
    // Bypass C/D census: every read of a Decision Center row's decision/
    // projection fields on the briefing surface is counted per file. The
    // counts include canonical-channel reads and comments; the point is
    // that ANY new occurrence fails here and forces a deliberate
    // classification (current-authority gate vs provenance block).
    const RAW_ROW_FIELD_BUDGET: Record<
      string,
      Partial<Record<string, number>>
    > = {
      "components/creatives/briefing/ActionNowCard.tsx": { buyerLabel: 3 },
      "components/creatives/briefing/CreativeEvidenceDrawer.tsx": {
        buyerAction: 2,
        buyerLabel: 2,
        nextStep: 1,
        queueEligible: 1,
        applyEligible: 1,
      },
      "components/creatives/briefing/CreativesBriefingPage.tsx": {
        buyerAction: 3,
      },
      "components/creatives/briefing/action-authority.ts": {
        buyerAction: 1,
        buyerLabel: 4,
      },
      "components/creatives/briefing/card-utils.tsx": { buyerAction: 1 },
      "components/creatives/briefing/types.ts": {
        buyerAction: 4,
        buyerLabel: 1,
      },
      "app/api/creatives/briefing/canonical-projection.ts": {
        buyerAction: 17,
        buyerLabel: 5,
        nextStep: 2,
        oneLine: 1,
        queueEligible: 1,
        applyEligible: 1,
      },
      "app/api/creatives/briefing/card-serialization.ts": { buyerAction: 1 },
    };
    const FIELDS = [
      "buyerAction",
      "buyerLabel",
      "nextStep",
      "oneLine",
      "queueEligible",
      "applyEligible",
    ];
    const surfaceFiles = ACTIVE_FILES.filter((file) => {
      const rel = relative(ROOT, file);
      return (
        rel.startsWith("components/creatives/briefing/") ||
        rel.startsWith("app/api/creatives/briefing/")
      );
    });
    const mismatches: string[] = [];
    for (const file of surfaceFiles) {
      const rel = relative(ROOT, file);
      const content = readFileSync(file, "utf8");
      for (const field of FIELDS) {
        const count = (content.match(new RegExp(`\\b${field}\\b`, "g")) ?? [])
          .length;
        const allowed = RAW_ROW_FIELD_BUDGET[rel]?.[field] ?? 0;
        if (count !== allowed) {
          mismatches.push(
            `${rel}: ${field} expected ${allowed}, found ${count}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);

    // Asset Library must derive its Label cell, filter, and CSV from the
    // current server projection only — byte pins on the corrected helpers.
    const assetLibrary = readFileSync(
      join(ROOT, "components/creatives/briefing/AssetLibrarySection.tsx"),
      "utf8",
    );
    for (const line of [
      "const current = rowEngineLabel(row);",
      'return { label: "Review", source: "current_unavailable" };',
      "  return rowEngineLabel(row);",
    ]) {
      expect(assetLibrary).toContain(line);
    }
    expect(assetLibrary).not.toMatch(
      /decisionCenterRow\.(buyerAction|buyerLabel|executionAction|nextStep)/,
    );

    // Evidence Drawer: the raw row renders only under the explicit
    // non-authoritative disclosure; composed guidance never renders.
    const drawer = readFileSync(
      join(ROOT, "components/creatives/briefing/CreativeEvidenceDrawer.tsx"),
      "utf8",
    );
    expect(drawer).toContain("Compatibility snapshot (provenance)");
    expect(drawer).toContain(
      "Not the current decision — this stored Decision Center",
    );
    expect(drawer).toContain("snapshot cannot execute any action.");
    expect(drawer).not.toMatch(/\{decisionCenterRow\.buyerLabel\}/);
    expect(drawer).not.toMatch(/\{decisionCenterRow\.nextStep\}/);
    expect(drawer).not.toMatch(/\{decisionCenterRow\.oneLine\}/);
  });

  it("frozen comparator tables stay isolated from runtime (D074 guard still binding)", () => {
    // The original isolation guard covers table-level reads; this pins the
    // relationship so the closure cannot be read as loosening it.
    const guard = readFileSync(
      join(ROOT, "lib/meta/__tests__/campaign-labels-isolation.test.ts"),
      "utf8",
    );
    expect(guard).toContain("meta_campaign_labels");
  });
});
