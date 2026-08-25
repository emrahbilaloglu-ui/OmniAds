/**
 * The Engine V3 posture matrix, complete.
 *
 * WP10's acceptance names "the shadow posture's eight combinations" and until
 * now five of the twenty-four rows were spot-checked inside
 * `creative-adapters.test.ts` — enough to show the resolver worked on the cases
 * someone thought of, not enough to show which case a change would break.
 *
 * The three flags are independent booleans, so there are eight combinations,
 * and the served status has three values: twenty-four rows, every one of them
 * below with the posture it must produce. The table is written out rather than
 * computed from the same rules the resolver applies, because a test that
 * derives its expectation from the implementation agrees with a bug as readily
 * as with correct code.
 *
 * The ordering claim is the one worth stating in prose: SHADOW IS CHECKED
 * BEFORE VISIBILITY. A shadow decision that happens to be visible is still a
 * shadow decision, and calling it `serving` is the most dangerous of the five
 * mistakes — it is the one that ends with somebody acting on a number nobody
 * stands behind.
 */
import { describe, expect, it } from "vitest";

import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";

import {
  ENGINE_POSTURES,
  creativeActionCount,
  postureView,
  resolveEnginePosture,
  type EnginePosture,
} from "./engine-posture";

type FlagTriple = Pick<EngineV3Flags, "enabled" | "surfaceVisible" | "shadowOnly">;

function flags(enabled: boolean, shadowOnly: boolean, surfaceVisible: boolean): FlagTriple {
  return { enabled, shadowOnly, surfaceVisible };
}

/**
 * Every reachable input, and the posture it must produce.
 *
 * `status` is what the served response said; the triple is what the flags said.
 * `disabled` and `unavailable` are authoritative statuses — the server already
 * decided — so the flags cannot talk them out of it, which is why those sixteen
 * rows all answer the same regardless of the triple.
 */
const MATRIX: {
  status: "serving" | "disabled" | "unavailable";
  flags: FlagTriple | null;
  expected: EnginePosture;
  why: string;
}[] = [
  // ---- status: serving. Here the eight flag combinations decide. ----
  {
    status: "serving",
    flags: flags(true, false, true),
    expected: "serving",
    why: "on, not shadowed, cleared for this surface — the only authoritative combination",
  },
  {
    status: "serving",
    flags: flags(true, false, false),
    expected: "hidden",
    why: "running and not cleared here: withheld, not empty",
  },
  {
    status: "serving",
    flags: flags(true, true, true),
    expected: "shadow_only",
    why: "shadow wins over visible — a visible shadow decision is still a shadow decision",
  },
  {
    status: "serving",
    flags: flags(true, true, false),
    expected: "shadow_only",
    why: "shadow wins over hidden too: the more specific fact about the decisions",
  },
  {
    status: "serving",
    flags: flags(false, false, true),
    expected: "disabled",
    why: "off is off, whatever the surface is cleared to show",
  },
  {
    status: "serving",
    flags: flags(false, false, false),
    expected: "disabled",
    why: "off",
  },
  {
    status: "serving",
    flags: flags(false, true, true),
    expected: "disabled",
    why: "an engine that is off computes no shadow decisions to speak of",
  },
  {
    status: "serving",
    flags: flags(false, true, false),
    expected: "disabled",
    why: "off",
  },
  {
    status: "serving",
    flags: null,
    expected: "unavailable",
    why: "no flags means the read failed — unknown, never assumed serving",
  },

  // ---- status: disabled. The server already decided; flags cannot argue. ----
  ...(
    [
      flags(true, false, true),
      flags(true, false, false),
      flags(true, true, true),
      flags(true, true, false),
      flags(false, false, true),
      flags(false, false, false),
      flags(false, true, true),
      flags(false, true, false),
      null,
    ] as (FlagTriple | null)[]
  ).map((triple) => ({
    status: "disabled" as const,
    flags: triple,
    expected: "disabled" as const,
    why: "the served response says the engine is off for this business",
  })),

  // ---- status: unavailable. We do not know, and that is its own answer. ----
  ...(
    [
      flags(true, false, true),
      flags(true, true, true),
      flags(false, false, false),
      null,
    ] as (FlagTriple | null)[]
  ).map((triple) => ({
    status: "unavailable" as const,
    flags: triple,
    expected: "unavailable" as const,
    why: "the posture could not be read — different from knowing it says nothing",
  })),
];

describe("the Engine V3 posture matrix", () => {
  it("covers all eight flag combinations at the serving status", () => {
    const serving = MATRIX.filter((row) => row.status === "serving" && row.flags);
    const seen = new Set(
      serving.map(
        (row) =>
          `${row.flags!.enabled}/${row.flags!.shadowOnly}/${row.flags!.surfaceVisible}`,
      ),
    );
    expect(seen.size, "a flag combination is missing from the matrix").toBe(8);
  });

  for (const row of MATRIX) {
    const triple = row.flags
      ? `enabled=${row.flags.enabled} shadow=${row.flags.shadowOnly} visible=${row.flags.surfaceVisible}`
      : "flags unread";
    it(`${row.status} + ${triple} → ${row.expected} (${row.why})`, () => {
      expect(resolveEnginePosture({ status: row.status, flags: row.flags })).toBe(
        row.expected,
      );
    });
  }

  it("never answers with a posture outside the five", () => {
    for (const row of MATRIX) {
      expect(ENGINE_POSTURES).toContain(
        resolveEnginePosture({ status: row.status, flags: row.flags }),
      );
    }
  });
});

describe("only a serving posture may carry authority", () => {
  it("marks exactly one posture authoritative", () => {
    const authoritative = ENGINE_POSTURES.filter(
      (posture) => postureView(posture).decisionsAreAuthority,
    );
    expect(authoritative).toEqual(["serving"]);
  });

  it("gives every posture an explanation an operator can act on", () => {
    for (const posture of ENGINE_POSTURES) {
      const view = postureView(posture);
      expect(view.label.length, posture).toBeGreaterThan(0);
      // A posture with no explanation is a posture nobody trusts, and the two
      // that matter most — shadow and unavailable — are the ones a bare label
      // most easily reads as "fine".
      expect(view.explanation.length, posture).toBeGreaterThan(40);
    }
  });

  it("offers no action from any posture but serving", () => {
    for (const posture of ENGINE_POSTURES) {
      const count = creativeActionCount({ posture, held: false, viewerCanAct: true });
      expect(count, posture).toBe(posture === "serving" ? 1 : 0);
    }
  });

  it("offers none from a held row or a viewer who may not act, even while serving", () => {
    expect(
      creativeActionCount({ posture: "serving", held: true, viewerCanAct: true }),
    ).toBe(0);
    expect(
      creativeActionCount({ posture: "serving", held: false, viewerCanAct: false }),
    ).toBe(0);
  });

  it("never offers an action beside a shadow decision", () => {
    // Restated on its own because it is the rule WP10 names: an action
    // affordance next to a shadow decision is an invitation to act on a number
    // nobody stands behind.
    expect(
      creativeActionCount({ posture: "shadow_only", held: false, viewerCanAct: true }),
    ).toBe(0);
  });
});
