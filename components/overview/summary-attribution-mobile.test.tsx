import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { SummaryAttributionTable } from "@/components/overview/SummaryAttributionTable";

/**
 * The channel comparison, on a phone.
 *
 * At 390px the table's horizontal scroller hid 135px of itself, so a channel's
 * ROAS and conversions sat off-screen with nothing indicating there was more.
 * Someone comparing channels on a phone would compare whichever two columns
 * happened to fit — a scroller that looks like it works and does not.
 */
const source = readFileSync(
  "components/overview/SummaryAttributionTable.tsx",
  "utf8",
);

const ROWS = [
  {
    channel: "Meta",
    spend: 1200,
    revenue: 3600,
    roas: 3,
    conversions: 42,
    clicks: 800,
    ctr: 0.05,
    cpa: 28.5,
    aov: 85.7,
  },
  {
    channel: "Google",
    spend: 900,
    revenue: 1800,
    roas: 2,
    conversions: 20,
    clicks: 500,
    ctr: 0.04,
    cpa: 45,
    aov: 90,
  },
] as never;

describe("channels stay comparable on a phone", () => {
  it("renders a card per channel instead of a scroller", () => {
    const html = renderToStaticMarkup(
      <SummaryAttributionTable rows={ROWS} currencySymbol="$" />,
    );
    expect(html).toContain('data-testid="attribution-cards"');
    expect(html).toContain("Meta");
    expect(html).toContain("Google");
  });

  it("hides the scrolling table below the tablet breakpoint", () => {
    // Not "in addition to" — the scroller is what clipped, so it must not be
    // the thing a phone sees.
    expect(source).toContain(
      'className="hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white md:block"',
    );
    expect(source).toContain('className="flex flex-col gap-2 md:hidden"');
  });

  it("shows every visible metric for a channel, not a truncated subset", () => {
    const html = renderToStaticMarkup(
      <SummaryAttributionTable rows={ROWS} currencySymbol="$" />,
    );
    const cards = html.slice(html.indexOf('data-testid="attribution-cards"'));
    for (const heading of ["Spend", "Revenue", "ROAS", "Conversions"]) {
      expect(cards, `${heading} is missing from the card stack`).toContain(
        heading,
      );
    }
  });

  it("formats a value once, so the phone and the desktop cannot disagree", () => {
    // Two formatters for the same number is how a card ends up showing a
    // different spend than the table for the same row.
    expect(source).toContain("function cellValue(");
    // Only the card markup, not the shared helper it delegates to.
    const markup = source.slice(
      source.indexOf("attribution-cards"),
      source.indexOf("</ul>"),
    );
    expect(markup).toContain("cellValue(row, column.key)");
    const inlineFormatters = markup.match(
      /formatCurrency\(|formatRatio\(|formatCount\(|formatPercent\(/g,
    );
    expect(inlineFormatters, "the card stack formats values inline").toBeNull();
  });
});
