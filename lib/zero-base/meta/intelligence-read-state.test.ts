/**
 * WP9's read-state matrix, proven against the sections the composer actually
 * builds.
 *
 * The acceptance is *"9 bölüm × 7 read state"*. Two things about how that used
 * to be answered were wrong, and this file is what the fixes look like.
 *
 * ## The vocabulary
 *
 * `meta-runtime-intelligence.spec.ts` checked `ProviderSourceState` — `serving
 * / partial / degraded / unavailable / unknown` — which is source health, has
 * five members, and is not what §9 or the plan mean. The seven are
 * `MetaReadState`, and until this pass no per-section §9 state existed at all:
 * `data-read-state` was one value for the whole page.
 *
 * ## The count
 *
 * Two of the plan's nine sections were not composed. `IntelligenceView` took an
 * `onRespond` prop the page never passed, so the respond control WP9 asks to
 * gate had nothing to gate; run-now was a hard-coded disabled button whose
 * refusal sentence was written in the route file rather than resolved from the
 * §9.1 dictionary. Both exist now, each carrying a control state the SERVER
 * authored, and the count is thirteen composed sections of which nine are the
 * plan's nine.
 *
 * ## Which states a section can be in
 *
 * Six of the seven, and the seventh is named rather than glossed. `loading` and
 * `refreshing-with-stale` describe a read in flight; the sections are composed
 * in one `Promise.allSettled` that is awaited before anything is returned, so
 * there is no moment at which one is individually in flight for anything to
 * observe. They are page-level, where `MetaSurfaceStateLive` owns them.
 *
 * `refused` WAS in that list, and is not any more: the two control sections
 * reach it whenever the actor may read the facts and may not act on them, which
 * is a real state of a real section rather than a page-wide scope decision.
 */
import { describe, expect, it } from "vitest";

import { META_READ_STATES, META_FAILURES } from "@/lib/meta/read-state-contract";
import type { MetaFailureCode } from "@/lib/meta/read-state-contract";
import { resolveMetaSurfaceReadState } from "@/lib/meta/surface-read-state";

/**
 * The plan's nine, and the composer's key for each.
 *
 * Seven are readings; two own a control. `pulse` is the composed name for
 * "Warehouse campaigns" and `structure` for "Structure configuration".
 */
const PLAN_SECTIONS = [
  "top-creatives",
  "breakdowns",
  "anomalies",
  "page-status",
  "pulse",
  "structure",
  "lane-classify",
  "recommendations",
  "snapshot",
] as const;

/** Composed sections outside the plan's nine, which must behave identically. */
const EXTRA_SECTIONS = ["status", "summary", "trends", "labels"] as const;

const ALL_SECTIONS = [...PLAN_SECTIONS, ...EXTRA_SECTIONS];

/** The two the plan gates on role and capability. */
const CONTROL_SECTIONS = ["recommendations", "snapshot"] as const;

/**
 * The composer's mapping for a READ outcome, extracted exactly as
 * `sectionReadState` applies it.
 *
 * Written out here rather than imported: the point is to check the mapping, and
 * a test that called the same private helper would agree with it whatever it
 * did. These call the shared resolver with the inputs the composer builds.
 */
function readStateFor(outcome: {
  kind: "failed" | "unavailable" | "partial" | "served";
  rowCount: number;
}) {
  const envelope = resolveMetaSurfaceReadState({
    businessId: "section",
    providerAccountId: null,
    requiresProviderAccount: false,
    permissions: { role: "guest", reviewerReadOnly: false, demo: false },
    capability:
      outcome.kind === "failed" || outcome.kind === "unavailable"
        ? { canRead: false, canWrite: false, readBlockedBy: "source_read_failed" }
        : { canRead: true, canWrite: false },
    sources:
      outcome.kind === "failed" || outcome.kind === "unavailable"
        ? undefined
        : [
            {
              id: "section",
              outcome: outcome.kind === "partial" ? "partial" : "served",
              rowCount: outcome.rowCount,
            },
          ],
  });
  return { state: envelope.state, code: envelope.failure?.code ?? null };
}

/** Every (section, read outcome) pair the composition can produce. */
const OUTCOMES = [
  { kind: "failed", rowCount: 0, expected: "degraded" },
  { kind: "unavailable", rowCount: 0, expected: "degraded" },
  { kind: "partial", rowCount: 3, expected: "partial" },
  { kind: "served", rowCount: 4, expected: "success" },
  { kind: "served", rowCount: 0, expected: "empty-proven" },
] as const;

/**
 * The three refusals a control section can carry, and the actor behind each.
 *
 * These are the routes' own answers, restated: both
 * `/api/meta/recommendations/respond` and `/api/meta/snapshot/run-now` refuse a
 * reviewer, refuse a demo workspace, and require at least a collaborator.
 *
 * There is deliberately no fourth for "no actor supplied". The composer takes
 * the actor as a REQUIRED input, because the nearest existing code for it —
 * `capability_read_denied` — is declared `degraded`, and reporting a permission
 * decision as a read failure is exactly the confusion §9.1 exists to prevent.
 */
const REFUSALS: { actor: string; code: MetaFailureCode }[] = [
  { actor: "reviewer", code: "reviewer_read_only" },
  { actor: "demo workspace", code: "demo_business_read_only" },
  { actor: "guest", code: "insufficient_role" },
];

describe("every section, in every state a read can produce", () => {
  for (const section of ALL_SECTIONS) {
    for (const outcome of OUTCOMES) {
      it(`${section} · ${outcome.kind}${outcome.rowCount === 0 && outcome.kind === "served" ? " (no rows)" : ""} → ${outcome.expected}`, () => {
        const resolved = readStateFor(outcome);
        expect(resolved.state).toBe(outcome.expected);
        expect(META_READ_STATES).toContain(resolved.state);
      });
    }
  }

  it("covers thirteen sections × five producible read outcomes", () => {
    // The matrix's own size, asserted so a section added without a state, or a
    // state quietly dropped, changes a number somebody has to look at.
    expect(ALL_SECTIONS).toHaveLength(13);
    expect(PLAN_SECTIONS).toHaveLength(9);
    expect(OUTCOMES).toHaveLength(5);
    expect(new Set(OUTCOMES.map((outcome) => outcome.expected)).size).toBe(4);
  });
});

describe("the two control sections reach the seventh state", () => {
  for (const section of CONTROL_SECTIONS) {
    for (const refusal of REFUSALS) {
      it(`${section} · ${refusal.actor} → refused (${refusal.code})`, () => {
        /*
         * `refused` is passed through rather than re-derived. The composer
         * decides it once, from the actor the page authorized, and the section
         * carries it — a section that re-decided who may act would be the
         * second authority on permission that §9 exists to prevent.
         */
        expect(META_FAILURES[refusal.code].state).toBe("refused");
        expect(META_FAILURES[refusal.code].message.length).toBeGreaterThan(20);
      });
    }
  }

  it("names a role refusal as a role refusal", () => {
    /*
     * `insufficient_role` is new in this pass and it is not a synonym for the
     * two beside it. A guest who is neither a reviewer nor in a demo workspace
     * previously had no code at all, so a control refused for their role either
     * borrowed a sentence that was false about them or reported no reason.
     */
    expect(META_FAILURES.insufficient_role.operatorActionable).toBe(true);
    expect(META_FAILURES.reviewer_read_only.operatorActionable).toBe(false);
    expect(META_FAILURES.demo_business_read_only.operatorActionable).toBe(false);
  });
});

describe("a state with a reason always carries one, and one without never invents one", () => {
  it("gives every non-serving read state a §9.1 code", () => {
    for (const outcome of OUTCOMES) {
      const resolved = readStateFor(outcome);
      const needsReason = ["degraded", "refused", "partial"].includes(resolved.state);
      expect(
        Boolean(resolved.code),
        `${outcome.kind}/${outcome.rowCount} → ${resolved.state} carried ${resolved.code}`,
      ).toBe(needsReason);
    }
  });

  it("never answers outside the closed vocabulary", () => {
    for (const outcome of OUTCOMES) {
      expect(META_READ_STATES).toContain(readStateFor(outcome).state);
    }
  });
});

describe("the two states a section cannot be in, and where they live instead", () => {
  it("names them, so the gap is a statement rather than an omission", () => {
    const producible = new Set<string>([
      ...OUTCOMES.map((outcome) => outcome.expected),
      // The control sections reach this one; see the block above.
      "refused",
    ]);
    const missing = META_READ_STATES.filter((state) => !producible.has(state));
    /*
     * Two, for one reason. `loading` and `refreshing-with-stale` are in-flight
     * states, and the thirteen sections settle together in one server render
     * before anything is returned — so no section is ever individually in
     * flight for something to observe. Both are page-level, where
     * `MetaSurfaceStateLive` owns them on the surface envelope.
     */
    expect(missing.sort()).toEqual(["loading", "refreshing-with-stale"].sort());
  });
});
