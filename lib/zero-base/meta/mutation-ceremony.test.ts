import { describe, expect, it } from "vitest";

import {
  CLIENT_SUPPLIED_EXPECTED_FIELDS,
  MUTATION_ENDPOINTS,
  PREFLIGHT_MAX_AGE_MS,
  TERMINAL_COPY,
  confirmationFor,
  endpointFor,
  receiptAvailable,
  resolveCeremony,
  retryAllowed,
  stripClientExpectations,
  type CeremonyInput,
} from "@/lib/zero-base/meta/mutation-ceremony";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function input(overrides: Partial<CeremonyInput> = {}): CeremonyInput {
  return {
    mutationUiEnabled: true,
    grain: "ad",
    action: "pause",
    preflight: {
      ok: true,
      ranAt: "2026-08-11T11:58:00.000Z",
      held: false,
      changed: false,
      writable: true,
      lineageComplete: true,
      provenBusinessId: "biz_1",
      provenAccountId: "act_1",
    },
    scope: { businessId: "biz_1", accountId: "act_1" },
    viewer: { isReviewer: false, demo: false },
    providerOnline: true,
    now: NOW,
    ...overrides,
  };
}

describe("the mutation flag is the outermost gate", () => {
  it("is off by default in every environment", () => {
    // The ceremony takes the flag as an input and refuses when it is false;
    // nothing here can enable it.
    const state = resolveCeremony(input({ mutationUiEnabled: false }));
    expect(state.step).toBe("unavailable");
    expect(state.blocker?.code).toBe("mutation_ui_disabled");
    expect(state.endpoint).toBeNull();
  });

  it("refuses before a preflight is even considered", () => {
    const state = resolveCeremony(
      input({ mutationUiEnabled: false, preflight: { ...input().preflight, ok: false, ranAt: null } }),
    );
    // The flag answer must not depend on preflight state.
    expect(state.blocker?.code).toBe("mutation_ui_disabled");
  });
});

describe("posture refusals come before any provider consideration", () => {
  it("refuses a reviewer", () => {
    const state = resolveCeremony(input({ viewer: { isReviewer: true, demo: false } }));
    expect(state.blocker?.code).toBe("reviewer");
    expect(state.endpoint).toBeNull();
  });

  it("refuses a demo business even with a perfect preflight", () => {
    const state = resolveCeremony(input({ viewer: { isReviewer: false, demo: true } }));
    expect(state.blocker?.code).toBe("demo");
  });
});

describe("dispatch is an allowlist", () => {
  it("maps only the endpoints that exist", () => {
    expect(endpointFor("ad", "pause")).toBe("/api/meta/ads/[adId]/pause");
    // apply-bid is the route that exists; `/bid` never did.
    expect(endpointFor("adset", "bid")).toBe("/api/meta/adsets/[adsetId]/apply-bid");
    expect(endpointFor("campaign", "pause")).toBe("/api/meta/campaigns/[campaignId]/pause");
  });

  it("refuses an action that has no endpoint at that grain", () => {
    // A campaign has no duplicate endpoint; a generic executor would have
    // happily tried.
    expect(endpointFor("campaign", "duplicate")).toBeNull();
    const state = resolveCeremony(input({ grain: "campaign", action: "duplicate" }));
    expect(state.blocker?.code).toBe("unsupported_action");
    expect(state.endpoint).toBeNull();
  });

  it("names a typed endpoint per grain, never a generic execute route", () => {
    const endpoints = Object.values(MUTATION_ENDPOINTS).flatMap((byAction) =>
      Object.values(byAction ?? {}),
    );
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint).toMatch(/^\/api\/meta\//);
      expect(endpoint).not.toMatch(/execute|action\b|dispatch/);
    }
  });

  it("covers all three grains", () => {
    expect(Object.keys(MUTATION_ENDPOINTS).sort()).toEqual(["ad", "adset", "campaign"]);
  });
});

describe("preflight gates", () => {
  it("asks for a preflight before anything else when none has run", () => {
    const state = resolveCeremony(
      input({ preflight: { ...input().preflight, ok: false, ranAt: null } }),
    );
    expect(state.step).toBe("preflight");
    expect(state.endpoint).toBeNull();
  });

  it("refuses a held decision", () => {
    const state = resolveCeremony(input({ preflight: { ...input().preflight, held: true } }));
    expect(state.blocker?.code).toBe("held_decision");
  });

  it("refuses when exact provider identity was not proven", () => {
    const state = resolveCeremony(
      input({ preflight: { ...input().preflight, lineageComplete: false } }),
    );
    expect(state.blocker?.code).toBe("missing_lineage");
  });

  it("refuses a non-writable account", () => {
    const state = resolveCeremony(input({ preflight: { ...input().preflight, writable: false } }));
    expect(state.blocker?.code).toBe("not_writable");
  });

  it("refuses when the proven target is not the scope being worked in", () => {
    // Acting on somebody else's account is the failure this prevents.
    expect(
      resolveCeremony(input({ preflight: { ...input().preflight, provenBusinessId: "biz_other" } }))
        .blocker?.code,
    ).toBe("target_mismatch");
    expect(
      resolveCeremony(input({ preflight: { ...input().preflight, provenAccountId: "act_other" } }))
        .blocker?.code,
    ).toBe("target_mismatch");
  });

  it("refuses when the provider is unreachable", () => {
    expect(resolveCeremony(input({ providerOnline: false })).blocker?.code).toBe("provider_offline");
  });
});

describe("age and change", () => {
  it("accepts a preflight inside the 15 minute window", () => {
    const state = resolveCeremony(input());
    expect(state.step).toBe("confirm");
    expect(state.preflightAgeMs).toBeLessThan(PREFLIGHT_MAX_AGE_MS);
  });

  it("requires a re-run past 15 minutes", () => {
    const state = resolveCeremony(
      input({ preflight: { ...input().preflight, ranAt: "2026-08-11T11:44:00.000Z" } }),
    );
    // 16 minutes: the world may have moved on.
    expect(state.step).toBe("stale");
    expect(state.endpoint).toBeNull();
    expect(PREFLIGHT_MAX_AGE_MS).toBe(900_000);
  });

  it("treats an unparseable preflight time as stale rather than fresh", () => {
    const state = resolveCeremony(
      input({ preflight: { ...input().preflight, ranAt: "not-a-date" } }),
    );
    expect(state.step).toBe("stale");
  });

  it("sends changed live state back for review instead of to a confirmation", () => {
    const state = resolveCeremony(input({ preflight: { ...input().preflight, changed: true } }));
    expect(state.step).toBe("changed");
    expect(state.endpoint).toBeNull();
  });
});

describe("confirmation level", () => {
  it("takes a typed phrase for anything that starts money moving", () => {
    expect(confirmationFor("resume")).toBe("typed_phrase");
    expect(confirmationFor("bid")).toBe("typed_phrase");
  });

  it("takes an acknowledgement for reversible actions", () => {
    expect(confirmationFor("pause")).toBe("acknowledge");
    expect(confirmationFor("duplicate")).toBe("acknowledge");
  });

  it("attaches the level only once dispatch is actually permitted", () => {
    expect(resolveCeremony(input({ action: "resume", grain: "ad" })).confirmation).toBe("typed_phrase");
    expect(resolveCeremony(input({ providerOnline: false })).confirmation).toBe("none");
  });
});

describe("terminal outcomes", () => {
  it("offers a receipt only when the attempt is durable", () => {
    expect(receiptAvailable("verified", true)).toBe(true);
    expect(receiptAvailable("verified", false)).toBe(false);
    expect(receiptAvailable("failed", true)).toBe(true);
    expect(receiptAvailable("silent_failure", true)).toBe(true);
  });

  it("offers no receipt under ambiguity", () => {
    // Nothing is settled, and a receipt would invite reading "we do not know"
    // as "it worked".
    expect(receiptAvailable("provider_outcome_ambiguous", true)).toBe(false);
  });

  it("permits a retry only after a clean refusal", () => {
    expect(retryAllowed("failed")).toBe(true);
    // The provider may already have applied it; retrying could double it.
    expect(retryAllowed("provider_outcome_ambiguous")).toBe(false);
    expect(retryAllowed("silent_failure")).toBe(false);
    expect(retryAllowed("verified")).toBe(false);
  });

  it("says plainly what each outcome means", () => {
    expect(TERMINAL_COPY.failed.body).toMatch(/Nothing was altered/);
    expect(TERMINAL_COPY.provider_outcome_ambiguous.body).toMatch(/Do not retry/);
    expect(TERMINAL_COPY.silent_failure.body).toMatch(/unknown/i);
    // Four distinct outcomes, four distinct sentences.
    const bodies = Object.values(TERMINAL_COPY).map((copy) => copy.body);
    expect(new Set(bodies).size).toBe(4);
  });
});

describe("client-supplied expectations", () => {
  it("names the fields the canonical mode refuses", () => {
    expect([...CLIENT_SUPPLIED_EXPECTED_FIELDS]).toEqual([
      "expectedStatus",
      "expectedCreativeId",
      "expectedParentId",
    ]);
  });

  it("strips them and reports what it removed", () => {
    const { cleaned, rejected } = stripClientExpectations({
      businessId: "biz_1",
      expectedStatus: "ACTIVE",
      expectedParentId: "camp_1",
    });
    expect(rejected.sort()).toEqual(["expectedParentId", "expectedStatus"]);
    expect(cleaned).toEqual({ businessId: "biz_1" });
  });

  it("reports nothing when a caller supplied none", () => {
    const { rejected } = stripClientExpectations({ businessId: "biz_1" });
    expect(rejected).toEqual([]);
  });

  it("ignores explicit nulls rather than reporting them as an attempt", () => {
    const { rejected } = stripClientExpectations({ expectedStatus: null });
    expect(rejected).toEqual([]);
  });
});

describe("nothing here contacts a provider", () => {
  it("resolves purely from its inputs", () => {
    // The ceremony is a pure function: it cannot perform a network call, so it
    // can never be mistaken for having verified live state itself.
    const state = resolveCeremony(input());
    expect(state).toEqual({
      step: "confirm",
      blocker: null,
      confirmation: "acknowledge",
      endpoint: "/api/meta/ads/[adId]/pause",
      preflightAgeMs: 120_000,
    });
  });
});
