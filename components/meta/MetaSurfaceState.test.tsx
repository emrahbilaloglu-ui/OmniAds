/**
 * Which §9 states are allowed to move the page, and which are not.
 *
 * The rule this file holds is not cosmetic. A notice that always disappears and
 * sits in flow above the whole surface drags every row on the page with it when
 * it goes: on the mounted Creative Studio that was one 52 px collapse and CLS
 * 0.104 against a 0.100 budget. So the two states that always end are pinned,
 * and the three that persist stay in flow where they cannot be scrolled past.
 *
 * The test is written against the RENDERED style rather than against the
 * constant, because "is this element in the layout" is the actual claim and a
 * test that read `TRANSIENT` back would agree with whatever it said.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MetaSurfaceState } from "@/components/meta/MetaSurfaceState";
import { META_READ_STATES } from "@/lib/meta/read-state-contract";
import type {
  MetaReadState,
  MetaResponseEnvelope,
} from "@/lib/meta/read-state-contract";

function envelopeFor(state: MetaReadState): MetaResponseEnvelope<null> {
  return {
    state,
    data: null,
    failure:
      state === "partial" || state === "degraded" || state === "refused"
        ? {
            code: "source_read_failed",
            message: "One source could not be read.",
          }
        : null,
    scope: { businessId: "biz", providerAccountId: "act_1" },
    evidence: { freshness: "fresh", asOf: null },
    capability: { canRead: true, canWrite: false },
  } as unknown as MetaResponseEnvelope<null>;
}

function render(state: MetaReadState): string {
  return renderToStaticMarkup(
    <MetaSurfaceState
      envelope={envelopeFor(state)}
      surfaceId="creative-studio"
    />,
  );
}

/** The two that always end, and therefore must never be in the layout. */
const TRANSIENT: MetaReadState[] = ["loading", "refreshing-with-stale"];
/** The three that last as long as their condition, and must be impossible to miss. */
const PERSISTENT: MetaReadState[] = ["partial", "degraded", "refused"];
/** The two that say nothing at all. */
const SILENT: MetaReadState[] = ["success", "empty-proven"];

describe("a notice that will vanish never sits in the layout", () => {
  for (const state of TRANSIENT) {
    it(`${state} is pinned`, () => {
      const html = render(state);
      expect(html).toContain('data-notice-placement="pinned"');
      // The actual claim: out of flow.
      expect(html).toMatch(/position:fixed/);
    });
  }

  for (const state of PERSISTENT) {
    it(`${state} stays in flow`, () => {
      const html = render(state);
      expect(html).toContain('data-notice-placement="in-flow"');
      expect(html).not.toMatch(/position:fixed/);
      // And keeps the margin that separates it from the surface below.
      expect(html).toMatch(/margin:0 0 12px/);
    });
  }

  for (const state of SILENT) {
    it(`${state} draws nothing`, () => {
      const html = render(state);
      expect(html).not.toContain("data-meta-surface-notice");
      expect(html).not.toContain("data-notice-placement");
    });
  }

  it("covers every state in the contract, so a new one cannot slip through unplaced", () => {
    expect([...TRANSIENT, ...PERSISTENT, ...SILENT].sort()).toEqual(
      [...META_READ_STATES].sort(),
    );
  });
});

describe("the notice keeps machine-readable state without exposing diagnostics", () => {
  it("uses concise user-facing loading copy", () => {
    expect(render("loading")).toMatch(/Loading the latest Meta data/);
    expect(render("refreshing-with-stale")).toMatch(
      /Updating the latest Meta data/,
    );
  });

  it("keeps every marker on the element the gates query", () => {
    for (const state of META_READ_STATES) {
      const html = render(state);
      expect(html, state).toContain(
        'data-meta-surface-state="creative-studio"',
      );
      expect(html, state).toContain(`data-read-state="${state}"`);
    }
    // The updating flag is on the marker, not on the card that moved.
    expect(render("refreshing-with-stale")).toMatch(
      /data-meta-surface-state="creative-studio"[^>]*data-updating/,
    );
  });

  it("keeps failure codes on the marker without printing them", () => {
    for (const state of [...PERSISTENT] as MetaReadState[]) {
      expect(render(state), state).toContain(
        'data-failure-code="source_read_failed"',
      );
      expect(render(state), state).not.toContain(
        "Reference: source_read_failed",
      );
      expect(render(state), state).not.toContain(
        "One source could not be read",
      );
    }
  });

  it("announces politely rather than assertively, wherever it sits", () => {
    for (const state of [...TRANSIENT, ...PERSISTENT]) {
      expect(render(state), state).toContain('role="status"');
      expect(render(state), state).not.toContain('role="alert"');
    }
  });
});
