// @vitest-environment jsdom
/**
 * CODEX C18 — the held verdict must reach the DOM of the drawer an operator
 * actually opens.
 *
 * A creative row's "Review evidence" answers with `setCreativeDrill`, which
 * renders `CreativeEvidenceWindowExact`. The engine's held verdict reached that
 * drawer's ADAPTER and stopped there, twice over:
 *
 *   1. the component declared `authority` on its view model and never read it;
 *   2. `metaBuyerCreativeEvidenceViewModel` — the page's own wrapper — rebuilt
 *      the model and replaced the entire authority block with a single generic
 *      "Review this recommendation in Meta Ads" sentence.
 *
 * So a held Refresh published "Keep monitoring" and said nothing about the
 * Refresh the engine had concluded, or why it was withheld.
 *
 * WHAT THIS MOUNTS, precisely: the real adapter, the real page wrapper, and the
 * real component — the whole path the defect lived in. It does NOT mount the
 * page shell around them; that would require the page's entire mock surface and
 * would not exercise anything this does not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { CreativeEvidenceWindowExact } from "@/components/creatives/CreativeEvidenceWindowExact";
import { buildCreativeEvidenceWindowExactViewModel } from "@/components/creatives/creative-evidence-window-exact-adapter";
import { metaBuyerCreativeEvidenceViewModel } from "@/components/meta/redesign/MetaPlatformPage";

const HELD_RESOLUTION_CODE = "refresh_ad_lifecycle_evidence";

function heldRefreshDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "os_ad_held",
    decisionId: "decision_held_refresh",
    providerAccountId: "act_1",
    adId: "120210000000012345",
    adName: "Held Ad",
    campaignId: "cmp_1",
    adsetId: "set_1",
    creativeId: "creative_1",
    lane: "blocked",
    publishedLabel: "keep",
    heldAction: "refresh",
    heldResolution: {
      code: HELD_RESOLUTION_CODE,
      label: "Refresh ad lifecycle evidence",
      owner: "system",
      detail: null,
    },
    action: {
      code: "keep",
      label: "Keep monitoring",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: null,
    },
    blockers: [],
    resolution: null,
    metrics: { spend: 100, purchases: 2, roas: 1.2 },
    ...overrides,
  } as never;
}

/** The composition the page renders, through both real mappers. */
function mount(decision: unknown) {
  const model = metaBuyerCreativeEvidenceViewModel(
    buildCreativeEvidenceWindowExactViewModel({
      decision: decision as never,
      canonical: null,
    }),
    // A refused primary authority: exactly what `authorizeMetaNativeAdPause`
    // produces for a held row, and the value that used to overwrite everything.
    {
      kind: "native_ad_pause",
      offered: false,
      refusalReason: "This recommendation can be reviewed, but it cannot pause this ad.",
    },
  );
  return render(
    <CreativeEvidenceWindowExact viewModel={model} onClose={() => {}} />,
  );
}

describe("the creative evidence drawer states the held verdict", () => {
  afterEach(() => cleanup());

  it("renders the held verdict in buyer copy", () => {
    const { container } = mount(heldRefreshDecision());
    const held = container.querySelector("[data-creative-evidence-held-verdict]");
    expect(held).not.toBeNull();
    expect(held?.textContent).toContain("Recommendation awaiting review: Refresh creative");
    // The engine's own token never reaches a pixel.
    expect(container.textContent).not.toContain(HELD_RESOLUTION_CODE);
    expect(held?.textContent).not.toContain("refresh");
  });

  it("renders WHY it is held, and names the held verdict in the reason", () => {
    const { container } = mount(heldRefreshDecision());
    const reason = container.querySelector("[data-creative-evidence-held-reason]");
    expect(reason?.textContent ?? "").toMatch(/\S/);
    expect(reason?.textContent).toContain("Refresh creative");
  });

  it("keeps the published label visible beside it", () => {
    // The held verdict is an ADDITIONAL fact, not a replacement: the published
    // label is still what authority allows and is still true.
    const { container } = mount(heldRefreshDecision());
    expect(container.textContent).toContain("Keep monitoring");
  });

  it("offers no enabled mutation control on a held row", () => {
    const { container } = mount(heldRefreshDecision());
    const mutating = Array.from(container.querySelectorAll("button")).filter(
      (button) =>
        !button.hasAttribute("disabled") &&
        /pause|apply|execute/i.test(button.textContent ?? ""),
    );
    expect(mutating).toEqual([]);
    const mutatingLinks = Array.from(container.querySelectorAll("a[href]")).filter(
      (anchor) => /pause|apply|execute/i.test(anchor.textContent ?? ""),
    );
    expect(mutatingLinks).toEqual([]);
  });

  it("renders nothing held for a decision that is not held", () => {
    // The control: without it, a component that always printed the block would
    // satisfy every assertion above.
    const { container } = mount(
      heldRefreshDecision({ heldAction: null, heldResolution: null }),
    );
    expect(
      container.querySelector("[data-creative-evidence-held-verdict]"),
    ).toBeNull();
  });
});
