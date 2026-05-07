import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaAlertsStrip } from "@/components/meta/redesign/MetaAlertsStrip";
import { metaAnomaly } from "@/components/meta/redesign/test-fixtures";

describe("MetaAlertsStrip", () => {
  it("renders calm fallback when empty", () => {
    const html = renderToStaticMarkup(<MetaAlertsStrip anomalies={[]} snapshotDate="2026-05-07" />);
    expect(html).toContain("No active anomalies");
  });

  it("renders active anomaly summary", () => {
    const html = renderToStaticMarkup(<MetaAlertsStrip anomalies={[metaAnomaly()]} />);
    expect(html).toContain("1 active anomaly");
    expect(html).toContain("Broad Adset");
  });
});
