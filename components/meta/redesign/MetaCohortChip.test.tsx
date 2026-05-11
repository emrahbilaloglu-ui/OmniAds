import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaCohortChip } from "@/components/meta/redesign/MetaCohortChip";

describe("MetaCohortChip", () => {
  it("does not render for purchase cohort", () => {
    expect(renderToStaticMarkup(<MetaCohortChip cohort="purchase" />)).toBe("");
  });

  it("does not render for null cohort", () => {
    expect(renderToStaticMarkup(<MetaCohortChip cohort={null} />)).toBe("");
  });

  it("does not render for undefined cohort", () => {
    expect(renderToStaticMarkup(<MetaCohortChip cohort={undefined} />)).toBe("");
  });

  it("renders upper-funnel cohort", () => {
    const html = renderToStaticMarkup(<MetaCohortChip cohort="upper_funnel" />);
    expect(html).toContain("Upper-funnel");
    expect(html).toContain('data-cohort-chip="upper_funnel"');
  });

  it("renders mid-funnel cohort", () => {
    const html = renderToStaticMarkup(<MetaCohortChip cohort="mid_funnel" />);
    expect(html).toContain("Mid-funnel");
  });

  it("renders unknown cohort", () => {
    const html = renderToStaticMarkup(<MetaCohortChip cohort="unknown" />);
    expect(html).toContain("Unknown goal");
  });
});
