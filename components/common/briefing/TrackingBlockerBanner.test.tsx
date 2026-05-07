import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrackingBlockerBanner } from "@/components/common/briefing/TrackingBlockerBanner";

describe("TrackingBlockerBanner", () => {
  it("renders the required blocker copy", () => {
    const html = renderToStaticMarkup(<TrackingBlockerBanner />);

    expect(html).toContain("Tracking anomaly detected — engine intelligence may be degraded. Resolve before acting on cuts.");
    expect(html).toContain("border-l-rose-500");
    expect(html).toContain("data-tracking-blocker");
  });

  it("renders detail and dismiss actions when provided", () => {
    const html = renderToStaticMarkup(
      <TrackingBlockerBanner onViewDetails={() => undefined} onDismiss={() => undefined} />,
    );

    expect(html).toContain("View details");
    expect(html).toContain("aria-label=\"Dismiss tracking blocker\"");
  });

  it("hides when visible is false", () => {
    expect(renderToStaticMarkup(<TrackingBlockerBanner visible={false} />)).toBe("");
  });
});
