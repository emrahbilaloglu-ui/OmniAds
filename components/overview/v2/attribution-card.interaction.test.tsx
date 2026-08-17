// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { OverviewAttributionRow } from "@/src/types/models";
import { AttributionCard } from "./attribution-card";

const rows: OverviewAttributionRow[] = ["Meta Ads", "Google Ads", "Klaviyo", "Organic · GA4"].map((channel) => ({
  channel,
  spend: null,
  spendShare: null,
  revenue: null,
  roas: null,
  conversions: null,
  clicks: null,
  ctr: null,
  cpa: null,
  aov: null,
  source: "test",
}));

afterEach(cleanup);

describe("Dashboard v2 attribution input state", () => {
  it("accepts typing without filtering or repainting the fixed four rows", () => {
    const { container } = render(<AttributionCard rows={rows} currencySymbol="$" />);
    const input = screen.getByRole("textbox", { name: "Filter channels" }) as HTMLInputElement;
    const border = input.style.border;

    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "no-match" } });

    expect(input.value).toBe("no-match");
    expect(input.style.border).toBe(border);
    expect(container.querySelectorAll("[data-overview-channel]")).toHaveLength(4);
    expect(screen.queryByText("No attributed channels for this window.")).toBeNull();
  });
});
