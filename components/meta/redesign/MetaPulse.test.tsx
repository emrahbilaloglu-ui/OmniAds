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
    expect(html).toContain("Date:");
    expect(html).toContain("Spend");
    expect(html).toContain("v3.6.0-meta-taxonomy");
  });
});
