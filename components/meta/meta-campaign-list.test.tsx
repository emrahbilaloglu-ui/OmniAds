import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-currency", () => ({
  useCurrencySymbol: () => "$",
}));

const { MetaCampaignList } = await import("@/components/meta/meta-campaign-list");

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "Campaign One",
    status: "ACTIVE",
    objective: "Sales",
    roas: 3.2,
    spend: 1200,
    laneLabel: "Scaling",
    ...overrides,
  };
}

describe("MetaCampaignList render contract", () => {
  it("renders the account overview row and visible campaign subset", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignList
        campaigns={[campaign() as any]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Account Overview");
    expect(html).toContain("Campaign One");
    expect(html).toContain("Sales");
    expect(html).toContain("spend");
    expect(html).toContain("3.20");
  });

  it("reflects the selected campaign row in the rendered active-row semantics", () => {
    const selectedHtml = renderToStaticMarkup(
      <MetaCampaignList
        campaigns={[campaign() as any]}
        selectedId="cmp_1"
        onSelect={vi.fn()}
      />,
    );
    const unselectedHtml = renderToStaticMarkup(
      <MetaCampaignList
        campaigns={[campaign() as any]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(selectedHtml).toContain("Campaign One</p>");
    expect(selectedHtml).toContain("text-foreground");
    expect(unselectedHtml).toContain("text-slate-700");
  });

  it("sorts campaign rows by spend after the operator lookup was archived", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignList
        campaigns={[
          campaign({ id: "cmp_low", name: "Low Spend", spend: 100 }) as any,
          campaign({ id: "cmp_high", name: "High Spend", spend: 900 }) as any,
          campaign({ id: "cmp_mid", name: "Mid Spend", spend: 500 }) as any,
        ]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(html.indexOf("High Spend")).toBeLessThan(html.indexOf("Mid Spend"));
    expect(html.indexOf("Mid Spend")).toBeLessThan(html.indexOf("Low Spend"));
  });
});
