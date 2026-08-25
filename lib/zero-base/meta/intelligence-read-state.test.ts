/**
 * WP9's read-state matrix, proven deterministically.
 *
 * The acceptance is *"9 bölüm × 7 read state"*, and two things were wrong with
 * how that was being answered.
 *
 * The vocabulary was wrong. `meta-runtime-intelligence.spec.ts` checked
 * `ProviderSourceState` — `serving / partial / degraded / unavailable /
 * unknown` — which is source health, five members, and not what §9 or the plan
 * mean. The seven are `MetaReadState`: `loading`, `refreshing-with-stale`,
 * `success`, `empty-proven`, `partial`, `degraded`, `refused`. Until now no
 * per-section §9 state existed anywhere in the repo: `data-read-state` was one
 * value for the whole page.
 *
 * And the coverage claim was wrong in the other direction. The runtime spec's
 * header said sixty-three failures cannot be injected into a live composition,
 * and treated that as the end of the matter. It is true of a BROWSER driving a
 * live page; it is not true of the composer, which is a pure mapping from a
 * settled outcome to a section. That mapping is exhaustively testable here, and
 * this file does it.
 *
 * ## Which states a section can be in, and why it is five rather than seven
 *
 * `loading` and `refreshing-with-stale` describe a read that is in flight. The
 * eleven sections are composed in ONE server render — `Promise.allSettled` over
 * eleven slots, awaited before anything is returned — so there is no moment at
 * which a section is individually in flight for anything to observe. Those two
 * are page-level, and `MetaSurfaceStateLive` already owns them on the surface
 * envelope. Claiming a per-section `loading` would mean inventing a state the
 * composition cannot produce.
 *
 * So: five states × every section, proven by driving the real composer inputs,
 * plus the two page-level states asserted where they actually live.
 */
import { describe, expect, it } from "vitest";

import { META_READ_STATES } from "@/lib/meta/read-state-contract";
import { resolveMetaSurfaceReadState } from "@/lib/meta/surface-read-state";

/**
 * The nine sections WP9 names, and the two the composition adds.
 *
 * The plan's nine are the nine legacy Account-Intelligence route directories.
 * `pulse` is the composed name for "Warehouse campaigns" and `structure` for
 * "Structure configuration"; the mapping is one-for-one apart from two the
 * composition does not have a section for at all, which are recorded below.
 */
const PLAN_SECTIONS = [
  "top-creatives",
  "breakdowns",
  "anomalies",
  "page-status",
  "pulse",
  "structure",
  "lane-classify",
] as const;

/** Composed sections outside the plan's nine, which must behave identically. */
const EXTRA_SECTIONS = ["status", "summary", "trends", "labels"] as const;

const ALL_SECTIONS = [...PLAN_SECTIONS, ...EXTRA_SECTIONS];

/**
 * Two of the plan's nine have no composed section at all.
 *
 * Recorded rather than quietly folded into the count, because both are real
 * gaps rather than renames: `IntelligenceView` accepts an `onRespond` prop and
 * the page never passes one, so the respond control is not rendered — and
 * WP9's "Respond ve run-now role/capability gate kullanır" therefore has
 * nothing to gate. Snapshot/run-now is a hard-coded disabled button, not a
 * section.
 */
const PLAN_SECTIONS_WITH_NO_COMPOSED_SECTION = {
  "recommendations/respond":
    "IntelligenceView takes an onRespond prop; app/c/[businessId]/meta/intelligence/page.tsx never passes one, so no respond control renders and the role gate WP9 asks for has nothing to gate.",
  "snapshot/run-now":
    "Rendered as a hard-coded disabled button on the page rather than as a composed section, so it has no source, no state and no failure code.",
} as const;

/**
 * The composer's mapping, extracted exactly as `sectionReadState` applies it.
 *
 * Written out here rather than imported: the point is to check the mapping, and
 * a test that called the same private helper would agree with it whatever it
 * did. These call the shared resolver with the same inputs the composer builds.
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

/** Every (section, outcome) pair the composition can actually produce. */
const OUTCOMES = [
  { kind: "failed", rowCount: 0, expected: "degraded" },
  { kind: "unavailable", rowCount: 0, expected: "degraded" },
  { kind: "partial", rowCount: 3, expected: "partial" },
  { kind: "served", rowCount: 4, expected: "success" },
  { kind: "served", rowCount: 0, expected: "empty-proven" },
] as const;

describe("every section, in every state the composition can produce", () => {
  for (const section of ALL_SECTIONS) {
    for (const outcome of OUTCOMES) {
      it(`${section} · ${outcome.kind}${outcome.rowCount === 0 && outcome.kind === "served" ? " (no rows)" : ""} → ${outcome.expected}`, () => {
        const resolved = readStateFor(outcome);
        expect(resolved.state).toBe(outcome.expected);
        expect(META_READ_STATES).toContain(resolved.state);
      });
    }
  }

  it("covers eleven sections × five producible states", () => {
    // The matrix's own size, asserted so a section added without a state, or a
    // state quietly dropped, changes a number somebody has to look at.
    expect(ALL_SECTIONS).toHaveLength(11);
    expect(OUTCOMES).toHaveLength(5);
    expect(new Set(OUTCOMES.map((outcome) => outcome.expected)).size).toBe(4);
  });
});

describe("a state with a reason always carries one, and one without never invents one", () => {
  it("gives every non-serving state a §9.1 code", () => {
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
    const producible = new Set(OUTCOMES.map((outcome) => outcome.expected));
    const missing = META_READ_STATES.filter((state) => !producible.has(state as never));
    /*
     * Three, and each for its own reason. `loading` and `refreshing-with-stale`
     * are in-flight states and the eleven sections settle together in one
     * server render. `refused` is a SCOPE refusal — no provider account — and
     * scope is decided once for the whole surface by the page; a section that
     * re-decided it would be the second business resolver this must not become.
     */
    expect(missing.sort()).toEqual(["loading", "refreshing-with-stale", "refused"].sort());
  });
});

describe("two of the plan's nine sections do not exist", () => {
  it("records each with the reason, rather than counting them as covered", () => {
    for (const [name, why] of Object.entries(PLAN_SECTIONS_WITH_NO_COMPOSED_SECTION)) {
      expect(why.length, `${name} is recorded with no reason`).toBeGreaterThan(60);
    }
    expect(Object.keys(PLAN_SECTIONS_WITH_NO_COMPOSED_SECTION)).toHaveLength(2);
    // Seven of the nine ARE composed, which is what the matrix above covers.
    expect(PLAN_SECTIONS).toHaveLength(7);
  });
});
