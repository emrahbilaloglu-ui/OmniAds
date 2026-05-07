import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BulkToolbar, shouldConfirmBulkAction } from "@/components/common/briefing/BulkToolbar";

describe("BulkToolbar", () => {
  it("hides when count is zero", () => {
    expect(renderToStaticMarkup(<BulkToolbar selectedCount={0} />)).toBe("");
  });

  it("renders creative bulk actions", () => {
    const html = renderToStaticMarkup(<BulkToolbar selectedCount={3} scope="action" />);

    expect(html).toContain("3 selected");
    expect(html).toContain("Cut all");
    expect(html).toContain("Compare side-by-side");
    expect(html).toContain("data-bulk=\"action\"");
  });

  it("can render a restricted creative action set for Watching", () => {
    const html = renderToStaticMarkup(
      <BulkToolbar
        selectedCount={2}
        scope="watching"
        actions={["launch_new", "add_existing", "compare", "clear"]}
      />,
    );

    expect(html).toContain("2 selected");
    expect(html).toContain("Launch new test");
    expect(html).toContain("Add to existing");
    expect(html).toContain("Compare side-by-side");
    expect(html).toContain("data-bulk=\"watching\"");
    expect(html).not.toContain("Cut all");
    expect(html).not.toContain("Demote all");
  });

  it("renders meta bulk actions and tracking blocker note", () => {
    const html = renderToStaticMarkup(<BulkToolbar selectedCount={2} variant="meta" trackingBlocked />);

    expect(html).toContain("Apply bid changes");
    expect(html).toContain("Duplicate to test");
    expect(html).toContain("Tracking degraded — Cut requires confirmation.");
  });

  it("routes destructive actions through tracking confirmation", () => {
    expect(shouldConfirmBulkAction("cut", true)).toBe(true);
    expect(shouldConfirmBulkAction("rebuild", true)).toBe(true);
    expect(shouldConfirmBulkAction("compare", true)).toBe(false);
    expect(shouldConfirmBulkAction("cut", false)).toBe(false);
  });

  it("can leave tracking confirmation to the consuming surface", () => {
    const html = renderToStaticMarkup(
      <BulkToolbar
        selectedCount={3}
        trackingBlocked
        trackingConfirmBehavior="consumer"
        stickyTop="170px"
      />,
    );

    expect(html).toContain("Cut all");
    expect(html).toContain("top:170px");
    expect(html).not.toContain("Tracking is degraded.");
  });
});
