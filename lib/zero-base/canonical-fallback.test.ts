/**
 * The rollback lever, proven in both directions.
 *
 * The property that matters most here is the one that cannot be checked by
 * reading either half on its own: `compatibility.ts` moves legacy → canonical
 * when the mode is on, and this module moves canonical → legacy when it is off.
 * If those two ever used different predicates, a request would bounce between
 * them for ever. The loop test below drives the real tables against the real
 * decision functions rather than asserting the property in a comment.
 */
import { describe, expect, it } from "vitest";

import {
  COMPATIBILITY_TABLE,
  decideCompatibility,
  type CompatibilityActor,
} from "@/lib/zero-base/compatibility";
import {
  CANONICAL_FALLBACK_BY_TEMPLATE,
  canonicalEnabled,
  canonicalTemplateForAppPath,
  resolveCanonicalFallback,
} from "@/lib/zero-base/canonical-fallback";
import type { ZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";

const BUSINESS = "biz_1";
const OTHER = "biz_2";

function config(
  uiMode: ZeroBaseRolloutConfig["uiMode"],
  allowlistedBusinessIds: string[] = [],
): ZeroBaseRolloutConfig {
  return {
    uiMode,
    allowlistedBusinessIds,
    mutationUiEnabled: false,
    reportShareFailClosed: false,
  };
}

describe("the reverse table is derived, not written", () => {
  it("covers every business-scoped canonical destination the table names", () => {
    const expected = new Set(
      COMPATIBILITY_TABLE.filter(
        (target) => target.scope === "business" && target.canonicalUrls.length === 1,
      ).map((target) => target.canonicalUrls[0]!),
    );
    expect(new Set(CANONICAL_FALLBACK_BY_TEMPLATE.keys())).toEqual(expected);
  });

  it("never maps a canonical destination to more than one legacy route", () => {
    // A Map cannot hold two values for one key, so the real assertion is that
    // the collapse was deliberate: every canonical URL resolves to a route that
    // the table actually lists for it.
    for (const [canonical, legacy] of CANONICAL_FALLBACK_BY_TEMPLATE) {
      const routes = COMPATIBILITY_TABLE.filter((target) =>
        target.canonicalUrls.includes(canonical),
      ).map((target) => target.route);
      expect(routes, `${canonical} → ${legacy}`).toContain(legacy);
    }
  });

  it("prefers the hub when a hub and a tab share one canonical screen", () => {
    // The two live collisions, named so a third one cannot appear silently.
    expect(CANONICAL_FALLBACK_BY_TEMPLATE.get("/c/[businessId]/analytics/ga4-shopify")).toBe(
      "/insights",
    );
    expect(CANONICAL_FALLBACK_BY_TEMPLATE.get("/c/[businessId]/google/overview")).toBe(
      "/platforms/google",
    );
  });

  it("excludes ops, account and split scopes", () => {
    for (const canonical of CANONICAL_FALLBACK_BY_TEMPLATE.keys()) {
      expect(canonical.startsWith("/c/[businessId]/")).toBe(true);
    }
  });
});

describe("the four rollout modes, on a canonical path", () => {
  const appPath = "meta/decisions";

  it("on → the canonical owner renders", () => {
    expect(
      resolveCanonicalFallback({ appPath, config: config("on"), businessId: BUSINESS }),
    ).toEqual({ kind: "canonical" });
  });

  it("allowlist + included business → the canonical owner renders", () => {
    expect(
      resolveCanonicalFallback({
        appPath,
        config: config("allowlist", [BUSINESS]),
        businessId: BUSINESS,
      }),
    ).toEqual({ kind: "canonical" });
  });

  it("allowlist + excluded business → the preserved legacy owner", () => {
    expect(
      resolveCanonicalFallback({
        appPath,
        config: config("allowlist", [OTHER]),
        businessId: BUSINESS,
      }),
    ).toEqual({ kind: "legacy", destination: "/platforms/meta", reason: "not-enabled" });
  });

  it("off → the preserved legacy owner, not a 404", () => {
    expect(
      resolveCanonicalFallback({ appPath, config: config("off"), businessId: BUSINESS }),
    ).toEqual({ kind: "legacy", destination: "/platforms/meta", reason: "mode-off" });
  });

  it("unset behaves as off, because the parser defaults to off", () => {
    // Not a separate mode: `readZeroBaseRolloutConfig` resolves an absent value
    // to `off`, which is what makes this the shipped state.
    expect(
      resolveCanonicalFallback({ appPath, config: config("off"), businessId: null }),
    ).toMatchObject({ kind: "legacy", reason: "mode-off" });
  });

  it("internal → a client surface still falls back", () => {
    /*
     * `internal` is for staff previewing OUTSIDE a client, and
     * `isZeroBaseUiEnabledForBusiness` returns false for it deliberately: an
     * allowlist names businesses and `internal` names none. So a business-
     * scoped canonical path is not enabled by internal alone, and falls back
     * exactly as it does under `allowlist` with no match.
     */
    expect(
      resolveCanonicalFallback({
        appPath,
        config: config("internal"),
        businessId: BUSINESS,
      }),
    ).toEqual({ kind: "legacy", destination: "/platforms/meta", reason: "not-enabled" });
  });
});

describe("a surface with no legacy owner is named, not redirected", () => {
  for (const appPath of [
    "meta/intelligence",
    "creative/briefs",
    "creative/shares",
    "google/products",
    "google/plan",
    "klaviyo",
    "analytics/landing-pages",
    "manage/plan",
  ]) {
    it(`${appPath} rolls back rather than borrowing another screen`, () => {
      expect(
        resolveCanonicalFallback({ appPath, config: config("off"), businessId: BUSINESS }),
      ).toEqual({ kind: "rolled-back", reason: "mode-off" });
    });
  }

  it("is the exact set — a ninth would mean a surface lost its legacy owner", () => {
    const canonicalPaths = [
      "home",
      "meta/decisions",
      "meta/intelligence",
      "meta/launchpad",
      "meta/automation",
      "meta/history",
      "creative/performance",
      "creative/briefs",
      "creative/inbox",
      "creative/copies",
      "creative/landing-pages",
      "creative/audiences",
      "creative/shares",
      "google/overview",
      "google/advisor",
      "google/search",
      "google/products",
      "google/assets-audiences",
      "google/plan",
      "klaviyo",
      "analytics/ga4-shopify",
      "analytics/landing-pages",
      "analytics/seo",
      "analytics/geo",
      "reports",
      "reports/new",
      "manage/integrations",
      "manage/team",
      "manage/business",
      "manage/plan",
    ];
    const orphans = canonicalPaths.filter(
      (appPath) =>
        !CANONICAL_FALLBACK_BY_TEMPLATE.has(canonicalTemplateForAppPath(appPath)),
    );
    expect(orphans).toEqual([
      "meta/intelligence",
      "creative/briefs",
      "creative/shares",
      "google/products",
      "google/plan",
      "klaviyo",
      "analytics/landing-pages",
      "manage/plan",
    ]);
  });
});

describe("dynamic segments survive the hop, or refuse it", () => {
  it("carries a report id into the legacy route", () => {
    expect(
      resolveCanonicalFallback({
        appPath: "reports/[reportId]",
        config: config("off"),
        businessId: BUSINESS,
        params: { reportId: "rep_1" },
      }),
    ).toEqual({
      kind: "legacy",
      destination: "/reports/rep_1",
      reason: "mode-off",
    });
  });

  it("refuses a CONCRETE path, because the reverse map is keyed by template", () => {
    /*
     * The misuse this contract has to make loud. `reports/rep_1` is not a key
     * in the reverse map, so it resolves to `rolled-back` — a surface with a
     * legacy owner being refused. The caller has just dispatched on the path
     * and therefore knows the template; passing the concrete form is the bug,
     * and this pins the behaviour so the call site is written correctly.
     */
    expect(
      resolveCanonicalFallback({
        appPath: "reports/rep_1",
        config: config("off"),
        businessId: BUSINESS,
        params: { reportId: "rep_1" },
      }),
    ).toEqual({ kind: "rolled-back", reason: "mode-off" });
  });

  it("refuses rather than emitting a literal [reportId] in a URL", () => {
    expect(
      resolveCanonicalFallback({
        appPath: "reports/[reportId]",
        config: config("off"),
        businessId: BUSINESS,
      }),
    ).toEqual({ kind: "rolled-back", reason: "mode-off" });
  });

  it("preserves the query string verbatim", () => {
    expect(
      resolveCanonicalFallback({
        appPath: "meta/history",
        config: config("off"),
        businessId: BUSINESS,
        search: "?kind=writes&startDate=2026-01-01",
      }),
    ).toEqual({
      kind: "legacy",
      destination: "/platforms/meta/history?kind=writes&startDate=2026-01-01",
      reason: "mode-off",
    });
  });
});

describe("the two halves cannot disagree, so there is no loop", () => {
  const actor: CompatibilityActor = {
    kind: "authenticated",
    superadmin: false,
    activeBusinessId: BUSINESS,
    businessAccess: "authorized",
  };

  for (const mode of ["off", "on", "allowlist", "internal"] as const) {
    for (const allowlist of [[], [BUSINESS]]) {
      const rollout = config(mode, allowlist);
      const label = `${mode}${allowlist.length ? "+listed" : ""}`;

      it(`${label}: exactly one of the two halves wants to move`, () => {
        /*
         * The loop, stated as an impossibility.
         *
         * For every business-scoped legacy path: if the legacy half redirects
         * to canonical, the canonical half must NOT redirect back — and vice
         * versa. Driven against the real tables and the real decision
         * functions, so a future edit to either predicate fails here rather
         * than in a browser that never stops loading.
         */
        for (const target of COMPATIBILITY_TABLE) {
          if (target.scope !== "business") continue;
          if (target.canonicalUrls.length !== 1) continue;
          const canonical = target.canonicalUrls[0]!;
          // Only the ones this module can move back; the rest cannot loop by
          // construction because they have no reverse entry.
          if (CANONICAL_FALLBACK_BY_TEMPLATE.get(canonical) !== target.route) continue;
          // Dynamic legacy routes need ids the loop argument does not depend on.
          if (canonical.includes("[") && !canonical.includes("[businessId]")) continue;

          const forward = decideCompatibility({ target, config: rollout, actor });
          const appPath = canonical.replace("/c/[businessId]/", "");
          const back = resolveCanonicalFallback({
            appPath,
            config: rollout,
            businessId: BUSINESS,
          });

          const forwardMoves = forward.kind === "redirect";
          const backMoves = back.kind === "legacy";
          expect(
            forwardMoves && backMoves,
            `${target.route} ↔ ${canonical} both moved under ${label}`,
          ).toBe(false);
        }
      });
    }
  }

  it("uses one predicate, and it is the one compatibility.ts uses", () => {
    for (const mode of ["off", "on", "allowlist", "internal"] as const) {
      for (const allowlist of [[], [BUSINESS]]) {
        const rollout = config(mode, allowlist);
        const target = COMPATIBILITY_TABLE.find(
          (candidate) => candidate.route === "/platforms/meta",
        )!;
        const forward = decideCompatibility({ target, config: rollout, actor });
        // `canonicalEnabled` is true exactly when the legacy half hands over.
        expect(canonicalEnabled(rollout, BUSINESS)).toBe(forward.kind === "redirect");
      }
    }
  });
});
