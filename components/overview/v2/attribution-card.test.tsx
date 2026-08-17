import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttributionCard } from "@/components/overview/v2/attribution-card";
import type { OverviewAttributionRow } from "@/src/types/models";

function row(overrides: Partial<OverviewAttributionRow> = {}): OverviewAttributionRow {
  return {
    channel: "Meta Ads",
    spend: 1_200,
    revenue: 3_600,
    roas: 3,
    conversions: 42,
    clicks: 800,
    ctr: 5,
    cpa: 28.5,
    aov: 85.71,
    source: "meta",
    spendShare: 58,
    ...overrides,
  };
}

function render(rows: OverviewAttributionRow[] = [row()]) {
  return renderToStaticMarkup(<AttributionCard rows={rows} currencySymbol="$" />);
}

describe("Dashboard v2 attribution card", () => {
  it("renders the canonical fixed columns in their exact order", () => {
    const html = render();
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    const labels = ["Channel", "Spend ↓", "Revenue", "ROAS", "CPA", "AOV", "Conv.", "Share"];

    let cursor = -1;
    for (const label of labels) {
      const next = head.indexOf(label);
      expect(next, `${label} is missing or out of order`).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(head).not.toContain("<button");
    expect(head.match(/font-size:10px/g)).toHaveLength(8);
  });

  it("keeps Columns as a plain button without a picker or optional metrics", () => {
    const html = render();
    const columnsButton = html.match(/<button[^>]*>Columns<\/button>/)?.[0];

    expect(columnsButton).toBeTruthy();
    expect(columnsButton).not.toContain("aria-expanded");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain(">Clicks<");
    expect(html).not.toContain(">CTR<");
  });

  it("renders adapter-provided spend share instead of deriving revenue share", () => {
    const html = render([
      row({ spend: 900, revenue: 9_900, spendShare: 13 }),
      row({
        channel: "Google Ads",
        source: "google",
        spend: 100,
        revenue: 100,
        spendShare: 7,
      }),
    ]);

    expect(html).toContain('style="width:13%"');
    expect(html).toContain(">13%</span>");
    expect(html).toContain('style="width:7%"');
    expect(html).toContain(">7%</span>");
    expect(html).not.toContain(">99%</span>");
  });

  it("uses an em dash and an empty bar when spend share is unavailable", () => {
    const html = render([row({ spendShare: null })]);

    expect(html).toContain('style="width:0%"');
    expect(html).toContain(">—</span>");
  });

  it("matches the canonical nine-pixel channel gap", () => {
    expect(render()).toContain('style="gap:9px"');
  });

  it("uses canonical en-US punctuation independent of the host locale", () => {
    const html = render([row({ spend: 1_200, revenue: 3_600, cpa: 28.5, aov: 85.71, conversions: 1_234 })]);

    expect(html).toContain("$1,200");
    expect(html).toContain("$3,600");
    expect(html).toContain("$28.50");
    expect(html).toContain("$85.71");
    expect(html).toContain(">1,234</td>");
  });

  it("keeps the reference input unbound and fixes the first column to 16px on both sides", () => {
    const html = render();
    const input = html.match(/<input[^>]+>/)?.[0] ?? "";

    expect(input).not.toContain("adv-input");
    expect(input).not.toContain("value=");
    expect(input).toContain("outline:none");
    expect(html).toContain('style="font-size:10px;padding:9px 16px"');
    expect(html).toContain('style="padding:11px 16px"');
    expect(html).not.toContain("No attributed channels for this window.");
  });
});
