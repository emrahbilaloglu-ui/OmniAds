import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BulkCutConfirmModal,
  bulkCutTrackingPrimaryLabel,
  getBulkCutTotals,
} from "@/components/creatives/briefing/BulkCutConfirmModal";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(index: number, overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: `creative_${index}`,
    creativeId: `creative_${index}`,
    name: `Creative ${index}`,
    campaign: "ASC | Worldwide",
    spend: index * 100,
    roas: index,
    ...overrides,
  };
}

describe("BulkCutConfirmModal", () => {
  it("renders selected cards, totals, and confirm copy", () => {
    const cards = [card(1), card(2), card(3), card(4)];
    const html = renderToStaticMarkup(
      <BulkCutConfirmModal
        open
        cards={cards}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("Cut 4 creatives?");
    expect(html).toContain("Creative 1");
    expect(html).toContain("Creative 4");
    expect(html).toContain("Total spend");
    expect(html).toContain("$1,000");
    expect(html).toContain("Avg ROAS");
    expect(html).toContain("2.50×");
    expect(html).toContain("Confirm cut 4");
    expect(html).toContain("data-confirm-bulk-cut");
  });

  it("hides when closed and exposes totals helpers", () => {
    expect(
      renderToStaticMarkup(
        <BulkCutConfirmModal
          open={false}
          cards={[card(1)]}
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />,
      ),
    ).toBe("");
    expect(getBulkCutTotals([card(1), card(3)])).toEqual({ spend: 400, avgRoas: 2 });
  });

  it("uses tracking-confirm copy for degraded bulk cuts", () => {
    expect(bulkCutTrackingPrimaryLabel(1)).toBe("Cut anyway");
    expect(bulkCutTrackingPrimaryLabel(4)).toBe("Cut 4 anyway");
  });
});
