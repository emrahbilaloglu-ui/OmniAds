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
  STOP_PREFLIGHT_MAX_AGE_MS,
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

  /**
   * The role floor is direction-aware, and it matches the route.
   *
   * `app/api/meta/automation/route.ts` takes `collaborator` for
   * `engage_kill_switch` and `admin` for `release_kill_switch`. This used to
   * refuse a collaborator in BOTH directions — stricter than the server, which
   * sounds safe and is not: it hid the emergency control from exactly the
   * operator the route would have accepted.
   */
  it("lets a collaborator engage, because the route does", () => {
    expect(
      resolveStopCeremony(stop({ intent: "engage", viewer: { ...admin, role: "collaborator" } }))
        .blocker,
    ).toBeNull();
  });

  it("still holds RELEASE to an admin, because releasing re-enables spend", () => {
    expect(
      resolveStopCeremony(stop({ intent: "release", viewer: { ...admin, role: "collaborator" } }))
        .blocker?.code,
    ).toBe("insufficient_role");
  });

  it("blocks a guest in either direction", () => {
    for (const intent of ["engage", "release"] as const) {
      expect(
        resolveStopCeremony(stop({ intent, viewer: { ...admin, role: "guest" } })).blocker?.code,
      ).toBe("insufficient_role");
    }
  });

  /**
   * The gate holds ENGAGE and never holds RELEASE.
   *
   * The route says why: a stop that cannot be released is worse than no stop,
   * so whatever the rollout state, an existing stop must always be liftable.
   */
  it("refuses engage while the stop gate is shut, and never refuses release", () => {
    const reason = "The Meta Stop is not enabled on this workspace yet.";
    expect(
      resolveStopCeremony(stop({ intent: "engage", gateClosedReason: reason })).blocker?.code,
    ).toBe("gate_closed");
    expect(
      resolveStopCeremony(
        stop({ intent: "release", currentlyEngaged: true, gateClosedReason: reason }),
      ).blocker,
    ).toBeNull();
  });

  /**
   * A typed confirmation is a confirmation of a READING.
   *
   * An absent `preflight` key keeps the previous behaviour for a caller with no
   * per-section provenance to offer. An explicit `null` is a caller that HAS the
   * envelope and found no reading in it, which is a refusal rather than an
   * omission.
   */
  it("refuses when the caller has the envelope and it carried no reading", () => {
    expect(resolveStopCeremony(stop({ preflight: null })).blocker?.code).toBe(
      "preflight_unavailable",
    );
  });

  it("refuses a reading that did not complete, and names the error code", () => {
    const state = resolveStopCeremony(
      stop({
        preflight: {
          status: "unavailable",
          errorCode: "control_plane_read_failed",
          observedAt: "2026-08-26T12:00:00.000Z",
        },
        now: Date.parse("2026-08-26T12:00:10.000Z"),
      }),
    );
    expect(state.blocker?.code).toBe("preflight_unavailable");
    expect(state.blocker?.message).toContain("control_plane_read_failed");
  });

  it("refuses a reading older than the ceremony's own window", () => {
    const state = resolveStopCeremony(
      stop({
        preflight: {
          status: "complete",
          errorCode: null,
          observedAt: "2026-08-26T12:00:00.000Z",
        },
        now: Date.parse("2026-08-26T12:00:00.000Z") + STOP_PREFLIGHT_MAX_AGE_MS + 1,
      }),
    );
    expect(state.blocker?.code).toBe("preflight_stale");
    expect(state.blocker?.message).toContain("2026-08-26T12:00:00.000Z");
  });

  it("accepts a fresh, complete reading", () => {
    expect(
      resolveStopCeremony(
        stop({
          preflight: {
            status: "complete",
            errorCode: null,
            observedAt: "2026-08-26T12:00:00.000Z",
          },
          now: Date.parse("2026-08-26T12:00:00.000Z") + 1_000,
        }),
      ).blocker,
    ).toBeNull();
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
