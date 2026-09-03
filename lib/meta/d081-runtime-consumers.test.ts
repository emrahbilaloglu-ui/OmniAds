import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";
import { validateBudgetIntent, type BudgetIntentInput } from "@/lib/meta/budget-intent-contract";
import { evaluateAccountScopedRoleAuthority } from "@/lib/meta/campaign-role-authority";
import {
  assertCanonicalDecisionAction,
  type MetaOsDecisionAction,
  type MetaOsLegacyDecisionAction,
} from "@/lib/meta/decisions-os-contract";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";

const HASH = "a".repeat(64);
const BINDINGS = [{ businessId: "biz-1", providerAccountId: "act_1" }];
const intentInput = (over: Partial<BudgetIntentInput> = {}): BudgetIntentInput => ({
  contractVersion: "meta.budget-intent.v1",
  scope: { businessId: "biz-1", providerAccountId: "act_1", entityGrain: "campaign", entityId: "c-1", parentCampaignId: null },
  ownerMode: "campaign_budget_optimization", budgetField: "daily_budget",
  observedDailyMinorUnits: 100_000, observedLifetimeMinorUnits: null, lifetimeSchedule: null,
  direction: "decrease", percent: 10, accountCurrency: "USD",
  originDate: "2026-08-01", effectiveAsOf: "2026-08-01", knowledgeAsOf: "2026-08-01",
  authorityEvidenceAsOf: "2026-07-28", maxAuthorityEvidenceAgeDays: 14,
  sourceFingerprints: { configStateHash: HASH, ownerStateHash: HASH, roleAuthorityHash: HASH },
  evidenceWindow: { from: "2026-07-25", to: "2026-07-31" },
  targetSource: { source: "business_target_pack_history", version: "2026-07-20" },
  authorityStatus: "not_determinable", blockerCodes: [],
  ...over,
});
const validIntent = (over: Partial<BudgetIntentInput> = {}) => {
  const r = validateBudgetIntent(intentInput(over), BINDINGS);
  if (r.status !== "valid") throw new Error("expected a valid intent");
  return r.intent;
};

/** The smallest read model the builder accepts, so the test drives the real one. */
function emptyReadModel() {
  return {
    source: { snapshotAsOf: null, engineVersion: null },
    queue: { sections: {} },
    structure: { entities: [] },
  };
}
const legacy = (over: Partial<MetaOsLegacyDecisionAction> = {}): MetaOsLegacyDecisionAction => ({
  code: "pause_ad", label: "Pause this ad", intent: "execute",
  targetLevel: "ad", providerMutation: "pause", scopeNote: "ad 1", ...over,
});

describe("D081 C3 — the REAL route-called builder serves the budget action", () => {
  /** The minimum a build needs; mirrors what the route passes. */
  const builderInput = (over: Record<string, unknown> = {}) => ({
    actionNow: [], watching: [], nonSales: [],
    decisionReadModel: emptyReadModel(),
    currency: "USD",
    generatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });

  it("is the function the route actually calls", () => {
    // Guards the premise: if the route stops calling this builder, the
    // integration this suite proves is no longer the production path.
    const route = readFileSync("app/api/meta/decisions-workspace/route.ts", "utf8");
    expect(route).toContain("buildMetaOsDecisionsPresentation({");
    const presentation = readFileSync("lib/meta/decisions-os-presentation.ts", "utf8");
    expect(presentation).toContain("export function buildMetaOsDecisionsPresentation(");
    expect(presentation).toContain("budgetIntents?: readonly ValidatedBudgetIntent[];");
  });

  it("returns the canonical lossless budget action in its served contract", () => {
    const intent = validIntent();
    const served = buildMetaOsDecisionsPresentation(
      builderInput({ budgetIntents: [intent] }) as never,
    );
    expect(served.budgetReview?.count).toBe(1);
    const action = served.budgetReview!.actions[0]!;
    expect(action.intent).toBe("review");
    expect(action.providerMutation).toBeNull();
    expect(action.targetLevel).toBe("campaign");
    expect(action.budgetIntent.kind).toBe("budget_intent");
    // Lossless: every binding on the validated intent is present and equal.
    const omitted = Object.keys(intent).filter((k) => !(k in action.budgetIntent));
    expect(omitted).toEqual([]);
    for (const key of Object.keys(intent) as Array<keyof typeof intent>) {
      expect(
        JSON.stringify((action.budgetIntent as unknown as Record<string, unknown>)[key]),
        key,
      ).toBe(JSON.stringify(intent[key]));
    }
  });

  it("serves output byte-identical to a build with no budget parameter at all", () => {
    const withoutParam = buildMetaOsDecisionsPresentation(builderInput() as never);
    const withEmpty = buildMetaOsDecisionsPresentation(
      builderInput({ budgetIntents: [] }) as never,
    );
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withoutParam));
    // The key is absent, not present-and-empty.
    expect("budgetReview" in withoutParam).toBe(false);
    expect(JSON.stringify(withoutParam)).not.toContain("budgetReview");
  });

  it("serves several intents and keeps each one whole", () => {
    const a = validIntent();
    const b = validIntent({ percent: 25, direction: "increase" });
    const served = buildMetaOsDecisionsPresentation(
      builderInput({ budgetIntents: [a, b] }) as never,
    );
    expect(served.budgetReview?.count).toBe(2);
    expect(served.budgetReview!.actions.map((x) => x.budgetIntent.intentKey).sort())
      .toEqual([a.intentKey, b.intentKey].sort());
    for (const action of served.budgetReview!.actions) {
      expect(action.providerMutation).toBeNull();
      expect(action.budgetIntent.executionState).toBe("validated_only");
    }
  });

  it("decides nothing: it serves exactly the intents it was handed", () => {
    const served = buildMetaOsDecisionsPresentation(builderInput() as never);
    expect(served.budgetReview).toBeUndefined();
    const source = readFileSync("lib/meta/decisions-os-presentation.ts", "utf8");
    const assembly = source.slice(source.indexOf("const budgetActions ="), source.indexOf("const budgetActions =") + 400);
    expect(assembly).not.toMatch(/percent|magnitude|choose|select/i);
    expect(assembly).not.toMatch(/getDb|fetch\(|INSERT INTO/);
  });

  it("refuses an invalid budget branch inside the real builder", () => {
    const broken = JSON.parse(JSON.stringify(validIntent()));
    broken.executionState = "applied";
    expect(() =>
      buildMetaOsDecisionsPresentation(builderInput({ budgetIntents: [broken] }) as never),
    ).toThrow(/D081 refuses/);
  });
});

describe("D081 C2 — the canonical decision-authority read path uses the shared rule", () => {
  it("is imported and called by the read model, not merely defined", () => {
    const readModel = readFileSync("lib/meta/decisions-workspace-read-model.ts", "utf8");
    expect(readModel).toContain('import { evaluateAccountScopedRoleAuthority } from "@/lib/meta/campaign-role-authority"');
    expect(readModel).toContain("const scopedAuthority = evaluateAccountScopedRoleAuthority({");
    expect(readModel).toContain("const trustedForAction = scopedAuthority.satisfiesRoleAuthority;");
  });

  it("reproduces the canonical rule exactly", () => {
    const validated = (v: string | null | undefined) => v === "rv-approved";
    const base = { kind: "main", source: "system_inferred", confidenceClass: "high", resolverVersion: "rv-approved", isResolverVersionValidated: validated };
    expect(evaluateAccountScopedRoleAuthority(base).satisfiesRoleAuthority).toBe(true);
    for (const [label, over, blocker] of [
      ["a non-automatic source", { source: "legacy_label" }, "role_source_not_system_inferred"],
      ["an absent source", { source: null }, "role_source_not_system_inferred"],
      ["medium confidence", { confidenceClass: "medium" }, "role_confidence_not_high"],
      ["low confidence", { confidenceClass: "low" }, "role_confidence_not_high"],
      ["conflict", { confidenceClass: "conflict" }, "role_confidence_not_high"],
      ["an absent resolver version", { resolverVersion: null }, "role_resolver_version_absent"],
      ["an unvalidated resolver version", { resolverVersion: "rv-old" }, "role_resolver_version_unvalidated"],
      ["an unrecognised kind", { kind: "winner" }, "role_kind_unrecognised"],
      ["no kind", { kind: null }, "role_kind_unrecognised"],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const r = evaluateAccountScopedRoleAuthority({ ...base, ...over } as never);
      expect(r.satisfiesRoleAuthority, label).toBe(false);
      expect(r.blocker, label).toBe(blocker);
    }
  });

  it("fails closed under the real environment validator", () => {
    // No approved resolver version is configured here, so the canonical
    // validator refuses — which is what the read path will do too.
    expect(isCampaignContextResolverAuthorityValidated("anything")).toBe(false);
    expect(evaluateAccountScopedRoleAuthority({
      kind: "main", source: "system_inferred", confidenceClass: "high",
      resolverVersion: "anything", isResolverVersionValidated: isCampaignContextResolverAuthorityValidated,
    }).satisfiesRoleAuthority).toBe(false);
  });

  it("has no circular import between the read model and the authority module", () => {
    // Only real import statements can form a cycle; the module names the read
    // model in a documentation reference, which cannot.
    const authority = readFileSync("lib/meta/campaign-role-authority.ts", "utf8");
    const imports = [...authority.matchAll(/^\s*import[\s\S]*?from "([^"]+)";/gm)].map((m) => m[1]!);
    expect(imports).not.toContain("@/lib/meta/decisions-workspace-read-model");
    expect(imports).not.toContain("@/lib/meta/decisions-os-presentation");
    // And the helper the read path calls imports nothing at all.
    const helper = authority.slice(authority.indexOf("export function evaluateAccountScopedRoleAuthority"));
    expect(helper).not.toContain("import ");
  });
});

describe("D081 C2 — non-test runtime importers exist for both capabilities", () => {
  const runtimeHits = (symbol: string) =>
    execSync(
      `grep -rn "${symbol}" --include="*.ts" --include="*.tsx" app components lib 2>/dev/null || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.includes(".test."))
      .filter((line) => !/^lib\/meta\/(budget-intent-contract|campaign-role-authority)\.ts:/.test(line))
      .filter((line) => !line.includes("* ") && !line.trimStart().startsWith("//"));

  it("has a runtime consumer of the role authority", () => {
    const hits = runtimeHits("evaluateAccountScopedRoleAuthority");
    expect(hits.length, hits.join("\n")).toBeGreaterThan(0);
    expect(hits.some((h) => h.startsWith("lib/meta/decisions-workspace-read-model.ts"))).toBe(true);
  });

  it("has a runtime producer of the budget action inside the route-called builder", () => {
    const hits = runtimeHits("toCanonicalDecisionAction");
    expect(hits.length, hits.join("\n")).toBeGreaterThan(0);
    expect(hits.some((h) => h.startsWith("lib/meta/decisions-os-presentation.ts"))).toBe(true);
    // The producer must be called INSIDE the builder the route calls, not only
    // imported beside it.
    const source = readFileSync("lib/meta/decisions-os-presentation.ts", "utf8");
    const builder = source.slice(source.indexOf("export function buildMetaOsDecisionsPresentation("));
    expect(builder).toContain("toCanonicalDecisionAction(intent)");
  });

  it("keeps the currency authority reachable from the intent contract", () => {
    const contract = readFileSync("lib/meta/budget-intent-contract.ts", "utf8");
    expect(contract).toContain('from "@/lib/currency/iso-4217-minor-units"');
  });
});

describe("D081 C3 — the reader carries the persisted kind_source, never a synthesized one", () => {
  it("selects kind_source and maps it by raw equality in both arms", () => {
    // The column exists and the job persists it; the reader previously did not
    // select it and wrote the literal `system_inferred` instead.
    const readModel = readFileSync("lib/meta/decisions-workspace-read-model.ts", "utf8");
    expect(readModel).toContain("inferred.kind_source");
    expect(readModel).toContain("kind_source: string | null;");
    // The literal is now only reachable through an exact comparison.
    // Raw equality only: no text(), trim, or case folding on the way in, and
    // both return arms go through the one helper.
    expect(readModel).toContain("export function exactCampaignContextSource(");
    expect(readModel).toContain('value === "system_inferred" ? "system_inferred" : "unknown"');
    expect(readModel).not.toContain('text(row.kind_source) === "system_inferred"');
    expect(readModel.match(/source: exactCampaignContextSource\(row\.kind_source\)/g) ?? [])
      .toHaveLength(2);
  });

  /**
   * The synthetic `map`/`trust` pair that stood here reimplemented the mapping
   * with raw equality and therefore passed while the real reader trimmed and
   * fabricated. The behavioural coverage now lives in
   * `lib/meta/decisions-workspace-read-model.test.ts`, which calls
   * `readMetaDecisionCampaignContextRows` and
   * `buildMetaDecisionsWorkspaceReadModel` directly.
   */
  it("delegates the source attacks to the real reader suite", () => {
    const readerSuite = readFileSync("lib/meta/decisions-workspace-read-model.test.ts", "utf8");
    expect(readerSuite).toContain("D081 C4 — exact kind_source at the real reader boundary");
    expect(readerSuite).toContain("readMetaDecisionCampaignContextRows({");
    expect(readerSuite).toContain("buildMetaDecisionsWorkspaceReadModel({");
    // And this file must not reimplement the mapping again.
    const own = readFileSync("lib/meta/d081-runtime-consumers.test.ts", "utf8");
    expect(own).not.toMatch(/kindSource === "system_inferred" \? "system_inferred" : "unknown"/);
  });

  it("calls the canonical resolver validator exactly once per row", () => {
    // A second call silently changed behaviour for any caller stubbing it
    // per-call, which an existing suite caught.
    const readModel = readFileSync("lib/meta/decisions-workspace-read-model.ts", "utf8");
    const fn = readModel.slice(readModel.indexOf("function campaignRole(input: {"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const calls = body.match(/isCampaignContextResolverAuthorityValidated\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(body).toContain("isResolverVersionValidated: () => resolverVersionValidated");
  });
});
