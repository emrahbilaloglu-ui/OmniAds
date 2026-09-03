import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  DEFAULT_CONTEXT_CONFIG,
  RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
  classifyCampaignContext,
  type CampaignFeatures,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
  RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
  classifyCampaignContextV3,
} from "@/lib/creative-decision-engine/campaign-context/resolver-v3";
import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";
import { evaluateAccountScopedRoleAuthority } from "@/lib/meta/campaign-role-authority";

/**
 * D081 C5 — a campaign name is never authoritative, on any branch.
 *
 * Every check runs at the real resolver-to-authority boundary and compares the
 * full authoritative tuple `{ satisfiesRoleAuthority, authoritativeKind }`, not
 * a boolean. The earlier suite compared booleans on a fixture that was
 * unauthorized under every name, so equal `false` answers proved nothing.
 */
const APPROVED = CAMPAIGN_CONTEXT_RESOLVER_VERSION;
const validated = (v: string | null | undefined) => v === APPROVED;

interface AuthTuple {
  satisfiesRoleAuthority: boolean;
  authoritativeKind: string | null;
}

function features(over: Partial<CampaignFeatures> = {}): CampaignFeatures {
  return {
    campaignId: "c-1", campaignName: null,
    spend28: 5_000, activeCreatives: 6, newCreatives: 1, medianCreativeAgeDays: 40,
    top3SpendShare: 0.6, spendHhi: 0.2, adsetCount: 4, activeDays: 40,
    campaignAgeDays: 120, spendShareOfBusiness: 0.35,
    medianCreativeSpend: 700, accountMedianCreativeSpend: 600,
    lineageDonorCount: 0, lineageReceiverCount: 0, lineageSharedCount: 0,
    ...over,
  };
}

/** The real boundary: resolver output -> canonical authority rule -> tuple. */
function authorityTuple(
  f: CampaignFeatures,
  variant: "v2" | "v3" = "v2",
): AuthTuple {
  const r = (variant === "v2"
    ? classifyCampaignContext(f, DEFAULT_CONTEXT_CONFIG)
    : classifyCampaignContextV3(f as never, null as never)) as {
    kind: string | null; kindSource: string; confidenceClass: string;
  };
  const decided = evaluateAccountScopedRoleAuthority({
    kind: r.kind, source: r.kindSource, confidenceClass: r.confidenceClass,
    resolverVersion: APPROVED, isResolverVersionValidated: validated,
  });
  return {
    satisfiesRoleAuthority: decided.satisfiesRoleAuthority,
    authoritativeKind: decided.satisfiesRoleAuthority ? r.kind : null,
  };
}

/** Names spanning every token family the resolvers score, plus adversarial mixes. */
const NAMES: Array<string | null> = [
  null, "", "Untitled campaign",
  "CORE evergreen scale", "ASC catalog winner", "DPA scale main", "core",
  "TEST - new angle", "experiment v2", "TESTING creative batch", "test",
  "TEST core scale winner", "main test mixed", "CORE // TEST // winner",
];

/**
 * Branch fixtures. Each is named for the branch it exercises, and the suite
 * asserts that at least three of them are genuinely AUTHORITATIVE so the
 * name-invariance checks cannot pass vacuously.
 */
const BRANCHES: Array<{ branch: string; features: CampaignFeatures }> = [
  {
    branch: "strong_test_signature",
    features: features({
      activeCreatives: 14, newCreatives: 12, adsetCount: 6, top3SpendShare: 0.2,
      medianCreativeSpend: 30, accountMedianCreativeSpend: 600, spend28: 3_000,
      activeDays: 30, medianCreativeAgeDays: 5,
    }),
  },
  {
    branch: "normal_high_main",
    features: features({
      spend28: 90_000, spendShareOfBusiness: 0.85, activeDays: 120,
      activeCreatives: 20, newCreatives: 0, medianCreativeAgeDays: 200,
      top3SpendShare: 0.75, adsetCount: 2, medianCreativeSpend: 4_000,
    }),
  },
  {
    branch: "normal_high_test",
    features: features({
      spend28: 2_000, spendShareOfBusiness: 0.05, activeDays: 21,
      activeCreatives: 12, newCreatives: 10, medianCreativeAgeDays: 6,
      top3SpendShare: 0.25, adsetCount: 5, medianCreativeSpend: 60,
      accountMedianCreativeSpend: 800,
    }),
  },
  {
    branch: "mixed_candidate",
    features: features({
      spend28: 40_000, spendShareOfBusiness: 0.55, activeDays: 90,
      activeCreatives: 18, newCreatives: 6, medianCreativeAgeDays: 45,
      top3SpendShare: 0.5, adsetCount: 5, medianCreativeSpend: 1_200,
    }),
  },
  {
    branch: "borderline_margin",
    features: features({
      spend28: 12_000, spendShareOfBusiness: 0.5, activeDays: 45,
      activeCreatives: 9, newCreatives: 4, medianCreativeAgeDays: 30,
      top3SpendShare: 0.45, adsetCount: 4, medianCreativeSpend: 500,
    }),
  },
  {
    branch: "below_floors_unknown",
    features: features({ spend28: 1, activeCreatives: 0, activeDays: 0 }),
  },
];

describe("D081 C5 — the resolver identity moves with the semantics", () => {
  it("assigns new identities and never reuses the retired ones", () => {
    expect(CAMPAIGN_CONTEXT_RESOLVER_VERSION)
      .toBe("campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01");
    expect(CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION)
      .toBe("campaign-context-resolver.v3-lifecycle-name-neutral-2026-09-01");
    for (const retired of [
      ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
      ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
    ]) {
      expect(retired).toMatch(/2026-08-29$/);
      expect(CAMPAIGN_CONTEXT_RESOLVER_VERSION).not.toBe(retired);
      expect(CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION).not.toBe(retired);
    }
  });

  it("approves only the exact compiled identity, and stays fail-closed", () => {
    const original = process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION;
    try {
      // Approving the NEW identity admits only that exact string.
      process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION = CAMPAIGN_CONTEXT_RESOLVER_VERSION;
      expect(isCampaignContextResolverAuthorityValidated(CAMPAIGN_CONTEXT_RESOLVER_VERSION)).toBe(true);
      for (const rejected of [
        ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
        ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
        CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
        null, undefined, "", "   ",
        CAMPAIGN_CONTEXT_RESOLVER_VERSION.toUpperCase(),
        ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}`,
        `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} `,
        "arbitrary-string",
      ]) {
        expect(isCampaignContextResolverAuthorityValidated(rejected as never), String(rejected)).toBe(false);
      }

      // Naming the RETIRED string in the environment approves nothing: the
      // pre-change algorithm cannot be re-approved under its old identity.
      process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION = RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS[0];
      expect(isCampaignContextResolverAuthorityValidated(RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS[0])).toBe(false);
      expect(isCampaignContextResolverAuthorityValidated(CAMPAIGN_CONTEXT_RESOLVER_VERSION)).toBe(false);

      // Unset approves nothing at all.
      delete process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION;
      expect(isCampaignContextResolverAuthorityValidated(CAMPAIGN_CONTEXT_RESOLVER_VERSION)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION;
      else process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION = original;
    }
  });

  it("leaves the approval environment actually unset after the suite", () => {
    expect(process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION).toBeUndefined();
  });
});

describe("D081 C5 — the fixtures are not vacuous", () => {
  it("includes branches that are genuinely authoritative", () => {
    const authorized = BRANCHES.filter((b) => authorityTuple(b.features).satisfiesRoleAuthority);
    expect(
      authorized.map((b) => b.branch),
      "at least three branches must actually grant authority, or name-invariance proves nothing",
    ).toHaveLength(3);
    // And they must not all be the same kind.
    const kinds = new Set(authorized.map((b) => authorityTuple(b.features).authoritativeKind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it("names the branch each fixture exercises", () => {
    expect(BRANCHES.map((b) => b.branch)).toEqual([
      "strong_test_signature", "normal_high_main", "normal_high_test",
      "mixed_candidate", "borderline_margin", "below_floors_unknown",
    ]);
  });
});

describe.each(["v2", "v3"] as const)(
  "D081 C5 — renaming cannot change the authoritative tuple (%s)",
  (variant) => {
    it.each(BRANCHES.map((b) => [b.branch, b.features] as const))(
      "%s is name-invariant across every name",
      (branch, base) => {
        const baseline = authorityTuple({ ...base, campaignName: null }, variant);
        for (const campaignName of NAMES) {
          const actual = authorityTuple({ ...base, campaignName }, variant);
          expect(actual, `${branch} / ${variant} / ${JSON.stringify(campaignName)}`)
            .toEqual(baseline);
        }
      },
    );
  },
);

describe("D081 C5 — the two reproduced defects, as regressions", () => {
  it("a Main-flavoured name no longer vetoes the strong-Test shortcut", () => {
    const base = BRANCHES[0]!.features;
    const unnamed = authorityTuple({ ...base, campaignName: null });
    const renamed = authorityTuple({ ...base, campaignName: "CORE evergreen scale winner" });
    // Before: {true,"test"} became {false,null}.
    expect(unnamed).toEqual({ satisfiesRoleAuthority: true, authoritativeKind: "test" });
    expect(renamed).toEqual(unnamed);
  });

  it("a contradicting name no longer demotes a high row to conflict", () => {
    const base = BRANCHES[1]!.features;
    const unnamed = authorityTuple({ ...base, campaignName: null });
    const renamed = authorityTuple({ ...base, campaignName: "TEST new angle" });
    // Before: {true,"main"} became {false,null}.
    expect(unnamed).toEqual({ satisfiesRoleAuthority: true, authoritativeKind: "main" });
    expect(renamed).toEqual(unnamed);
  });

  it("keeps naming as recorded evidence without letting it decide the class", () => {
    const contradicted = classifyCampaignContext(
      { ...BRANCHES[1]!.features, campaignName: "TEST new angle" },
      DEFAULT_CONTEXT_CONFIG,
    );
    // The reason is still recorded for a reader...
    expect(contradicted.conflictReasons).toContain("naming_contradicts_behavior");
    // ...but it no longer forces the conflict class.
    expect(contradicted.confidenceClass).toBe("high");
  });

  it("keeps non-naming conflict fail-closed", () => {
    const source = readFileSync("lib/creative-decision-engine/campaign-context/resolver.ts", "utf8");
    expect(source).toContain('authoritativeConflictReasons.push("top_classes_too_close")');
    expect(source).toContain("if (authoritativeConflictReasons.length > 0) {");
    // Naming never enters the authoritative list.
    expect(source).not.toMatch(/authoritativeConflictReasons\.push\("naming/);
  });

  it("never restores a manual label on any branch or name", () => {
    for (const { features: f } of BRANCHES) {
      for (const campaignName of NAMES) {
        expect(classifyCampaignContext({ ...f, campaignName }, DEFAULT_CONTEXT_CONFIG).kindSource)
          .toBe("system_inferred");
      }
    }
  });
});

describe("D081 C5 — bounded deterministic adversarial matrix", () => {
  it("no (features, name) pair differs from its unnamed baseline", () => {
    // Deterministic sweep: every branch fixture crossed with a spend/turnover
    // perturbation, against every name. No randomness, no hidden sampling.
    const perturbations = [1, 0.5, 2, 0.1];
    const failures: string[] = [];
    let compared = 0;
    for (const variant of ["v2", "v3"] as const) {
      for (const { branch, features: base } of BRANCHES) {
        for (const factor of perturbations) {
          const scaled = {
            ...base,
            spend28: Math.round(base.spend28 * factor),
            newCreatives: Math.max(0, Math.round(base.newCreatives * factor)),
            activeDays: Math.max(0, Math.round(base.activeDays * factor)),
          };
          const baseline = authorityTuple({ ...scaled, campaignName: null }, variant);
          for (const campaignName of NAMES) {
            compared += 1;
            const actual = authorityTuple({ ...scaled, campaignName }, variant);
            if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
              failures.push(`${variant}/${branch}/x${factor}/${JSON.stringify(campaignName)}: ${JSON.stringify(actual)} != ${JSON.stringify(baseline)}`);
            }
          }
        }
      }
    }
    expect(compared).toBe(2 * BRANCHES.length * perturbations.length * NAMES.length);
    expect(failures, failures.slice(0, 5).join("\n")).toEqual([]);
  });

  it("the matrix contains authoritative rows, so it is not vacuous", () => {
    const authorized = BRANCHES.flatMap(({ features: base }) =>
      (["v2", "v3"] as const).map((v) => authorityTuple({ ...base, campaignName: null }, v)),
    ).filter((t) => t.satisfiesRoleAuthority);
    expect(authorized.length).toBeGreaterThan(0);
  });
});
