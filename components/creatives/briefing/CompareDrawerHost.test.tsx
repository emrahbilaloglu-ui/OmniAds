import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompareDrawerHost } from "@/components/creatives/briefing/CompareDrawerHost";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(
  index: number,
  roas: number,
  overrides: Partial<BriefingCreativeCard> = {},
): BriefingCreativeCard {
  return {
    id: `creative_${index}`,
    creativeId: `creative_${index}`,
    name: `Creative ${index}`,
    brand: "TheSwaf",
    label: index === 1 ? "cut" : "scale",
    spend: index * 100,
    roas,
    ctr: 1 + index / 10,
    cpa: 20 + index,
    purchases: index * 3,
    frequency: 1 + index / 5,
    ...overrides,
  };
}

describe("CompareDrawerHost", () => {
  it("renders compare drawer with briefing action bar", () => {
    const html = renderToStaticMarkup(
      <CompareDrawerHost
        open
        cards={[card(1, 0.7), card(2, 3.1), card(3, 2.2)]}
        onClose={() => undefined}
        onCutCard={() => undefined}
        onLaunchpad={() => undefined}
      />,
    );

    expect(html).toContain("3 creatives");
    expect(html).toContain("aligned metrics and media previews");
    expect(html).not.toContain("adsecute.app");
    expect(html).toContain("Creative 1");
    expect(html).toContain("Creative 3");
    expect(html).not.toContain("data-compare-action=\"cut-weakest\"");
    expect(html).toContain("data-compare-action=\"scale-strongest\"");
    expect(html).toContain("data-compare-action=\"launch-test\"");
    expect(html).toContain("Send selected to Launchpad");
  });

  it("hides bulk action controls when canonical cards are blocked", () => {
    const blockedCanonical = {
      classification: {
        decisionState: "blocked",
        buyerAction: null,
        buyerLabel: "Cut pending",
        executionAction: null,
        heldAction: "cut",
      },
      sourceAuthority: {
        status: "native_exact",
        actionEligible: false,
        authorizedAction: null,
      },
    } as never;
    const html = renderToStaticMarkup(
      <CompareDrawerHost
        open
        cards={[
          card(1, 0.7, { canonicalDecision: blockedCanonical }),
          card(2, 3.1, { canonicalDecision: blockedCanonical }),
        ]}
        onClose={() => undefined}
        onCutCard={() => undefined}
        onLaunchpad={() => undefined}
      />,
    );

    expect(html).not.toContain("data-compare-action=");
    expect(html).not.toContain("Send selected to Launchpad");
    expect(html).not.toContain(">Fresh Test<");
    expect(html).toContain("Cut pending");
  });

  it("hides when closed", () => {
    expect(
      renderToStaticMarkup(
        <CompareDrawerHost
          open={false}
          cards={[card(1, 0.7)]}
          onClose={() => undefined}
          onCutCard={() => undefined}
          onLaunchpad={() => undefined}
        />,
      ),
    ).toBe("");
  });
});
