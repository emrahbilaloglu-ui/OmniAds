import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaPulse } from "@/components/meta/redesign/MetaPulse";
import { metaPulse } from "@/components/meta/redesign/test-fixtures";

describe("MetaPulse", () => {
  it("renders date selector, KPI band, and engine status", () => {
    const html = renderToStaticMarkup(
      <MetaPulse pulse={metaPulse()} window="28d" onWindowChange={vi.fn()} />,
    );
    expect(html).toContain("Date: 28d");
    expect(html).toContain("Spend");
    expect(html).toContain("v3.6.0-meta-taxonomy");
  });

  it("renders unknown placeholders before pulse data loads", () => {
    const html = renderToStaticMarkup(
      <MetaPulse pulse={null} window="28d" onWindowChange={vi.fn()} />,
    );

    expect(html).toContain("Loading campaigns");
    expect(html).toContain("unknown");
    expect(html).not.toContain("$0");
  });
});
