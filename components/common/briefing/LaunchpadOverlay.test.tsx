import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaunchpadOverlay, type LaunchpadOverlayMode } from "@/components/common/briefing/LaunchpadOverlay";

const modes: LaunchpadOverlayMode[] = ["promote", "demote", "fresh_test", "rebuild", "duplicate", "apply_bid"];

describe("LaunchpadOverlay", () => {
  it("renders every Launchpad mode", () => {
    const html = renderToStaticMarkup(
      <>
        {modes.map((mode) => (
          <LaunchpadOverlay
            key={mode}
            open
            mode={mode}
            item={{ id: mode, name: "Aphrodite Hook", brand: "TheSwaf", campaign: "ASC", label: "scale" }}
            onClose={() => undefined}
            onConfirm={() => undefined}
          />
        ))}
      </>,
    );

    expect(html).toContain("Promote to main");
    expect(html).toContain("Demote to test (Mode B)");
    expect(html).toContain("Launch fresh test (Mode A)");
    expect(html).toContain("Rebuild in Launchpad");
    expect(html).toContain("Duplicate to test");
    // Honesty: with no real bid data on the item, the title carries no fabricated cap
    // (the old "$22"/"$18" placeholders are gone).
    expect(html).toContain("Apply bid cap");
    expect(html).not.toContain("$22");
    expect(html).not.toContain("$18");
  });

  it("renders accessible modal attributes and hides when closed", () => {
    const openHtml = renderToStaticMarkup(
      <LaunchpadOverlay
        open
        mode="apply_bid"
        item={{ id: "bid", scopeName: "Campaign A", currentBidCap: 18, proposedBidCap: 24, currencyCode: "USD" }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(openHtml).toContain("role=\"dialog\"");
    // Real caps, formatted in the account currency (not a hardcoded "$").
    expect(openHtml).toContain("Current cap $18.00 → proposed $24.00");
    expect(renderToStaticMarkup(
      <LaunchpadOverlay open={false} mode="promote" item={{ id: "x" }} onClose={() => undefined} onConfirm={() => undefined} />,
    )).toBe("");
  });
});
