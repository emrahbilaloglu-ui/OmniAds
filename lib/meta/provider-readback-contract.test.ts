/**
 * D085 — the independent read-back classifier, proved by mocked contracts.
 *
 * These tests exist because a live write is forbidden and would prove nothing
 * anyway: the whole point of the classifier is that it does not trust a
 * provider's own reply. Every branch is therefore driven by an explicit
 * (attempt, fresh-read) pair, and the decisive test is the first one — a
 * provider "success" followed by a fresh read that disagrees.
 */

import { describe, expect, it } from "vitest";

import {
  META_PROVIDER_READBACK_CONTRACT,
  PREFLIGHT_MAX_AGE_SECONDS,
  PREFLIGHT_PROJECTION_FIELDS,
  classifyReadback,
  comparePreflight,
  readbackFingerprint,
  strictCalendarDay,
  strictInstant,
  validateProjection,
  type PreflightAttemptOutcome,
  type PreflightProjection,
  type PreflightProjectionField,
} from "@/lib/meta/provider-readback-contract";

const BASE: PreflightProjection = {
  providerAccountId: "act_1087566732415606",
  entityGrain: "adset",
  entityId: "23851234567890123",
  parentCampaignId: "23859876543210987",
  budgetField: "daily_budget",
  budgetMinorUnits: 10_000,
  ownerMode: "adset_budget",
  effectiveStatus: "ACTIVE",
  scheduleStart: null,
  scheduleEnd: null,
  optimizationGoal: "OFFSITE_CONVERSIONS",
};

const NOW = "2026-09-01T00:00:00.000Z";
const CLOCK = { evaluatedAt: NOW };
/** A read the CALLER claims succeeded, stamped fresh unless overridden. */
const ok = (p: PreflightProjection, observedAt = NOW): PreflightAttemptOutcome => ({
  status: "succeeded", observedAt, projection: p,
});

describe("D085 — a provider success reply is never read-back proof", () => {
  it("classifies a completed write whose fresh read disagrees as definite_mismatch", () => {
    // The provider said 200 OK. The independent read says the budget is still
    // the old value. Only the read counts.
    const expected = { ...BASE, budgetMinorUnits: 12_000 };
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected,
      observed: ok({ ...BASE, budgetMinorUnits: 10_000 }),
      clock: CLOCK,
    });
    expect(verdict.classification).toBe("definite_mismatch");
    expect(verdict.provesApplied).toBe(false);
    expect(verdict.mismatchedFields).toEqual(["budgetMinorUnits"]);
  });

  it("has no parameter through which a mutation response could be passed", () => {
    // Structural: the classifier's input keys are exactly these three.
    const keys = Object.keys({
      attempt: { sent: false, why: "" },
      expected: BASE,
      observed: ok(BASE),
      clock: CLOCK,
    });
    expect(keys.sort()).toEqual(["attempt", "clock", "expected", "observed"]);
    // And `attempt` carries only whether it was sent and the transport — never
    // a provider payload.
    expect(Object.keys({ sent: true, transport: "completed" } as const).sort())
      .toEqual(["sent", "transport"]);
  });

  it("confirms only when a fresh read reproduces every projected field", () => {
    const expected = { ...BASE, budgetMinorUnits: 12_000 };
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected,
      observed: ok(expected),
      clock: CLOCK,
    });
    expect(verdict.classification).toBe("confirmed");
    expect(verdict.provesApplied).toBe(true);
    expect(verdict.rollbackPermitted).toBe(true);
  });
});

describe("D085 — ambiguous outcomes refuse rollback", () => {
  it.each([
    ["timeout with an unreadable state", { sent: true, transport: "timeout" } as const,
      { status: "failed", why: "read timed out", retryable: true } as PreflightAttemptOutcome],
    ["transport error with an unreadable state", { sent: true, transport: "transport_error" } as const,
      { status: "failed", why: "socket reset", retryable: true } as PreflightAttemptOutcome],
    ["completed write but the read is unavailable", { sent: true, transport: "completed" } as const,
      { status: "not_attempted", why: "no read tool resolved" } as PreflightAttemptOutcome],
  ])("classifies %s as ambiguous and refuses rollback", (_label, attempt, observed) => {
    const verdict = classifyReadback({ attempt, expected: BASE, observed, clock: CLOCK });
    expect(verdict.classification).toBe("ambiguous");
    expect(verdict.provesApplied).toBe(false);
    // THE SAFETY RULE: compensating blind can double-apply a write that landed.
    expect(verdict.rollbackPermitted).toBe(false);
    expect(verdict.rollbackRefusalWhy).toMatch(/double-apply|unknown/i);
  });

  it("stays ambiguous when a timeout is followed by a DIFFERENT observed state", () => {
    // The difference cannot be attributed to this write: another operator may
    // have changed it, or the write may have partially landed.
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "timeout" },
      expected: { ...BASE, budgetMinorUnits: 12_000 },
      observed: ok({ ...BASE, budgetMinorUnits: 11_000 }),
      clock: CLOCK,
    });
    expect(verdict.classification).toBe("ambiguous");
    expect(verdict.rollbackPermitted).toBe(false);
  });

  it("treats a stale read as ambiguous, not as confirmation", () => {
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected: BASE,
      observed: { status: "stale", why: "cached", observedAt: NOW, ageSeconds: PREFLIGHT_MAX_AGE_SECONDS + 1 },
      clock: CLOCK,
    });
    expect(verdict.classification).toBe("ambiguous");
    expect(verdict.rollbackPermitted).toBe(false);
  });
});

describe("D085 — no write means not_attempted, always", () => {
  it("classifies an unsent mutation as not_attempted even when the read is perfect", () => {
    // This is D085's only real state. A healthy GET is preflight evidence and
    // must never be relabelled as write success.
    const verdict = classifyReadback({
      attempt: { sent: false, why: "D085 performs no provider mutation" },
      expected: BASE,
      observed: ok(BASE),
      clock: CLOCK,
    });
    expect(verdict.classification).toBe("not_attempted");
    expect(verdict.provesApplied).toBe(false);
    expect(verdict.rollbackPermitted).toBe(false);
    expect(verdict.why).toMatch(/cannot be relabelled as write success/);
  });
});

describe("D085 — drift detection covers every projected dimension", () => {
  it.each([
    ["wrong account", { providerAccountId: "act_999" }],
    ["wrong entity", { entityId: "23859999999999999" }],
    ["wrong parent", { parentCampaignId: "23850000000000000" }],
    ["owner-mode drift", { ownerMode: "campaign_budget_optimization" as const }],
    ["status drift", { effectiveStatus: "PAUSED" }],
    ["schedule drift", { scheduleEnd: "2026-12-31" }],
    ["optimization drift", { optimizationGoal: "LINK_CLICKS" }],
    ["budget field drift", { budgetField: "lifetime_budget" as const }],
    ["grain drift", { entityGrain: "campaign" as const }],
  ])("detects %s", (_label, patch) => {
    const comparison = comparePreflight(BASE, ok({ ...BASE, ...patch } as PreflightProjection), CLOCK);
    expect(comparison.matchesBaseline).toBe(false);
    expect(comparison.driftedFields.length).toBeGreaterThan(0);
    expect(comparison.driftDetail[0]).toHaveProperty("baseline");
    expect(comparison.driftDetail[0]).toHaveProperty("observed");
  });

  it("covers every declared projection field, so none is silently unchecked", () => {
    // Non-vacuity: mutate each field in turn and require it to be caught.
    // Typed per-field mutation: the field union IS `keyof PreflightProjection`,
    // so each branch stays type-safe without a cast.
    const mutations: Record<PreflightProjectionField, PreflightProjection> = {
      providerAccountId: { ...BASE, providerAccountId: "act_changed" },
      entityGrain: { ...BASE, entityGrain: "campaign" },
      entityId: { ...BASE, entityId: "changed" },
      parentCampaignId: { ...BASE, parentCampaignId: "changed" },
      budgetField: { ...BASE, budgetField: "lifetime_budget" },
      budgetMinorUnits: { ...BASE, budgetMinorUnits: (BASE.budgetMinorUnits ?? 0) + 1 },
      ownerMode: { ...BASE, ownerMode: "campaign_budget_optimization" },
      effectiveStatus: { ...BASE, effectiveStatus: "PAUSED" },
      scheduleStart: { ...BASE, scheduleStart: "2026-01-01" },
      scheduleEnd: { ...BASE, scheduleEnd: "2026-12-31" },
      optimizationGoal: { ...BASE, optimizationGoal: "LINK_CLICKS" },
    };
    for (const field of PREFLIGHT_PROJECTION_FIELDS) {
      const comparison = comparePreflight(BASE, ok(mutations[field]), CLOCK);
      expect(comparison.driftedFields, field).toContain(field);
    }
  });

  it("never calls an unavailable read a match", () => {
    for (const outcome of [
      { status: "not_attempted", why: "x" },
      { status: "failed", why: "x", retryable: false },
      { status: "stale", why: "x", observedAt: "2026-09-01T00:00:00.000Z", ageSeconds: 999 },
    ] as PreflightAttemptOutcome[]) {
      expect(comparePreflight(BASE, outcome, CLOCK).matchesBaseline).toBe(false);
    }
  });
});

describe("D085 C1 — the contract, not the caller, decides freshness", () => {
  // Every case below starts from a read the caller CLAIMS succeeded. The first
  // pass believed that claim and returned confirmed / provesApplied.

  it("rejects a 26-year-old read that the caller called succeeded", () => {
    const comparison = comparePreflight(BASE, ok(BASE, "2000-01-01T00:00:00.000Z"), CLOCK);
    expect(comparison.claimedStatus).toBe("succeeded");
    expect(comparison.matchesBaseline).toBe(false);
    expect(comparison.fresh).toBe(false);
    expect(comparison.rejections).toContain("read_stale");
    expect(comparison.ageSeconds).toBeGreaterThan(PREFLIGHT_MAX_AGE_SECONDS);

    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected: BASE, observed: ok(BASE, "2000-01-01T00:00:00.000Z"), clock: CLOCK,
    });
    expect(verdict.classification).toBe("ambiguous");
    expect(verdict.provesApplied).toBe(false);
    expect(verdict.rollbackPermitted).toBe(false);
  });

  it("rejects a future-dated read", () => {
    const comparison = comparePreflight(BASE, ok(BASE, "2099-01-01T00:00:00.000Z"), CLOCK);
    expect(comparison.rejections).toContain("clock_in_future");
    expect(comparison.matchesBaseline).toBe(false);
    expect(comparison.ageSeconds).toBeLessThan(0);
  });

  it.each([
    ["an unparseable observedAt", "invalid"],
    ["an empty observedAt", ""],
  ])("rejects %s", (_label, observedAt) => {
    const comparison = comparePreflight(BASE, ok(BASE, observedAt), CLOCK);
    expect(comparison.rejections).toContain("clock_unparseable");
    expect(comparison.ageSeconds).toBeNull();
    expect(comparison.matchesBaseline).toBe(false);
  });

  it("rejects an unusable evaluation clock or ceiling", () => {
    expect(comparePreflight(BASE, ok(BASE), { evaluatedAt: "nope" }).rejections).toContain("clock_missing");
    expect(comparePreflight(BASE, ok(BASE), { evaluatedAt: NOW, maxAgeSeconds: 0 }).rejections).toContain("clock_missing");
    expect(comparePreflight(BASE, ok(BASE), { evaluatedAt: NOW, maxAgeSeconds: Number.NaN }).rejections).toContain("clock_missing");
  });

  it("accepts a read that is genuinely fresh", () => {
    const recent = new Date(Date.parse(NOW) - 30_000).toISOString();
    const comparison = comparePreflight(BASE, ok(BASE, recent), CLOCK);
    expect(comparison.rejections).toEqual([]);
    expect(comparison.fresh).toBe(true);
    expect(comparison.matchesBaseline).toBe(true);
    expect(comparison.ageSeconds).toBeCloseTo(30, 0);
  });
});

describe("D085 C1 — an incomplete or impossible projection never proves applied", () => {
  it("rejects the hollow projection the first pass confirmed", () => {
    const hollow: PreflightProjection = {
      ...BASE, budgetMinorUnits: null, ownerMode: "unknown",
      effectiveStatus: null, optimizationGoal: null,
    };
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected: hollow, observed: ok(hollow, "invalid"), clock: CLOCK,
    });
    expect(verdict.classification).toBe("ambiguous");
    expect(verdict.provesApplied).toBe(false);
  });

  it.each([
    ["a null amount", { budgetMinorUnits: null }],
    ["a NaN amount", { budgetMinorUnits: Number.NaN }],
    ["an infinite amount", { budgetMinorUnits: Number.POSITIVE_INFINITY }],
    ["a fractional amount", { budgetMinorUnits: 12.5 }],
    ["a negative amount", { budgetMinorUnits: -100 }],
    ["an unknown owner mode", { ownerMode: "unknown" as const }],
    ["a missing status", { effectiveStatus: null }],
    ["a missing optimization goal on an ad set", { optimizationGoal: null }],
    ["a missing parent on an ad set", { parentCampaignId: null }],
    ["an empty account id", { providerAccountId: "" }],
    ["an empty entity id", { entityId: "" }],
  ])("refuses to confirm %s", (_label, patch) => {
    const p = { ...BASE, ...patch } as PreflightProjection;
    expect(validateProjection(p).complete).toBe(false);
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" }, expected: p, observed: ok(p), clock: CLOCK,
    });
    expect(verdict.classification).not.toBe("confirmed");
    expect(verdict.provesApplied).toBe(false);
  });

  it("keeps nullability only where entity semantics prove it is not required", () => {
    // A campaign has no parent and no optimization goal in this projection.
    const campaign: PreflightProjection = {
      ...BASE, entityGrain: "campaign", parentCampaignId: null, optimizationGoal: null,
      // A campaign owns its budget through CBO; inheriting the ad-set owner
      // mode is exactly the cross-grain contradiction C2 now refuses.
      ownerMode: "campaign_budget_optimization",
    };
    expect(validateProjection(campaign).complete).toBe(true);
    // ...but a campaign carrying a parent is invalid.
    expect(validateProjection({ ...campaign, parentCampaignId: "23859876543210987" }).complete).toBe(false);
    // A daily budget needs no flight; a lifetime budget does.
    expect(validateProjection({ ...BASE, budgetField: "daily_budget", scheduleStart: null, scheduleEnd: null }).complete).toBe(true);
    expect(validateProjection({ ...BASE, budgetField: "lifetime_budget", scheduleStart: null, scheduleEnd: null }).complete).toBe(false);
    expect(validateProjection({ ...BASE, budgetField: "lifetime_budget", scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01" }).complete).toBe(true);
    // A daily budget must carry NO flight at all.
    expect(validateProjection({ ...BASE, scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01" }).complete).toBe(false);
  });

  it("still reports a genuine mismatch as definite, not ambiguous", () => {
    // A fresh, complete read that simply disagrees is a real mismatch.
    const verdict = classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected: { ...BASE, budgetMinorUnits: 12_000 },
      observed: ok({ ...BASE, budgetMinorUnits: 10_000 }), clock: CLOCK,
    });
    expect(verdict.classification).toBe("definite_mismatch");
    expect(verdict.mismatchedFields).toEqual(["budgetMinorUnits"]);
  });
});

describe("D085 — read-back fingerprints are deterministic and discriminating", () => {
  it("is stable for the same projection and different for any change", () => {
    expect(readbackFingerprint(BASE)).toBe(readbackFingerprint({ ...BASE }));
    expect(readbackFingerprint(BASE)).not.toBe(
      readbackFingerprint({ ...BASE, budgetMinorUnits: 10_001 }),
    );
    expect(readbackFingerprint(BASE).startsWith(`${META_PROVIDER_READBACK_CONTRACT}:`)).toBe(true);
  });

  it("distinguishes a null from the string 'null', so a gap cannot masquerade as a value", () => {
    const withNull = { ...BASE, effectiveStatus: null };
    const withText = { ...BASE, effectiveStatus: "null" };
    expect(readbackFingerprint(withNull)).not.toBe(readbackFingerprint(withText));
  });

  it("detects a duplicate/idempotency collision as an identical fingerprint", () => {
    // Two proposals with the same projection collide by construction — which
    // is what makes the fingerprint usable as a duplicate check.
    const a = readbackFingerprint(BASE);
    const b = readbackFingerprint({ ...BASE });
    expect(a).toBe(b);
    // ...and two materially different amounts must NOT collide.
    expect(readbackFingerprint({ ...BASE, budgetMinorUnits: 90_000 })).not.toBe(a);
  });
});


describe("D085 C2 — semantically impossible projections never confirm", () => {
  // Every case starts from a read the caller CLAIMS succeeded, on a fresh clock.
  const confirmAttempt = (p: PreflightProjection) =>
    classifyReadback({
      attempt: { sent: true, transport: "completed" },
      expected: p, observed: ok(p), clock: CLOCK,
    });

  it.each([
    ["an ad set claiming ownerMode not_applicable", { ownerMode: "not_applicable" as const }],
    ["an ad set carrying a CAMPAIGN owner mode", { ownerMode: "campaign_budget_optimization" as const }],
    ["a lifetime budget with garbage flight strings", { budgetField: "lifetime_budget" as const, scheduleStart: "garbage", scheduleEnd: "also-garbage" }],
    ["a lifetime budget whose flight runs backwards", { budgetField: "lifetime_budget" as const, scheduleStart: "2026-10-01", scheduleEnd: "2026-01-01" }],
    ["a rollover date that the calendar never had", { budgetField: "lifetime_budget" as const, scheduleStart: "2026-02-30", scheduleEnd: "2026-03-15" }],
    ["a daily budget carrying a lifetime flight", { scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01" }],
    ["an unknown runtime owner mode", { ownerMode: "surprise" as never }],
    ["an unknown runtime budget field", { budgetField: "weekly_budget" as never }],
  ])("refuses %s", (_label, patch) => {
    const p = { ...BASE, ...patch } as PreflightProjection;
    expect(validateProjection(p).complete).toBe(false);
    const v = confirmAttempt(p);
    expect(v.classification).not.toBe("confirmed");
    expect(v.provesApplied).toBe(false);
    expect(v.rollbackPermitted).toBe(false);
  });

  it("keeps a CAMPAIGN projection coherent on its own terms", () => {
    const campaign: PreflightProjection = {
      ...BASE, entityGrain: "campaign", parentCampaignId: null,
      optimizationGoal: null, ownerMode: "campaign_budget_optimization",
    };
    expect(validateProjection(campaign).complete).toBe(true);
    // ...but not with an ad-set owner mode.
    expect(validateProjection({ ...campaign, ownerMode: "adset_budget" }).complete).toBe(false);
    // ...nor carrying an ad-set optimization goal.
    expect(validateProjection({ ...campaign, optimizationGoal: "LINK_CLICKS" }).complete).toBe(false);
  });

  it("accepts a well-formed forward lifetime flight", () => {
    const ok2: PreflightProjection = {
      ...BASE, budgetField: "lifetime_budget", scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01",
    };
    expect(validateProjection(ok2).complete).toBe(true);
    expect(confirmAttempt(ok2).classification).toBe("confirmed");
  });

  it("parses calendars strictly, without Date.parse rollover", () => {
    expect(strictCalendarDay("2026-02-30")).toBeNull();
    expect(strictCalendarDay("2026-13-01")).toBeNull();
    expect(strictCalendarDay("2026-00-10")).toBeNull();
    expect(strictCalendarDay("2026-1-1")).toBeNull();
    expect(strictCalendarDay("garbage")).toBeNull();
    expect(strictCalendarDay("2026-02-28")).not.toBeNull();
    expect(strictCalendarDay("2024-02-29")).not.toBeNull();  // real leap day
    expect(strictCalendarDay("2026-02-29")).toBeNull();      // not a leap year
  });
});


describe("D085 C3 — runtime identity and enums are canonical", () => {
  const confirmAttempt = (p: PreflightProjection) =>
    classifyReadback({ attempt: { sent: true, transport: "completed" }, expected: p, observed: ok(p), clock: CLOCK });

  it("refuses the exact junk projection r3 accepted", () => {
    const junk = {
      providerAccountId: "not-an-account", entityGrain: "adset", entityId: "not-an-adset",
      parentCampaignId: "not-a-campaign", budgetField: "daily_budget", budgetMinorUnits: 100,
      ownerMode: "adset_budget", effectiveStatus: "BANANA", scheduleStart: null,
      scheduleEnd: null, optimizationGoal: "BANANA",
    } as PreflightProjection;
    const v = validateProjection(junk);
    expect(v.complete).toBe(false);
    expect(v.problems.length).toBeGreaterThanOrEqual(5);
    const verdict = confirmAttempt(junk);
    expect(verdict.classification).not.toBe("confirmed");
    expect(verdict.provesApplied).toBe(false);
    expect(verdict.rollbackPermitted).toBe(false);
  });

  it.each([
    ["a malformed account id", { providerAccountId: "not-an-account" }],
    ["a bare numeric account id", { providerAccountId: "1087566732415606" }],
    ["a malformed entity id", { entityId: "not-an-adset" }],
    ["a malformed parent id", { parentCampaignId: "not-a-campaign" }],
    ["an unknown effective status", { effectiveStatus: "BANANA" }],
    ["an unknown optimization goal", { optimizationGoal: "BANANA" }],
  ])("refuses %s", (_label, patch) => {
    expect(validateProjection({ ...BASE, ...patch } as PreflightProjection).complete).toBe(false);
  });

  it("accepts canonical identity on both grains", () => {
    expect(validateProjection(BASE).complete).toBe(true);
    expect(validateProjection({
      ...BASE, entityGrain: "campaign", parentCampaignId: null,
      optimizationGoal: null, ownerMode: "campaign_budget_optimization",
    }).complete).toBe(true);
  });
});

describe("D085 C3 — one strict instant validator, no rollover", () => {
  it("rejects the impossible instant r3 called fresh", () => {
    const c = comparePreflight(BASE, ok(BASE, "2026-02-30T00:00:00.000Z"), { evaluatedAt: "2026-03-02T00:00:10.000Z" });
    expect(c.rejections).toContain("clock_unparseable");
    expect(c.fresh).toBe(false);
    expect(c.matchesBaseline).toBe(false);
    expect(c.ageSeconds).toBeNull();
  });

  it.each([
    ["a rollover day", "2026-02-30T00:00:00.000Z"],
    ["a 13th month", "2026-13-01T00:00:00.000Z"],
    ["a 25th hour", "2026-09-01T25:00:00.000Z"],
    ["a missing timezone", "2026-09-01T00:00:00.000"],
    ["a bare day", "2026-09-01"],
    ["noncanonical text", "Sept 1 2026"],
    ["an empty string", ""],
  ])("rejects %s as an instant", (_label, value) => {
    expect(strictInstant(value)).toBeNull();
  });

  it("accepts canonical instants including offsets and leap days", () => {
    expect(strictInstant("2026-09-01T00:00:00.000Z")).not.toBeNull();
    expect(strictInstant("2026-09-01T00:00:00Z")).not.toBeNull();
    expect(strictInstant("2026-09-01T02:00:00.000+02:00")).not.toBeNull();
    expect(strictInstant("2024-02-29T12:00:00.000Z")).not.toBeNull();
    expect(strictInstant("2026-02-29T12:00:00.000Z")).toBeNull();
  });

  it("never confirms from an impossible observed instant", () => {
    const v = classifyReadback({
      attempt: { sent: true, transport: "completed" }, expected: BASE,
      observed: ok(BASE, "2026-02-30T00:00:00.000Z"), clock: { evaluatedAt: "2026-03-02T00:00:10.000Z" },
    });
    expect(v.classification).toBe("ambiguous");
    expect(v.provesApplied).toBe(false);
    expect(v.rollbackPermitted).toBe(false);
  });
});
