// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import type {
  CreativeStudioExactProps,
  CreativeStudioTabId,
} from "@/components/creatives/creative-studio-exact-types";

/**
 * The reference builds the row as
 * `[['assets','Assets',8], ['copies','Copies',0], ['landers','Landing Pages',0],
 *   ['inbox','Inbox',5], ['audiences','Audiences',0]]` with `count: d[2] || ''`.
 *
 * Two facts to pin: the count belongs to the TAB rather than to whichever pill
 * is lit, and a zero draws no chip at all.
 */

const TAB_HREFS: Record<CreativeStudioTabId, string> = {
  assets: "/platforms/meta/creatives",
  copies: "/platforms/meta/copies",
  "landing-pages": "/platforms/meta/landing-pages",
  inbox: "/platforms/meta/creative-inbox",
  audiences: "/platforms/meta/audiences",
};

function renderTabs(
  activeTab: CreativeStudioTabId,
  counts: CreativeStudioExactProps["counts"],
) {
  return render(
    <CreativeStudioExact
      activeTab={activeTab}
      counts={counts}
      tabHrefs={TAB_HREFS}
    />,
  );
}

const TAB_LABELS: Record<CreativeStudioTabId, string> = {
  assets: "Assets",
  copies: "Copies",
  "landing-pages": "Landing Pages",
  inbox: "Inbox",
  audiences: "Audiences",
};

/** The chip text for each tab, `""` where the tab carries no chip. */
function chips(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tab of Object.keys(TAB_HREFS) as CreativeStudioTabId[]) {
    const text =
      document
        .querySelector(`[data-creative-studio-tab="${tab}"]`)
        ?.textContent?.trim() ?? "";
    result[tab] = text.replace(TAB_LABELS[tab], "").trim();
  }
  return result;
}

afterEach(cleanup);

describe("Creative Studio tab counts", () => {
  it("gives a chip to exactly the two tabs the reference chips", () => {
    // Copies, Landing Pages and Audiences are zero in every state of the
    // reference, so `count: d[2] || ''` draws nothing for them — ever, on any
    // route. The builder cannot express a count for them at all.
    expect(
      Object.keys(buildCreativeStudioTabCounts({ assets: 8, inbox: 5 })).sort(),
    ).toEqual(["assets", "inbox"]);
  });

  it("hides an unserved count instead of moving the chip to the active tab", () => {
    // The defect: the Assets pill carried the chip on /creatives and the Copies
    // pill carried it on /copies, because each route passed only its own tab.
    renderTabs("copies", buildCreativeStudioTabCounts({}));

    const row = chips();
    expect(row.assets).toBe("");
    expect(
      document.querySelector('[data-creative-studio-tab="inbox"]'),
    ).toBeNull();
    expect(row.copies).toBe("");
    expect(row["landing-pages"]).toBe("");
    expect(row.audiences).toBe("");
  });

  it("keeps the same chip set when the active tab changes", () => {
    const counts = buildCreativeStudioTabCounts({ assets: 34 });

    renderTabs("assets", counts);
    const onAssets = chips();
    cleanup();
    renderTabs("audiences", counts);
    const onAudiences = chips();

    expect(onAssets).toEqual(onAudiences);
    expect(onAssets.assets).toBe("34");
    expect(
      document.querySelector('[data-creative-studio-tab="inbox"]'),
    ).toBeNull();
  });

  it("draws no chip for a served zero, as the reference does", () => {
    renderTabs("assets", buildCreativeStudioTabCounts({ assets: 0, inbox: 0 }));

    const row = chips();
    expect(row.assets).toBe("");
    expect(row.inbox).toBe("");
  });

  it("serves the visible Assets number without restoring the Inbox tab", () => {
    renderTabs("inbox", buildCreativeStudioTabCounts({ assets: 8, inbox: 5 }));

    const row = chips();
    expect(row.assets).toBe("8");
    expect(row.inbox).toBe("");
    expect(
      document.querySelector('[data-creative-studio-tab="inbox"]'),
    ).toBeNull();
  });
});
