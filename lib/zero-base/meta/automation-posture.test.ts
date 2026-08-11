import { describe, expect, it } from "vitest";

import {
  ACTOR_NOT_RECORDED,
  FORBIDDEN_STOP_PHRASES,
  GOOGLE_UNAFFECTED_ROW,
  META_STOP_LABEL,
  META_STOP_SCOPE_NOTE,
  READ_ONLY_GUARDRAIL_IDS,
  REPLAY_BANNER,
  actorLabel,
  buildGuardrailRows,
  buildProviderPostures,
  overclaimsStopReach,
  resolveStopCeremony,
  type StopCeremonyInput,
} from "@/lib/zero-base/meta/automation-posture";

const admin = { role: "admin" as const, isReviewer: false, demo: false };

function stop(overrides: Partial<StopCeremonyInput> = {}): StopCeremonyInput {
  return {
    intent: "engage",
    viewer: admin,
    currentlyEngaged: false,
    readBack: null,
    ...overrides,
  };
}

describe("the stop is Meta-only and business-scoped", () => {
  it("says so in its label and scope note", () => {
    expect(META_STOP_LABEL).toContain("Meta");
    expect(META_STOP_LABEL).toContain("this business");
    expect(META_STOP_SCOPE_NOTE).toContain("this business only");
    expect(META_STOP_SCOPE_NOTE).toContain("Google are unaffected");
  });

  it("uses no language that would imply a wider reach", () => {
    for (const text of [META_STOP_LABEL, META_STOP_SCOPE_NOTE]) {
      expect(overclaimsStopReach(text), text).toBe(false);
    }
  });

  it("detects over-claiming copy", () => {
    // The guard has to actually bite, or it proves nothing above.
    for (const phrase of FORBIDDEN_STOP_PHRASES) {
      expect(overclaimsStopReach(`Emergency ${phrase} switch`), phrase).toBe(true);
    }
  });
});

describe("Google posture is always present and never stoppable", () => {
  it("draws both providers even when Meta is healthy", () => {
    const rows = buildProviderPostures({ google: { read: true, connected: true }, meta: { state: "serving", reason: null } });
    expect(rows.map((row) => row.provider)).toEqual(["meta", "google"]);
  });

  it("keeps Google present when Meta is degraded", () => {
    const rows = buildProviderPostures({
      google: { read: true, connected: true },
      meta: { state: "degraded", reason: "Token refresh failing." },
    });
    // Omitting the row when something is wrong is exactly when an operator
    // would assume one control covers both.
    expect(rows.find((row) => row.provider === "google")).toBeDefined();
    expect(rows.find((row) => row.provider === "google")?.reason).toBe(GOOGLE_UNAFFECTED_ROW);
  });

  it("marks only Meta as stoppable", () => {
    const rows = buildProviderPostures({ google: { read: true, connected: true }, meta: { state: "serving", reason: null } });
    expect(rows.find((row) => row.provider === "meta")?.stoppable).toBe(true);
    expect(rows.find((row) => row.provider === "google")?.stoppable).toBe(false);
  });

  it("carries every provider source state through unchanged", () => {
    for (const state of ["serving", "partial", "degraded", "unavailable"] as const) {
      const rows = buildProviderPostures({ google: { read: true, connected: true }, meta: { state, reason: "because" } });
      expect(rows[0].state).toBe(state);
    }
  });
});

describe("stop ceremony refuses before it confirms", () => {
  it("blocks a reviewer", () => {
    expect(resolveStopCeremony(stop({ viewer: { ...admin, isReviewer: true } })).blocker?.code).toBe(
      "reviewer",
    );
  });

  it("blocks a demo business", () => {
    expect(resolveStopCeremony(stop({ viewer: { ...admin, demo: true } })).blocker?.code).toBe("demo");
  });

  it("blocks a non-admin in both directions", () => {
    for (const intent of ["engage", "release"] as const) {
      // Releasing re-enables spend, so it is admin-only too — not just the
      // direction that looks dangerous.
      expect(
        resolveStopCeremony(stop({ intent, viewer: { ...admin, role: "collaborator" } })).blocker
          ?.code,
      ).toBe("insufficient_role");
    }
  });

  it("refuses to change a state it could not read", () => {
    expect(resolveStopCeremony(stop({ currentlyEngaged: null })).blocker?.code).toBe(
      "state_unavailable",
    );
  });

  it("shows no status banner while blocked", () => {
    const state = resolveStopCeremony(stop({ viewer: { ...admin, isReviewer: true } }));
    expect(state.showStatusBanner).toBe(false);
    expect(state.statusMessage).toBeNull();
  });
});

describe("no status banner before the read-back", () => {
  it("stays at confirm until a read-back exists", () => {
    const state = resolveStopCeremony(stop());
    expect(state.step).toBe("confirm");
    // A 200 response is not an observation of state.
    expect(state.showStatusBanner).toBe(false);
  });

  it("reports success only once the read-back agrees", () => {
    const state = resolveStopCeremony(
      stop({ readBack: { engaged: true, readAt: "2026-08-11T12:00:00Z" } }),
    );
    expect(state.step).toBe("settled");
    expect(state.showStatusBanner).toBe(true);
    expect(state.statusMessage).toContain("Confirmed by read-back");
  });

  it("refuses to claim success when the read-back disagrees", () => {
    const state = resolveStopCeremony(
      stop({ readBack: { engaged: false, readAt: "2026-08-11T12:00:00Z" } }),
    );
    // The write was submitted but the state was not observed to change: an
    // operator told "stopped" here would believe spend had halted.
    expect(state.step).toBe("awaiting_read_back");
    expect(state.showStatusBanner).toBe(false);
    expect(state.statusMessage).toContain("unknown");
  });

  it("applies the same rule to a release", () => {
    expect(
      resolveStopCeremony(
        stop({ intent: "release", currentlyEngaged: true, readBack: { engaged: true, readAt: "t" } }),
      ).showStatusBanner,
    ).toBe(false);
    expect(
      resolveStopCeremony(
        stop({ intent: "release", currentlyEngaged: true, readBack: { engaged: false, readAt: "t" } }),
      ).statusMessage,
    ).toContain("running again");
  });
});

describe("guardrails are read-only", () => {
  const rows = buildGuardrailRows({ dailyAutoActionCap: 3, perActionSpendCeilingMinor: 5000 });

  it("covers AUTO-05 through AUTO-10", () => {
    expect(rows.map((row) => row.id)).toEqual([...READ_ONLY_GUARDRAIL_IDS]);
  });

  it("offers zero edit affordances", () => {
    // An edit control would imply the buyer can change a cap the engine
    // enforces server-side and will not honour from here.
    expect(rows.filter((row) => row.editable).length).toBe(0);
  });

  it("says not configured rather than inventing a default", () => {
    const sparse = buildGuardrailRows({});
    expect(sparse.find((row) => row.id === "AUTO-07")?.value).toBe("Not configured");
  });
});

describe("replay and actor gaps", () => {
  it("states that replayed rows are a reconstruction", () => {
    expect(REPLAY_BANNER).toContain("replayed");
    expect(REPLAY_BANNER).toContain("not what it decided then");
  });

  it("names an unknown actor rather than attributing to the system", () => {
    expect(actorLabel(null)).toBe(ACTOR_NOT_RECORDED);
    expect(actorLabel("   ")).toBe(ACTOR_NOT_RECORDED);
    // "System" would be a claim about who acted.
    expect(actorLabel(null)).not.toMatch(/system/i);
  });

  it("passes a recorded actor through unchanged", () => {
    expect(actorLabel("ada@example.com")).toBe("ada@example.com");
  });
});
