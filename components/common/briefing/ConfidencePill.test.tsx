import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfidencePill, confidenceClass } from "@/components/common/briefing/ConfidencePill";

describe("ConfidencePill", () => {
  it("classifies high, mid, and low confidence tiers", () => {
    expect(confidenceClass(88)).toMatchObject({ tier: "high", thumb: "lg", primaryStyle: "filled" });
    expect(confidenceClass(56)).toMatchObject({ tier: "mid", thumb: "md", primaryStyle: "filled" });
    expect(confidenceClass(31)).toMatchObject({ tier: "low", thumb: "sm", primaryStyle: "outline" });
  });

  it("renders default and small pill variants", () => {
    const html = renderToStaticMarkup(
      <>
        <ConfidencePill confidence={88.4} />
        <ConfidencePill confidence={42} size="sm" />
      </>,
    );

    expect(html).toContain("88%");
    expect(html).toContain("42%");
    expect(html).toContain("text-[10.5px]");
    expect(html).toContain("text-[10px]");
  });
});
