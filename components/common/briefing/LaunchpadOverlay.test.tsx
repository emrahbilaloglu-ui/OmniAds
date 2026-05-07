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
    expect(html).toContain("Apply bid cap $22");
  });

  it("renders accessible modal attributes and hides when closed", () => {
    const openHtml = renderToStaticMarkup(
      <LaunchpadOverlay
        open
        mode="apply_bid"
        item={{ id: "bid", scopeName: "Campaign A", currentBidCap: 18, proposedBidCap: 24 }}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(openHtml).toContain("role=\"dialog\"");
    expect(openHtml).toContain("Current cap $18");
    expect(renderToStaticMarkup(
      <LaunchpadOverlay open={false} mode="promote" item={{ id: "x" }} onClose={() => undefined} onConfirm={() => undefined} />,
    )).toBe("");
  });
});
