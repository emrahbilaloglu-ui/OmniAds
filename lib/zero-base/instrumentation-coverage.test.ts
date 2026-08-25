/**
 * WP17's telemetry acceptance, audited — and two claims corrected.
 *
 * The WP17 report records this item as *"the other 48 contracted events — NOT
 * AUDITED"*. Both halves of that are wrong in ways worth fixing rather than
 * carrying forward.
 *
 * ## There is no set of 48 further events
 *
 * The design package's instrumentation contract has 74 rows and exactly one
 * event name in its vocabulary:
 *
 *     export type InstrumentationEventName = "screen_view";
 *
 * Nor does 48 match anything else in the contract: the split is 14 leaves this
 * plan owns and 60 it does not. I could not reconstruct where the number came
 * from, so it is corrected to what the package actually contains rather than
 * explained away.
 *
 * ## The product has TWO surface vocabularies, and they disagree
 *
 * `GENERATED_INSTRUMENTATION` names 74 leaves — `meta_launchpad`,
 * `manage_integrations`, `creative_copies`, `creative_landing_pages` — while
 * `PRODUCT_INSTRUMENTATION_SURFACES`, the allowlist the sink validates against,
 * named 15 coarser ones — `launchpad`, `integrations`, and a single
 * `creative_studio` covering eight contracted leaves.
 *
 * That collapse is CLOSED as of the Creative-leaf widening: each contracted
 * leaf now has its own runtime name, and `product-instrumentation.contract.test.ts`
 * holds the two allowlists to each other so a name the validator accepts can
 * never be one the stored CHECK would refuse. What remains below is the
 * classification of the leaves this plan does not own.
 *
 * They were never reconciled, and the consequence is measurable rather than
 * theoretical: per-tab adoption inside Creative Studio cannot be read from this
 * data at all, because all eight tabs emit the same name. That is a real gap
 * and it is NOT closed here — the runtime vocabulary is a stored column's
 * check constraint, so narrowing it is a migration with data implications, not
 * a local edit.
 *
 * What this file does instead is make the relationship explicit and enforced:
 * every contracted leaf is classified, every Meta surface resolves to a name
 * the sink will accept, and the coarsening is recorded leaf by leaf so it
 * cannot be mistaken for coverage it does not have.
 */
import { describe, expect, it } from "vitest";

import { GENERATED_INSTRUMENTATION } from "@/lib/zero-base/generated-contracts";
import { INSTRUMENTATION_SURFACE_BY_SURFACE_ID } from "@/components/meta/use-screen-view";
import { META_SURFACES } from "@/lib/meta/surface-registry";
import { PRODUCT_INSTRUMENTATION_SURFACES } from "@/lib/product-instrumentation";

/**
 * The contracted leaves this plan owns, and the runtime surface each collapses
 * into.
 *
 * Written out leaf by leaf on purpose. A rule that mapped by prefix would hide
 * exactly the fact worth seeing: eight contracted leaves share one runtime
 * name, so eight screens are indistinguishable in the emitted data.
 */
const META_LEAF_TO_RUNTIME_SURFACE: Record<string, string> = {
  meta_decisions: "meta_decisions",
  meta_intelligence: "meta_intelligence",
  meta_history: "meta_history",
  meta_launchpad: "launchpad",
  meta_automation: "automation",
  manage_integrations: "integrations",
  // The eight that collapse. Each is a separate screen in the contract and a
  // separate route in the registry; in the emitted data they are one name.
  creative_performance: "creative_studio",
  creative_copies: "creative_studio",
  creative_landing_pages: "creative_studio",
  creative_inbox: "creative_studio",
  creative_briefs: "creative_studio",
  creative_shares: "creative_studio",
  creative_detail: "creative_studio",
  share_creative: "creative_studio",
};

/**
 * Contracted leaves this plan does not own, grouped by why.
 *
 * None is a Meta or Creative Studio surface. They are recorded rather than
 * audited, because the honest disposition for a surface outside the scope is to
 * say so — not to mark it passing.
 */
const OUT_OF_PLAN_SCOPE: { prefix: string; why: string }[] = [
  { prefix: "pub_", why: "Pre-auth marketing pages." },
  { prefix: "auth_", why: "Sign-in, sign-up, invite and recovery." },
  { prefix: "google_", why: "The Google Ads workspace — a different provider." },
  { prefix: "ops_", why: "The operator console." },
  { prefix: "agency_", why: "The agency portfolio desk." },
  { prefix: "analytics_", why: "GA4, Shopify, SEO and geography panels." },
  { prefix: "reports_", why: "The reporting library and its editor." },
  { prefix: "me_", why: "Personal account and language settings." },
  { prefix: "manage_business", why: "Business settings. Not a Meta surface." },
  { prefix: "manage_plan", why: "Plan and billing. Not a Meta surface." },
  { prefix: "manage_team", why: "Workspace membership. Not a Meta surface." },
  { prefix: "client_home", why: "The cross-provider home. Not a Meta surface." },
  { prefix: "share_report", why: "The public report share. Not a Meta surface." },
  {
    prefix: "manage_integrations_callback",
    why: "The OAuth redirect target. A hop, not a screen an operator reads.",
  },
];

/**
 * Contracted leaves inside this plan that genuinely do NOT emit, and why.
 *
 * One entry, and it is a real gap rather than a technicality: the public share
 * page renders outside the dashboard shell, with no session and no workspace
 * context, and the shell is where the emitter lives. Its contracted row is
 * anonymous, so the leaf is real and the event is owed. Enumerated exactly so
 * it cannot grow into a habit.
 */
const KNOWN_NON_EMITTING: Record<string, string> = {
  "public-creative-share":
    "Renders outside the dashboard shell — no session, no workspace context, and the shell is where the emitter mounts. The contracted `share_creative` row is NOT anonymous (`anonymous: false`, with `token_hash` among its properties), which is a second problem rather than an excuse: an anonymous visitor cannot supply an actor, and a token hash identifies the link.",
};

function contractedSurfaces(): string[] {
  return [...new Set(GENERATED_INSTRUMENTATION.map((row) => row.surface))].sort();
}

function outOfScopeReason(surface: string): string | null {
  return OUT_OF_PLAN_SCOPE.find((entry) => surface.startsWith(entry.prefix))?.why ?? null;
}

describe("the instrumentation contract says what it says", () => {
  it("names exactly one event — the correction this file exists for", () => {
    expect([...new Set(GENERATED_INSTRUMENTATION.map((row) => row.event))]).toEqual([
      "screen_view",
    ]);
  });

  it("has 24 runtime surface names, counted rather than remembered", () => {
    /*
     * Fifteen when this check was written, and the prose before it said sixteen
     * — a count that appears in a comment and in no assertion is a number that
     * drifts. Twenty-four now: the nine Creative leaves were added so the tabs
     * could be told apart, additively, keeping `creative_studio` because
     * production rows carry it.
     */
    expect(PRODUCT_INSTRUMENTATION_SURFACES).toHaveLength(24);
  });

  it("contracts the public share leaf as anonymous, which it now is", () => {
    /*
     * This assertion has been wrong twice, in opposite directions, which is
     * worth leaving on the record.
     *
     * First it claimed in prose that the row was anonymous when the generated
     * file said `false`. Then it pinned `false` as the truth — and `false` was
     * itself a generator bug: the ledger describes this leaf as
     * `Unauthenticated recipient · token scope only`, and the derivation
     * matched only `Public · pre-auth`. Fixing the derivation flipped exactly
     * two booleans and nothing else.
     *
     * `token_hash` is still in the contracted property list and is still not
     * emitted — see the emitter, which sends no identifier of any kind.
     */
    const row = GENERATED_INSTRUMENTATION.find((entry) => entry.surface === "share_creative");
    expect(row, "the contract no longer names a public creative share leaf").toBeDefined();
    expect(row!.anonymous).toBe(true);
  });

  it("still binds 74 leaves, each with a surface and properties", () => {
    // A floor and a ceiling. A package re-vendor that moved this would change
    // what "audited" means and should be noticed here rather than absorbed.
    expect(GENERATED_INSTRUMENTATION.length).toBe(74);
    const broken = GENERATED_INSTRUMENTATION.filter(
      (row) => !row.surface || row.properties.length === 0,
    ).map((row) => row.leaf);
    expect(broken, "leaves with no surface or no properties").toEqual([]);
  });

  it("splits into 14 leaves this plan owns and 60 it does not", () => {
    /*
     * The measured split, replacing the report's "48".
     *
     * That number matches neither the event vocabulary (one) nor either side of
     * this split, and I could not reconstruct where it came from — so it is
     * corrected to what the contract actually contains rather than explained
     * away. What matters for the acceptance item is the second figure: 60
     * leaves are outside the Meta market-ready scope and are recorded as such
     * rather than audited.
     */
    const mine = contractedSurfaces().filter(
      (surface) => surface in META_LEAF_TO_RUNTIME_SURFACE,
    );
    const outside = contractedSurfaces().filter((surface) => outOfScopeReason(surface));
    expect(mine.length).toBe(14);
    expect(outside.length).toBe(60);
    expect(mine.length + outside.length).toBe(contractedSurfaces().length);
  });
});

describe("every contracted surface is classified, exactly once", () => {
  it("leaves none unaccounted for", () => {
    const unclassified = contractedSurfaces().filter(
      (surface) => !(surface in META_LEAF_TO_RUNTIME_SURFACE) && !outOfScopeReason(surface),
    );
    expect(
      unclassified,
      "contracted surfaces that are neither this plan's nor recorded as outside it",
    ).toEqual([]);
  });

  it("never puts one in both sets", () => {
    const both = Object.keys(META_LEAF_TO_RUNTIME_SURFACE).filter((surface) =>
      outOfScopeReason(surface),
    );
    expect(both, "surfaces claimed as this plan's AND excused as outside it").toEqual([]);
  });

  it("claims no leaf the contract does not have", () => {
    const contracted = new Set(contractedSurfaces());
    const invented = Object.keys(META_LEAF_TO_RUNTIME_SURFACE).filter(
      (surface) => !contracted.has(surface),
    );
    expect(invented, "leaves this file claims that the package does not name").toEqual([]);
  });

  it("gives every exclusion a reason worth reading", () => {
    for (const entry of OUT_OF_PLAN_SCOPE) {
      expect(entry.why.length, `${entry.prefix} is excused with nothing`).toBeGreaterThan(15);
    }
  });
});

describe("every Meta surface can actually emit", () => {
  it("maps every registry surface to an instrumentation name", () => {
    /*
     * The emitter resolves a pathname through the WP2 registry and then through
     * this map, and a surface missing from the map emits NOTHING — deliberately,
     * rather than attributing a view to the wrong screen. That safety turns a
     * missing entry into silent under-counting, which is why it is asserted here
     * rather than left to be noticed in a dashboard six weeks later.
     */
    const missing = META_SURFACES.filter(
      (surface) => !INSTRUMENTATION_SURFACE_BY_SURFACE_ID[surface.surfaceId],
    ).map((surface) => surface.surfaceId);
    expect(missing, "Meta surfaces with no instrumentation name").toEqual(
      Object.keys(KNOWN_NON_EMITTING),
    );
  });

  it("explains the one that does not, and lets it be exactly one", () => {
    for (const [surfaceId, why] of Object.entries(KNOWN_NON_EMITTING)) {
      expect(META_SURFACES.some((surface) => surface.surfaceId === surfaceId)).toBe(true);
      expect(why.length, `${surfaceId} is excused with nothing`).toBeGreaterThan(60);
    }
    expect(Object.keys(KNOWN_NON_EMITTING)).toHaveLength(1);
  });

  it("only emits names the sink's allowlist accepts", () => {
    const allowed = new Set<string>(PRODUCT_INSTRUMENTATION_SURFACES);
    const rejected = Object.entries(INSTRUMENTATION_SURFACE_BY_SURFACE_ID)
      .filter(([, surface]) => !allowed.has(surface))
      .map(([surfaceId, surface]) => `${surfaceId} → ${surface}`);
    expect(rejected, "names the runtime allowlist would refuse").toEqual([]);
  });

  it("collapses only the leaves this file admits to collapsing", () => {
    /*
     * The gap, held where it can be read.
     *
     * Eight contracted Creative Studio leaves share one runtime name, so per-tab
     * adoption is not readable from the emitted data. Closing that means
     * narrowing `PRODUCT_INSTRUMENTATION_SURFACES`, which is a stored column's
     * vocabulary — a migration with data implications rather than a local edit,
     * and out of scope for a phase with no deployment authorization.
     *
     * Asserted exactly so the collapse cannot grow quietly: a ninth leaf joining
     * `creative_studio`, or a Meta surface losing its own name, fails here.
     */
    const collapsed = new Map<string, string[]>();
    for (const [leaf, runtime] of Object.entries(META_LEAF_TO_RUNTIME_SURFACE)) {
      collapsed.set(runtime, [...(collapsed.get(runtime) ?? []), leaf]);
    }
    const shared = [...collapsed.entries()]
      .filter(([, leaves]) => leaves.length > 1)
      .map(([runtime, leaves]) => `${runtime}: ${leaves.sort().join(", ")}`);

    expect(shared).toEqual([
      "creative_studio: creative_briefs, creative_copies, creative_detail, creative_inbox, creative_landing_pages, creative_performance, creative_shares, share_creative",
    ]);
  });
});
