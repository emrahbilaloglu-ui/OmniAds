/**
 * The §9 resolver, held to the three distinctions it exists to protect.
 *
 * Every case here is one a surface used to get wrong by working it out inline:
 * an unreadable source rendered as an empty list, a subset presented as a
 * whole, and a screen that was never scoped presented as a screen with nothing
 * on it.
 */
import { describe, expect, it } from "vitest";

import {
  isMetaSurfaceServed,
  laterMetaSurfaceState,
  resolveMetaSurfaceReadState,
  type MetaSurfaceReadStateInput,
} from "@/lib/meta/surface-read-state";
import { META_READ_STATES } from "@/lib/meta/read-state-contract";

function input(overrides: Partial<MetaSurfaceReadStateInput> = {}): MetaSurfaceReadStateInput {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    requiresProviderAccount: true,
    permissions: { role: "admin", reviewerReadOnly: false, demo: false },
    capability: { canRead: true, canWrite: true },
    ...overrides,
  };
}

describe("the three distinctions §9 exists to protect", () => {
  it("separates a proven-empty read from a failed one", () => {
    const empty = resolveMetaSurfaceReadState(
      input({ sources: [{ id: "campaigns", outcome: "empty", rowCount: 0 }] }),
    );
    const broken = resolveMetaSurfaceReadState(
      input({
        sources: [{ id: "campaigns", outcome: "failed", failureCode: "source_read_failed" }],
      }),
    );

    expect(empty.state).toBe("empty-proven");
    expect(empty.failure).toBeNull();
    expect(broken.state).toBe("degraded");
    // The operator sentence says the missing part is unknown rather than zero.
    expect(broken.failure?.message).toMatch(/unknown rather than zero/);
  });

  it("separates a partial answer from a whole one", () => {
    const partial = resolveMetaSurfaceReadState(
      input({
        sources: [
          { id: "campaigns", outcome: "served", rowCount: 4 },
          { id: "creatives", outcome: "failed", failureCode: "capability_read_denied" },
        ],
      }),
    );
    expect(partial.state).toBe("partial");
    expect(partial.failure?.code).toBe("source_read_failed");

    const whole = resolveMetaSurfaceReadState(
      input({
        sources: [
          { id: "campaigns", outcome: "served", rowCount: 4 },
          { id: "creatives", outcome: "served", rowCount: 2 },
        ],
      }),
    );
    expect(whole.state).toBe("success");
    expect(whole.failure).toBeNull();
  });

  it("treats a source that answered incompletely as partial, not as served", () => {
    // A capped or half-fed source returns real rows. Presenting them as the
    // whole is how a total silently becomes wrong.
    const state = resolveMetaSurfaceReadState(
      input({ sources: [{ id: "recommendations", outcome: "partial", rowCount: 3 }] }),
    );
    expect(state.state).toBe("partial");
    expect(state.failure?.code).toBe("source_read_failed");
  });

  it("separates a surface that was never scoped from one with nothing on it", () => {
    const unscoped = resolveMetaSurfaceReadState(
      input({
        providerAccountId: null,
        scopeRefusal: "account_required",
        sources: [{ id: "campaigns", outcome: "empty", rowCount: 0 }],
      }),
    );
    expect(unscoped.state).toBe("refused");
    expect(unscoped.failure?.code).toBe("account_required");
    // And the refusal outranks the read: the source was never asked.
    expect(unscoped.state).not.toBe("empty-proven");
  });
});

describe("D6 — the three account postures", () => {
  it("refuses when nothing is assigned", () => {
    const state = resolveMetaSurfaceReadState(
      input({ providerAccountId: null, scopeRefusal: "provider_account_none_assigned", sources: [] }),
    );
    expect(state.state).toBe("refused");
    expect(state.failure?.code).toBe("provider_account_not_assigned");
  });

  it("refuses a requested account this business does not have, and never falls back", () => {
    const state = resolveMetaSurfaceReadState(
      input({
        providerAccountId: null,
        scopeRefusal: "provider_account_not_assigned",
        sources: [],
      }),
    );
    expect(state.state).toBe("refused");
    expect(state.scope.providerAccountId).toBeNull();
  });

  it("serves a business-scoped surface with no account at all", () => {
    // `business_scope`, `assignment` and `token_public` surfaces are not
    // account-scoped; requiring one would refuse Integrations for ever.
    const state = resolveMetaSurfaceReadState(
      input({
        providerAccountId: null,
        requiresProviderAccount: false,
        sources: [{ id: "providers", outcome: "served", rowCount: 5 }],
      }),
    );
    expect(state.state).toBe("success");
  });
});

describe("unreadable is not empty", () => {
  it("reports a schema that is not ready as degraded, not as zero rows", () => {
    const state = resolveMetaSurfaceReadState(
      input({
        capability: { canRead: false, canWrite: false, readBlockedBy: "schema_not_ready" },
        sources: [],
      }),
    );
    expect(state.state).toBe("degraded");
    expect(state.failure?.code).toBe("schema_not_ready");
    expect(state.failure?.message).toMatch(/unavailable, not empty/);
  });

  it("falls back to schema_not_ready rather than inventing a reassuring code", () => {
    const state = resolveMetaSurfaceReadState(
      input({
        // A code this contract has never heard of.
        capability: { canRead: false, canWrite: false, readBlockedBy: "nonsense" as never },
        sources: [],
      }),
    );
    expect(state.state).toBe("degraded");
    expect(state.failure?.code).toBe("schema_not_ready");
  });
});

describe("loading is the absence of a read, not an empty one", () => {
  it("is loading when no source list exists yet", () => {
    expect(resolveMetaSurfaceReadState(input()).state).toBe("loading");
  });

  it("is success, not empty-proven, when a surface reads nothing at all", () => {
    expect(resolveMetaSurfaceReadState(input({ sources: [] })).state).toBe("success");
  });

  it("is refreshing-with-stale when old rows are still on screen", () => {
    const state = resolveMetaSurfaceReadState(
      input({
        sources: [{ id: "campaigns", outcome: "served", rowCount: 3 }],
        refreshing: true,
      }),
    );
    expect(state.state).toBe("refreshing-with-stale");
  });
});

describe("choosing between the page envelope and the payload envelope", () => {
  const page = resolveMetaSurfaceReadState(input());
  const served = resolveMetaSurfaceReadState(
    input({ sources: [{ id: "campaigns", outcome: "served", rowCount: 2 }] }),
  );
  const refusedPage = resolveMetaSurfaceReadState(
    input({ providerAccountId: null, scopeRefusal: "account_required" }),
  );

  it("prefers the payload once it exists", () => {
    expect(laterMetaSurfaceState(page, served)?.state).toBe("success");
  });

  it("keeps the page's refusal even when a payload answered", () => {
    // A payload that answered does not overturn a fact about authority: rows on
    // screen under an unresolved scope would be rows from somewhere.
    expect(laterMetaSurfaceState(refusedPage, served)?.state).toBe("refused");
  });

  it("labels a served envelope as stale while a newer read runs", () => {
    expect(laterMetaSurfaceState(page, served, true)?.state).toBe("refreshing-with-stale");
  });

  it("does not call a refusal or a failed read stale", () => {
    // A refresh over a refusal is still a refusal, and a refresh over a read
    // that never landed is still a first load — neither has rows to be stale.
    expect(laterMetaSurfaceState(refusedPage, served, true)?.state).toBe("refused");
    expect(laterMetaSurfaceState(page, null, true)?.state).toBe("loading");
  });

  it("returns null when neither side has spoken", () => {
    expect(laterMetaSurfaceState(null, null)).toBeNull();
  });
});

describe("the vocabulary is closed", () => {
  it("only ever returns a state the contract names", () => {
    const cases: MetaSurfaceReadStateInput[] = [
      input(),
      input({ sources: [] }),
      input({ sources: [{ id: "a", outcome: "empty", rowCount: 0 }] }),
      input({ sources: [{ id: "a", outcome: "served", rowCount: 1 }] }),
      input({ sources: [{ id: "a", outcome: "served", rowCount: 1 }], refreshing: true }),
      input({ sources: [{ id: "a", outcome: "failed", failureCode: "source_read_failed" }] }),
      input({
        sources: [
          { id: "a", outcome: "served", rowCount: 1 },
          { id: "b", outcome: "not-ready", failureCode: "schema_not_ready" },
        ],
      }),
      input({ providerAccountId: null, scopeRefusal: "account_required" }),
      input({ capability: { canRead: false, canWrite: false, readBlockedBy: "schema_not_ready" } }),
    ];
    for (const one of cases) {
      expect(META_READ_STATES).toContain(resolveMetaSurfaceReadState(one).state);
    }
  });

  it("names a failure exactly when the state is one that has a reason", () => {
    for (const one of [
      input(),
      input({ sources: [{ id: "a", outcome: "empty", rowCount: 0 }] }),
      input({ sources: [{ id: "a", outcome: "failed", failureCode: "source_read_failed" }] }),
      input({ providerAccountId: null, scopeRefusal: "account_required" }),
    ]) {
      const resolved = resolveMetaSurfaceReadState(one);
      const needsReason = ["degraded", "refused", "partial"].includes(resolved.state);
      expect(Boolean(resolved.failure), `${resolved.state}`).toBe(needsReason);
    }
  });

  it("knows which states mean the data may be read", () => {
    expect(isMetaSurfaceServed("success")).toBe(true);
    expect(isMetaSurfaceServed("empty-proven")).toBe(true);
    expect(isMetaSurfaceServed("partial")).toBe(true);
    expect(isMetaSurfaceServed("refreshing-with-stale")).toBe(true);
    expect(isMetaSurfaceServed("loading")).toBe(false);
    expect(isMetaSurfaceServed("degraded")).toBe(false);
    expect(isMetaSurfaceServed("refused")).toBe(false);
  });
});
