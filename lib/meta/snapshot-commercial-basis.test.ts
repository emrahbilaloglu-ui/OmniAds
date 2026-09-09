/**
 * The snapshot's bid-cap benchmark is derived from META's own attributed AOV,
 * and from nothing else.
 *
 * WHAT WAS WRONG. `attachSizedIntents` in `lib/meta/snapshot.ts` resolved the
 * store's observed Shopify average order value and divided it by the configured
 * target ROAS to get the CPA benchmark that sizes a bid cap and sets the
 * loss-budget maturity floor. Sizing Meta money from revenue Meta never
 * attributed is the wrong book — the merchant's settled orders answer a
 * different question — and it was a SECOND ladder besides `resolveSpendUnit`,
 * so the amount a bid cap was sized from and the amount the commercial-anchor
 * panel explained could be two different numbers for the same account. The
 * store rung has since been removed from `resolveSpendUnit` itself, which left
 * this copy of it as the last live one.
 *
 * WHY THIS IS A DEPENDENCY GUARD RATHER THAN A BEHAVIOURAL ONE.
 * `attachSizedIntents` is module-private and is reached only through
 * `runMetaSnapshotForBusiness`, which performs dozens of warehouse reads before
 * it; standing that up would take a mock surface larger than the thing under
 * test, and restating the ladder here to "check the arithmetic" is exactly the
 * mirror that let the defect survive (`lib/meta/shopify-anchor-wiring.test.ts`
 * still holds one). So this pins the claim that can be pinned honestly and is
 * the claim the defect was: WHICH resolver and WHICH reader the module is wired
 * to. It reads the module's own import statements, not its prose — the file
 * discusses Shopify at length in comments, and a text scan would pass or fail on
 * those.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SNAPSHOT_PATH = path.join(process.cwd(), "lib", "meta", "snapshot.ts");

/**
 * Every identifier `lib/meta/snapshot.ts` imports, per module specifier.
 *
 * Deliberately narrow: it matches `import { … } from "…"` and
 * `import X from "…"`, which is every form this file uses. `import type` is
 * included, because a type-only import cannot bring a resolver in but is still
 * a dependency worth naming if one appears.
 */
function importedBindings(): Map<string, string[]> {
  const source = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  const byModule = new Map<string, string[]>();
  const pattern =
    /import\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s+"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const named = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
      .filter(Boolean);
    const defaultBinding = match[2] ? [match[2]] : [];
    const specifier = match[3]!;
    byModule.set(specifier, [
      ...(byModule.get(specifier) ?? []),
      ...named,
      ...defaultBinding,
    ]);
  }
  return byModule;
}

const SHOPIFY_AOV_MODULE =
  "@/lib/creative-decision-engine/shopify-aov-source";

describe("the snapshot's commercial spend unit", () => {
  it("parses the module's imports at all, so an empty result cannot pass", () => {
    // The guard below is an ABSENCE assertion, and an absence assertion over a
    // broken parse is vacuous. This is the control.
    const bindings = importedBindings();
    expect(bindings.size).toBeGreaterThan(20);
    expect(bindings.get("@/lib/db")).toContain("getDb");
  });

  it("is resolved by the engine's own canonical ladder", () => {
    const bindings = importedBindings();
    /*
      ONE ladder. `resolveSpendUnit` is the function the account decision
      profile and the commercial-anchor panel resolve through, so a bid cap
      sized here cannot disagree with the anchor the operator is shown.
    */
    expect(
      bindings.get("@/lib/creative-decision-engine/spend-unit-resolver"),
    ).toContain("resolveSpendUnit");
    /*
      And the quantity that ladder divides is META's, from the one reader that
      answers it — the same statement `WarehouseDataSource.getMetaAttributedAov`
      calls, with the provider account as a parameter, so an account with no
      purchases of its own cannot be handed a sibling's average order value.
    */
    expect(
      bindings.get("@/lib/creative-decision-engine/meta-aov-calculator"),
    ).toContain("computeMetaAttributedAov");
  });

  it("does not reach the store's own average order value at all", () => {
    /*
      The regression this file exists for. Importing either of these back into
      the snapshot is the only way the retired rung can return to this path,
      because `resolveSpendUnit` no longer offers it: a caller would have to
      read the store and divide by the target ROAS itself, exactly as the
      removed expression did.
    */
    const shopifyBindings = importedBindings().get(SHOPIFY_AOV_MODULE) ?? [];
    expect(shopifyBindings).toEqual([]);
  });
});
