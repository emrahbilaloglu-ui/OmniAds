import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTION_LAUNCH_HREF,
  EmptyActionState,
} from "@/components/creatives/briefing/EmptyActionState";

describe("EmptyActionState", () => {
  it("renders the good-day empty state with counts and launch action", () => {
    const html = renderToStaticMarkup(
      <EmptyActionState
        matureCount={18}
        watchingCount={4}
        onLaunchNewTest={() => undefined}
        onBrowseAssetLibrary={() => undefined}
      />,
    );

    expect(html).toContain("Nothing for you to do right now.");
    expect(html).toContain("18 mature creatives · 4 watching · Data is loaded in the lanes below");
    expect(html).toContain("Triage clear");
    expect(html).toContain("Expand Watching below");
    expect(html).toContain("Browse Asset Library");
    expect(html).toContain('data-empty-action="browse-asset-library"');
    expect(html).toContain("Launch a new test");
    expect(html).toContain("data-empty-action-state");
  });

  it("uses the Phase 3 Launchpad fresh-test URL contract", () => {
    expect(EMPTY_ACTION_LAUNCH_HREF).toBe("/platforms/meta/launchpad?fromBriefing=true&mode=fresh_test");
  });
});
