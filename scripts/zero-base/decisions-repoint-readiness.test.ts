// @vitest-environment jsdom
/**
 * Is the MOUNTED Decision Center anatomy-complete for its artboards?
 *
 * The frame harness still renders `components/zero-base/_reference/
 * meta-decisions-view.tsx`, and the reason is now a measurement rather than a
 * belief. Repointing the eleven Decisions artboards at
 * `MetaDecisionCenterExact` was run: the anatomy gate reached **83/83 with the
 * mounted body**, and the fidelity gate reported **229 findings across those
 * eleven artboards, every one of them `untokenised-colour`** — the mounted
 * console is painted in the adv system (Instrument Sans, Space Grotesk,
 * `--adv-*`) and the accepted package is the Ledger one.
 *
 * Both ways to make that green are refused by the standing instruction:
 * repainting this one surface leaves it foreign to the other twelve, and adding
 * these frames to `PAINT_SYSTEM_DEBT` raises a ceiling that may only fall. So
 * the repoint waits on the design owner's re-vendor.
 *
 * What this file does is keep the OTHER half permanently true. It renders the
 * mounted body from the same fixture the repointed frames used and asserts
 * every marker the reference manifest requires of every Decisions artboard. If
 * a future change drops one, this fails on the day it happens rather than on
 * the day somebody tries the repoint again.
 *
 * It is not a substitute for the frame gate. It proves the anatomy is present
 * in the rendered body; the frame gate proves it in the captured page inside
 * the real shell, which is the stronger claim and the one that is blocked.
 */
import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MetaDecisionCenterExact } from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { decisionCenterFixture } from "@/scripts/zero-base/fixtures/decision-center";
import { collectionKind } from "@/scripts/zero-base/verify-reference-anatomy";

interface ReferenceFrame {
  id: string;
  label: string;
  els: string[];
  ctls: string[];
  collections: string[];
}

const MANIFEST = JSON.parse(
  readFileSync("docs/zero-base-design/v3/reference-manifest.json", "utf8"),
) as { frames: ReferenceFrame[] };

/**
 * The artboards whose leaf is the Decisions body, and the state each names.
 *
 * `shell` lists the markers the ARTBOARD requires that the surrounding
 * `AppShell` supplies — the nav drawer, the scope sheet, the agency return.
 * They are excluded here because this renders the leaf alone; the frame gate is
 * where the shell's own contribution is measured.
 */
const ARTBOARDS: ReadonlyArray<{
  id: string;
  render: () => React.ReactElement;
  shell?: readonly string[];
}> = [
  { id: "H09", render: () => body({}) },
  { id: "H10", render: () => body({ selected: true }) },
  // H11 draws the lane AND the inspector's workflow menu, which is why the
  // frame that grades it selects a row: `decisions("d1", 3, false, false, true)`.
  { id: "H11", render: () => body({ paging: true, selected: true }) },
  { id: "H12", render: () => body({ selected: true, conflict: true }) },
  { id: "B02", render: () => body({ selected: true }) },
  { id: "B06", render: () => body({}), shell: ["live:MOBILE-02 scope-sheet", "live:nav-drawer"] },
  { id: "B07", render: () => body({ selected: true }) },
  {
    id: "H52",
    render: () => body({ selected: true, sticky: true }),
    shell: ["live:MOBILE-02 scope-sheet", "live:nav-drawer"],
  },
  {
    id: "H57",
    render: () => body({ selected: true, sticky: true }),
    shell: ["live:MOBILE-02 scope-sheet", "live:nav-drawer"],
  },
  {
    id: "P06",
    render: () => body({ selected: true, sticky: true }),
    // The Turkish marker is emitted by the header only under a TR provider,
    // which the frame harness supplies and this render does not.
    shell: ["turkish-strings"],
  },
  {
    id: "P07",
    render: () => body({ selected: true, sticky: true }),
    shell: ["live:MOBILE-02 scope-sheet", "live:nav-drawer"],
  },
];

function body(options: {
  selected?: boolean;
  conflict?: boolean;
  paging?: boolean;
  sticky?: boolean;
}): React.ReactElement {
  return React.createElement(MetaDecisionCenterExact, {
    adsManagerHref:
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=298410771",
    lane: options.paging ? "needsres" : "action",
    scope: "structure",
    onCloseInspector: () => {},
    onLaneChange: () => {},
    onLevelsChange: () => {},
    onScopeChange: () => {},
    onSearchChange: () => {},
    onSortChange: () => {},
    viewModel: decisionCenterFixture({
      rows: 3,
      blocked: options.paging ? 30 : 2,
      selected: options.selected === true,
      conflict: options.conflict === true,
      stickyBar: options.sticky === true,
    }),
  });
}

/** The design's own templating leaked into the export; the gate excludes it. */
const TEMPLATE_PLACEHOLDER = /^\{\{.*\}\}$/;

describe("the mounted Decision Center carries its artboards' anatomy", () => {
  for (const artboard of ARTBOARDS) {
    const frame = MANIFEST.frames.find((entry) => entry.id === artboard.id);
    if (!frame) continue;
    const shell = new Set(artboard.shell ?? []);

    it(`${artboard.id} ${frame.label}`, () => {
      const html = renderToStaticMarkup(artboard.render());
      const missing: string[] = [];

      for (const value of frame.els) {
        if (shell.has(value)) continue;
        if (!html.includes(`data-el="${value}"`)) missing.push(`el:${value}`);
      }
      for (const value of frame.ctls) {
        if (shell.has(value) || TEMPLATE_PLACEHOLDER.test(value)) continue;
        if (!html.includes(`data-ctl="${value}"`)) missing.push(`ctl:${value}`);
      }
      for (const value of frame.collections) {
        // The artboard prefix is the design naming one instance of a shared
        // component; the implementation emits the kind.
        const kind = collectionKind(value);
        if (!html.includes(`data-collection="${kind}"`)) {
          missing.push(`collection:${kind}`);
        }
      }

      expect(missing).toEqual([]);
    });
  }

  it("covers every Decisions artboard the manifest declares", () => {
    /*
     * The census, so an artboard added to the design cannot quietly go
     * ungraded here while the frame gate is still pointed elsewhere.
     */
    const declared = MANIFEST.frames
      .filter((frame) => /Decisions|decision/i.test(frame.label))
      .map((frame) => frame.id)
      .sort();
    const covered = ARTBOARDS.map((artboard) => artboard.id).sort();
    for (const id of declared) expect(covered).toContain(id);
  });
});

describe("what this file does NOT prove", () => {
  it("states the measured reason the frames are still pointed elsewhere", () => {
    /*
     * A number, in the repo, next to the claim. "The paint system blocks it" is
     * an assertion; 229 untokenised-colour findings across eleven artboards is
     * a measurement somebody can re-run:
     *
     *   npm run zero-base:frames:build && npm run test:zero-base:fidelity
     *
     * after swapping the `decisions()` thunk in `frame-registry.tsx` for the
     * mounted body. The anatomy gate reports 83/83 in that state.
     */
    const registry = readFileSync(
      "scripts/zero-base/frame-registry.tsx",
      "utf8",
    );
    expect(registry).toContain("229 findings");
    expect(registry).toContain("untokenised-colour");
    // And the fixture it would use is real, not a stub.
    const model = decisionCenterFixture({ selected: true });
    expect(model.actionRows?.length).toBeGreaterThan(0);
    expect(model.needsResolutionRows?.length).toBeGreaterThan(0);
    expect(model.inspector).toBeTruthy();
  });
});
