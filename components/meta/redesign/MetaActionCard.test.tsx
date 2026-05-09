import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";
import { metaAnomaly, metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaActionCard", () => {
  it("renders campaign role, bid regime, confidence, and evidence", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec()} selected />);
    expect(html).toContain("ASC Prospecting needs a cleaner rebuild");
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("Lowest Cost");
    expect(html).toContain("82%");
    expect(html).toContain("What does Defer 24h do?");
  });

  it("renders anomaly cards in diagnostic mode", () => {
    const html = renderToStaticMarkup(<MetaActionCard anomaly={metaAnomaly({
      diagnosticLadder: [{ step: 1, label: "Tracking", detail: "Check events first." }],
    })} />);
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Open diagnostic");
    expect(html).toContain("Tracking");
    expect(html).toContain("Check events first.");
  });
});
