import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthyRow } from "@/components/creatives/briefing/HealthyRow";

describe("HealthyRow", () => {
  it("renders a compact healthy row with label, ROAS, and spend", () => {
    const html = renderToStaticMarkup(
      <HealthyRow
        selected
        card={{
          id: "cr_h1",
          name: "Aphrodite Studs Set",
          brand: "TheSwaf",
          label: "keep",
          spend: 1200,
          roas: 2.42,
        }}
      />,
    );

    expect(html).toContain("Aphrodite Studs Set");
    expect(html).toContain("keep");
    expect(html).toContain("2.42×");
    expect(html).toContain("$1,200");
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("w-7 h-7");
  });
});
