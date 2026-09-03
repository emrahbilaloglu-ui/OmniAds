import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  COVERAGE_BLOCKERS,
  GATE_STAGES,
  POLICY_LADDER_PERCENT,
  PROPOSAL_SAMPLE_LIMIT,
  buildFunnel,
  createConditionalAccumulator,
  deterministicProposalSample,
  proposalSampleKey,
  tallyBlockers,
} from "@/scripts/audits/d080b-meta-budget-policy-simulation";

/**
 * D083 Correction 5: the D080B verifier must stay under the 2 GiB process
 * ceiling. It got there by never materialising a whole-package canonical string
 * and never copying or flattening the 247,050-proposal set.
 *
 * A resident-set assertion inside a test process would be flaky and would
 * measure Vitest as much as the verifier, so the ceiling itself is proven by
 * the measured fresh-process acceptance command. What is asserted here is the
 * architecture that makes it hold, and the exact equivalence of the bounded
 * implementations with the unbounded ones they replaced.
 */

/**
 * Comments are stripped before any shape assertion. The doc comments here
 * deliberately quote the removed patterns to explain why they were removed;
 * matching those would make the contract fail on its own documentation, and
 * would also let real code hide inside a comment.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const VERIFIER_SOURCE = stripComments(
  readFileSync(resolve("scripts/audits/d080b-meta-budget-policy-simulation.ts"), "utf8"),
);
const verifierBody = (() => {
  const start = VERIFIER_SOURCE.indexOf("export function verifyArtifact(");
  expect(start, "verifyArtifact must exist").toBeGreaterThan(-1);
  const end = VERIFIER_SOURCE.indexOf("\nexport function ", start + 1);
  return VERIFIER_SOURCE.slice(start, end === -1 ? undefined : end);
})();

describe("the memory-safe verifier architecture cannot silently regress", () => {
  it("never compares two whole canonical strings", () => {
    // `canonicalJson(a) !== canonicalJson(b)` builds two complete strings of a
    // large structure to decide one boolean. Comparisons go through
    // `canonicalDigest`, whose equivalence is proved in canonical-digest.test.ts.
    const paired = verifierBody.match(/canonicalJson\([^)]*\)\s*!==\s*canonicalJson\(/g) ?? [];
    expect(paired, `found ${paired.length} whole-string comparisons`).toEqual([]);
    expect(verifierBody).toMatch(/canonicalDigest\(/);
  });

  it("hashes the analysis by streaming digest, not by one canonical string", () => {
    const analysisHash = (() => {
      const start = VERIFIER_SOURCE.indexOf("export function analysisHashOf(");
      expect(start).toBeGreaterThan(-1);
      return VERIFIER_SOURCE.slice(start, VERIFIER_SOURCE.indexOf("\n}", start));
    })();
    // This one call built a single canonical string over all 247,050 proposals
    // and was, alone, enough to cross the ceiling.
    expect(analysisHash).toContain("canonicalDigest(");
    expect(analysisHash).not.toContain("sha256Canonical(");
    expect(analysisHash).toContain("proposals: analysis.proposals");
  });

  it("counts blockers without flattening the proposal set", () => {
    expect(VERIFIER_SOURCE).not.toMatch(/flatMap\(\s*\(p\)\s*=>\s*p\.blockers\s*\)\s*\)/);
    expect(verifierBody).toContain("tallyBlockers(");
  });

  it("samples proposals without copying or sorting the whole set", () => {
    const sample = (() => {
      const start = VERIFIER_SOURCE.indexOf("export function deterministicProposalSample(");
      expect(start).toBeGreaterThan(-1);
      return VERIFIER_SOURCE.slice(start, VERIFIER_SOURCE.indexOf("\n}", start));
    })();
    expect(sample).not.toContain("[...proposals]");
    expect(sample).not.toContain(".sort(");
    expect(sample).not.toContain(".filter(");
    expect(sample).toContain("boundedSmallest(PROPOSAL_SAMPLE_LIMIT)");
  });

  it("keeps the streaming digest bounded by subtree size, not by entry count", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    // Counting entries at one level called a five-key root holding 247,050
    // proposals "small". The bound must be over nodes in the subtree.
    expect(shared).toContain("provablyInertAndSmall(");
    expect(shared).toContain("CANONICAL_SUBTREE_NODES");
    expect(shared).not.toContain("CANONICAL_STREAM_THRESHOLD");
  });

  it("probes by descriptor, so the fast path executes no user code", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    const probe = shared.slice(
      shared.indexOf("function provablyInertAndSmall("),
      shared.indexOf("function streamValue("),
    );
    expect(probe.length).toBeGreaterThan(200);
    // Correction 7: reading a value through an accessor during the size probe
    // ran the getter once for the probe and once for serialisation, which
    // changed the digest for any getter that does not repeat itself.
    expect(probe).toContain("Object.getOwnPropertyDescriptor(");
    expect(probe).toContain('"value" in descriptor');
    // No indexed or keyed value read anywhere in the probe.
    expect(probe).not.toMatch(/entry\[[^\]]+\]/);
    expect(probe).not.toMatch(/\.toJSON\b(?!InChain)/);
    // The toJSON question is answered from descriptors, never by reading it.
    expect(shared).toContain("function toJsonInChain(");
    expect(shared).toContain('Object.getOwnPropertyDescriptor(cursor, "toJSON")');
  });

  it("treats a callable object as an object for toJSON", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    expect(shared).toContain("function acceptsToJson(");
    expect(shared).toContain('kind === "object" || kind === "function" || kind === "bigint"');
  });

  it("does not re-serialise the raw value on the root failure path", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    const digest = shared.slice(
      shared.indexOf("export function canonicalDigest("),
      shared.indexOf("function acceptsToJson("),
    );
    // Feeding `canonicalJson(value)` to the hash here invoked a root `toJSON` a
    // second time before throwing.
    expect(digest).not.toContain("canonicalJson(value)");
    expect(digest).toContain("hash.update(undefined as unknown as string)");
  });

  it("refuses proxies and cycles rather than digesting them differently", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    expect(shared).toContain("function refuseProxy(");
    expect(shared).toContain("if (isProxy(raw)) refuseProxy();");
    // Correction 8: a Proxy *returned by* toJSON slipped past the raw check and
    // reached the replacer, firing traps the contract said never fired.
    expect(shared).toContain("if (isProxy(value)) refuseProxy();");
    // Cycles are tracked on the raw containers; the replacer copies every
    // object level, so transformed values would never repeat.
    expect(shared).toContain("ancestors.add(raw)");
    expect(shared).toContain('throw new TypeError("Converting circular structure to JSON")');
  });

  it("proves a cycle only where ancestry can prove one, and bounds the rest", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    // Correction 8: a repeated raw object whose `toJSON` returns a string, or a
    // fresh object, is a finite program. Ancestry proves recursion only when no
    // `toJSON` intervened, so the guard is conditioned on that.
    expect(shared).toContain("const provesCycle = !usedToJson && isWalkableContainer(entry) && isWalkableContainer(raw);");
    // Correction 9: the flag lives on a per-digest context, so a nested
    // synchronous re-entry cannot overwrite the outer call's state.
    expect(shared).toContain("const usedToJson = ctx.usedToJson;");
    expect(shared).toContain("ctx.usedToJson = true;");
    expect(shared).not.toContain("lastTransformUsedToJson");
    // And everything ancestry cannot decide is bounded by depth, with an error
    // that says depth rather than falsely claiming a cycle.
    expect(shared).toContain("CANONICAL_MAX_DEPTH");
    expect(shared).toContain("maximum serialisation depth");
    const depthError = shared.slice(
      shared.indexOf("exceeded the maximum serialisation depth"),
      shared.indexOf("exceeded the maximum serialisation depth") + 300,
    );
    expect(depthError).not.toContain("circular");
  });

  it("splits serialisation at each position instead of trusting canonicalJson", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    // Correction 6: a streamed child must get `toJSON(key)` and the replacer
    // applied at its own position, and the whole-subtree fast path may only be
    // taken where no `toJSON` exists to be invoked twice or with the wrong key.
    expect(shared).toContain("function transformAt(");
    expect(shared).toContain("toJson as (k: string) => unknown).call(value, key)");
    // Correction 7 moved both call sites into `streamChild`, which applies the
    // transformation once per position and decides omission or null there.
    expect(shared).toContain("function streamChild(");
    expect(shared).toContain("streamChild(value[i], String(i)");
    expect(shared).toContain("const raw = (value as Record<string, unknown>)[key];");
    expect(shared).toContain("const entry = transformAt(raw, key, ctx);");
    // C6 asked a combined shape object; C7 folded both conditions — small
    // enough, and provably free of anything whose serialisation could observe
    // a second read — into one descriptor-based predicate.
    expect(shared).toContain("provablyInertAndSmall(value, CANONICAL_SUBTREE_NODES)");
    expect(shared).not.toContain("carriesToJson");
  });

  it("keeps one replacer, so canonicalJson and canonicalDigest cannot drift", () => {
    const shared = stripComments(
      readFileSync(resolve("scripts/audits/d080-meta-budget-edit-evidence.ts"), "utf8"),
    );
    expect(shared).toContain("function canonicalReplacer(");
    // `canonicalJson` must delegate rather than inline a second copy of the
    // sort, and the digest must use the same function.
    expect(shared).toMatch(/canonicalJson[\s\S]{0,200}canonicalReplacer\(entry\)/);
    expect(shared).toContain("return canonicalReplacer(value);");
    // The replacer's distinguishing guard. Other `Object.fromEntries` calls in
    // this module build unrelated maps; a second copy of the *replacer* is what
    // would let the two serialisers drift, and it would carry this guard.
    const replacerCopies = shared.match(/!Array\.isArray\(entry\)/g) ?? [];
    expect(replacerCopies.length, "exactly one canonical replacer").toBe(1);
  });
});

describe("the bounded implementations equal the unbounded ones they replaced", () => {
  type Sampleable = Parameters<typeof deterministicProposalSample>[0][number];

  /** Exactly the pre-Correction-5 implementation, kept as the reference. */
  const unboundedSample = (proposals: Sampleable[]): Sampleable[] => {
    const ordered = [...proposals].sort((a, b) =>
      proposalSampleKey(a).localeCompare(proposalSampleKey(b)),
    );
    return [
      ...ordered.filter((p) => p.eligibility === "eligible"),
      ...ordered.filter((p) => p.eligibility !== "eligible"),
    ].slice(0, PROPOSAL_SAMPLE_LIMIT);
  };

  const make = (i: number, over: Partial<Sampleable> = {}): Sampleable =>
    ({
      originDate: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      providerAccountId: `act_${1000 + (i % 7)}`,
      entityGrain: i % 2 === 0 ? "campaign" : "adset",
      entityId: `e-${String(i % 97).padStart(3, "0")}`,
      policyDirection: i % 3 === 0 ? "increase" : "decrease",
      policyPercent: [5, 10, 20][i % 3],
      eligibility: i % 5 === 0 ? "eligible" : i % 5 === 1 ? "not_determinable" : "blocked",
      blockers: i % 5 === 0 ? [] : [`gate_${i % 4}`, `gate_${i % 3}`],
      ...over,
    }) as unknown as Sampleable;

  const shapes: Array<[string, Sampleable[]]> = [
    ["empty", []],
    ["one", [make(0)]],
    ["fewer than the limit", Array.from({ length: 37 }, (_, i) => make(i))],
    ["exactly the limit", Array.from({ length: PROPOSAL_SAMPLE_LIMIT }, (_, i) => make(i))],
    ["just over the limit", Array.from({ length: PROPOSAL_SAMPLE_LIMIT + 1 }, (_, i) => make(i))],
    ["far over the limit", Array.from({ length: 5_000 }, (_, i) => make(i))],
    [
      "all eligible",
      Array.from({ length: 900 }, (_, i) => make(i, { eligibility: "eligible" } as Partial<Sampleable>)),
    ],
    [
      "none eligible",
      Array.from({ length: 900 }, (_, i) => make(i, { eligibility: "blocked" } as Partial<Sampleable>)),
    ],
    [
      "every key identical, so only arrival order can break the tie",
      Array.from({ length: 700 }, (_, i) =>
        make(0, { eligibility: i % 2 === 0 ? "eligible" : "blocked" } as Partial<Sampleable>),
      ),
    ],
    [
      "keys that localeCompare orders differently from codepoints",
      Array.from({ length: 400 }, (_, i) =>
        make(i, { entityId: ["a", "A", "á", "_a", "1a", "B"][i % 6] } as Partial<Sampleable>),
      ),
    ],
  ];

  it.each(shapes)("produces the identical sample for %s", (_label, proposals) => {
    const expected = unboundedSample(proposals);
    const actual = deterministicProposalSample(proposals);
    // Identity, not just equality: the sample must be the same rows in the same
    // order, which is what the published `proposalSample` is compared against.
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) expect(actual[i]).toBe(expected[i]);
  });

  it("counts blockers exactly as flattening then tallying did", () => {
    const proposals = Array.from({ length: 3_000 }, (_, i) => make(i));
    const flattened = proposals.flatMap((p) => p.blockers as string[]);
    const reference: Record<string, number> = {};
    for (const b of flattened) reference[b] = (reference[b] ?? 0) + 1;
    const expected = Object.fromEntries(
      Object.entries(reference).sort(([a], [b]) => a.localeCompare(b)),
    );
    const actual = tallyBlockers(proposals as Array<{ blockers: readonly string[] }>);
    expect(actual).toEqual(expected);
    // Key order is part of the canonical form, so it must match too.
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(Object.keys(actual).length).toBeGreaterThan(0);
  });
});

/**
 * D083 Correction 9: the conditional lane is aggregated online.
 *
 * It used to be a second array of 247,050 `{ ...p }` spread copies, each with a
 * freshly built `reasons` array nothing read, walked a dozen times afterwards.
 * That was the driver behind a whole-suite peak of 2,083,568 KiB — 13 MiB under
 * the ceiling. These tests guard the shape and prove the outputs are identical
 * to the array-based implementation they replaced.
 */
describe("the conditional lane never materialises a second proposal array", () => {
  const simulation = (() => {
    const start = VERIFIER_SOURCE.indexOf("function runPolicySimulation(");
    expect(start, "runPolicySimulation must exist").toBeGreaterThan(-1);
    const end = VERIFIER_SOURCE.indexOf("\nexport function ", start);
    return VERIFIER_SOURCE.slice(start, end === -1 ? undefined : end);
  })();

  it("aggregates online instead of collecting rows", () => {
    expect(simulation).toContain("createConditionalAccumulator(ctx.origins)");
    expect(simulation).toContain("conditionalLaneAccumulator.accept(");
    // The exact shapes that made it expensive.
    expect(simulation).not.toContain("conditional.push(");
    expect(simulation).not.toContain("const conditional: ");
    expect(simulation).not.toMatch(/\{\s*\.\.\.p,/);
    expect(simulation).not.toContain(".flatMap(");
    // And no second full pass over a per-proposal collection.
    expect(simulation).not.toMatch(/conditional\.(filter|map|reduce)\(/);
  });

  it("keeps the accumulator's state bounded by groups, not by proposals", () => {
    const accumulator = VERIFIER_SOURCE.slice(
      VERIFIER_SOURCE.indexOf("export function createConditionalAccumulator("),
      VERIFIER_SOURCE.indexOf("export interface ConditionalRecord"),
    );
    expect(accumulator.length).toBeGreaterThan(500);
    // No growing list of rows anywhere in the accumulator.
    expect(accumulator).not.toMatch(/:\s*ConditionalRecord\[\]/);
    expect(accumulator).not.toMatch(/\.push\(p\)/);
    expect(accumulator).not.toContain("[...rows]");
    // Counters and grouped counters only, plus one bounded key set whose
    // published value is its size.
    expect(accumulator).toContain("new Map<string, GroupCounts>");
    expect(accumulator).toContain("cohortEntityOrigins.size");
  });

  it("still refuses a full-package canonical string anywhere in the module", () => {
    expect(VERIFIER_SOURCE).not.toContain("sha256Canonical({ body, sectionHashes })");
    expect(VERIFIER_SOURCE).toContain("canonicalDigest({ body, sectionHashes })");
  });
});

describe("the online conditional lane equals the array implementation it replaced", () => {
  type Rec = Parameters<ReturnType<typeof createConditionalAccumulator>["accept"]>[0];

  const origins = [
    { origin: "2026-08-01", fold: 0 },
    { origin: "2026-08-08", fold: 1 },
    { origin: "2026-08-15", fold: 2 },
  ] as unknown as Parameters<typeof createConditionalAccumulator>[0];

  /** Exactly the pre-Correction-9 aggregation, kept as the reference. */
  const referenceAggregate = (rows: Rec[]) => {
    const byOf = (subset: Rec[], keyOf: (p: Rec) => string) => {
      const out: Record<string, { eligible: number; blocked: number; not_determinable: number; total: number }> = {};
      for (const p of subset) {
        const k = keyOf(p);
        out[k] ??= { eligible: 0, blocked: 0, not_determinable: 0, total: 0 };
        out[k][p.eligibility] += 1;
        out[k].total += 1;
      }
      return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    };
    const eligibleRows = rows.filter((p) => p.eligibility === "eligible");
    const money = [...GATE_STAGES[1]!.codes, ...GATE_STAGES[3]!.codes] as readonly string[];
    const cohort = rows.filter((p) => !p.blockers.some((b) => (COVERAGE_BLOCKERS as readonly string[]).includes(b)));
    const perRung = POLICY_LADDER_PERCENT.map((pct) => ({
      percent: pct,
      increaseBlocked: rows.filter((p) => p.policyPercent === pct && p.policyDirection === "increase" && p.eligibility !== "eligible").length,
      decreaseBlocked: rows.filter((p) => p.policyPercent === pct && p.policyDirection === "decrease" && p.eligibility !== "eligible").length,
    }));
    const foldOf = new Map(
      (origins as unknown as Array<{ origin: string; fold: number }>).map((o) => [o.origin, o.fold]),
    );
    return {
      denominator: rows.length,
      eligible: eligibleRows.length,
      grossRawExposure: eligibleRows.reduce((s, p) => s + Math.abs(p.rawDelta ?? 0), 0),
      byPolicyDelta: byOf(rows, (p) => `${p.policyDirection}_${p.policyPercent}`),
      byBusiness: byOf(rows, (p) => p.business),
      byOwnerMode: byOf(rows, (p) => p.ownerMode ?? "unobserved"),
      byGrain: byOf(rows, (p) => p.entityGrain),
      byBudgetField: byOf(rows, (p) => p.budgetField ?? "undecidable"),
      byFold: byOf(rows, (p) => `fold_${foldOf.get(p.originDate) ?? 0}`),
      blockerCensus: tallyBlockers(rows),
      worstCaseSimultaneousByOrigin: Object.fromEntries(
        [...new Set(eligibleRows.map((p) => p.originDate))].sort().map((o) => [
          o, eligibleRows.filter((p) => p.originDate === o).length,
        ]),
      ),
      concentrationByAccount: tallyBlockers(
        eligibleRows.map((p) => ({ blockers: [p.providerAccountId] })),
      ),
      funnel: buildFunnel(rows),
      increaseCensus: tallyBlockers(rows, (p) => p.policyDirection === "increase"),
      decreaseCensus: tallyBlockers(rows, (p) => p.policyDirection === "decrease"),
      increaseSurviving: rows.filter((p) => p.policyDirection === "increase" && !p.blockers.some((b) => money.includes(b))).length,
      decreaseSurviving: rows.filter((p) => p.policyDirection === "decrease" && !p.blockers.some((b) => money.includes(b))).length,
      perRung,
      rungsAreDistinguishable: new Set(perRung.map((r) => `${r.increaseBlocked}|${r.decreaseBlocked}`)).size > 1,
      cohort: {
        size: cohort.length,
        entityOrigins: new Set(cohort.map((p) => `${p.originDate}|${p.providerAccountId}|${p.entityId}`)).size,
        byPolicyDelta: byOf(cohort, (p) => `${p.policyDirection}_${p.policyPercent}`),
        byOwnerMode: byOf(cohort, (p) => p.ownerMode ?? "unobserved"),
        byBusiness: byOf(cohort, (p) => p.business),
        remainingBlockers: tallyBlockers(cohort),
      },
    };
  };

  const make = (i: number, over: Partial<Rec> = {}): Rec => {
    const allCodes = GATE_STAGES.flatMap((g) => g.codes as readonly string[]);
    const blockers = i % 4 === 0 ? [] : [allCodes[i % allCodes.length]!, allCodes[(i * 3) % allCodes.length]!];
    return {
      business: ["IwaStore", "Grandmix", "Bilsem Zeka", "ünlü", "A", "a"][i % 6],
      providerAccountId: `act_${1000 + (i % 5)}`,
      entityGrain: i % 2 === 0 ? "campaign" : "adset",
      entityId: `e-${i % 41}`,
      originDate: ["2026-08-01", "2026-08-08", "2026-08-15", "2026-07-31"][i % 4],
      policyDirection: i % 3 === 0 ? "increase" : "decrease",
      policyPercent: POLICY_LADDER_PERCENT[i % POLICY_LADDER_PERCENT.length]!,
      ownerMode: i % 7 === 0 ? null : ["campaign_owned", "adset_owned"][i % 2],
      budgetField: i % 5 === 0 ? null : ["daily", "lifetime"][i % 2],
      evidenceLane: "retrospective_finalized_conditional",
      eligibility: blockers.length === 0 ? "eligible" : i % 5 === 1 ? "not_determinable" : "blocked",
      blockers,
      rawDelta: i % 6 === 0 ? null : (i % 2 === 0 ? 1 : -1) * (i % 997),
      ...over,
    } as unknown as Rec;
  };

  const shapes: Array<[string, Rec[]]> = [
    ["empty", []],
    ["one row", [make(0)]],
    ["a few hundred mixed rows", Array.from({ length: 400 }, (_, i) => make(i))],
    ["several thousand mixed rows", Array.from({ length: 5_000 }, (_, i) => make(i))],
    ["all eligible", Array.from({ length: 300 }, (_, i) => make(i, { blockers: [], eligibility: "eligible" } as Partial<Rec>))],
    ["none eligible", Array.from({ length: 300 }, (_, i) => make(i, { eligibility: "blocked" } as Partial<Rec>))],
    ["one origin only", Array.from({ length: 300 }, (_, i) => make(i, { originDate: "2026-08-08" } as Partial<Rec>))],
    ["origins outside the plan, so fold falls back to 0", Array.from({ length: 120 }, (_, i) => make(i, { originDate: "2025-01-01" } as Partial<Rec>))],
    ["null owner mode and budget field throughout", Array.from({ length: 200 }, (_, i) => make(i, { ownerMode: null, budgetField: null } as Partial<Rec>))],
    ["keys that localeCompare orders differently from codepoints", Array.from({ length: 300 }, (_, i) => make(i, { business: ["a", "A", "á", "_a", "1a", "B"][i % 6] } as Partial<Rec>))],
  ];

  it.each(shapes)("produces byte-identical aggregates for %s", (_label, rows) => {
    const accumulator = createConditionalAccumulator(origins);
    for (const row of rows) accumulator.accept(row);
    const online = accumulator.finish();
    const reference = referenceAggregate(rows);
    // Canonical bytes, so key order counts too, not just deep equality.
    expect(canonicalJson(online)).toBe(canonicalJson(reference));
  });

  it("is not vacuous: a single changed row changes the aggregate", () => {
    const rows = Array.from({ length: 200 }, (_, i) => make(i));
    const one = createConditionalAccumulator(origins);
    for (const row of rows) one.accept(row);
    const mutated = [...rows];
    mutated[7] = make(7, { eligibility: "eligible", blockers: [] } as Partial<Rec>);
    const two = createConditionalAccumulator(origins);
    for (const row of mutated) two.accept(row);
    expect(canonicalJson(one.finish())).not.toBe(canonicalJson(two.finish()));
  });
});
