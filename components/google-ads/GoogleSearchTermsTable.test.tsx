import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { GoogleSearchTermsTable } from "@/components/google-ads/GoogleSearchTermsTable";

describe("GoogleSearchTermsTable", () => {
  it("renders report clicks and treats CTR as an already-percent value", () => {
    const markup = renderToStaticMarkup(
      React.createElement(GoogleSearchTermsTable, {
        rows: [
          {
            key: "term-1",
            searchTerm: "metal wall art",
            campaign: "Search",
            clicks: 42,
            conversions: 3,
            spend: 30,
            revenue: 90,
            roas: 3,
            ctr: 21.28,
          },
        ],
        currencyFormatter: (value: number) => `$${value.toFixed(2)}`,
      }),
    );

    expect(markup).toContain(">42<");
    expect(markup).toContain("21.28%");
    expect(markup).not.toContain("2128.00%");
  });
});
