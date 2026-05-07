import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceAccordion, type EvidenceAccordionSection } from "@/components/common/briefing/EvidenceAccordion";

const sections: EvidenceAccordionSection[] = [
  "Decision",
  "Inputs",
  "Funnel",
  "Engine trail",
  "Operator response",
  "Provenance",
].map((title, index) => ({
  key: title.toLowerCase().replaceAll(" ", "-"),
  title,
  content: <span>{title} content</span>,
  defaultOpen: index === 0,
}));

describe("EvidenceAccordion", () => {
  it("renders the six-section creative accordion with aria-expanded", () => {
    const html = renderToStaticMarkup(<EvidenceAccordion sections={sections} />);

    expect(html).toContain("Decision content");
    expect(html).toContain("Provenance content");
    expect(html).toContain("ml-[44px]");
    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("aria-expanded=\"false\"");
  });

  it("renders meta and legacy variants", () => {
    const html = renderToStaticMarkup(
      <>
        <EvidenceAccordion sections={sections} variant="meta" />
        <EvidenceAccordion sections={sections.slice(0, 1)} variant="legacy" />
      </>,
    );

    expect(html).toContain("hover:bg-slate-50 text-[12px]");
    expect(html).toContain("uppercase tracking-[0.12em]");
  });

  it("hides for an empty section list", () => {
    expect(renderToStaticMarkup(<EvidenceAccordion sections={[]} />)).toBe("");
  });
});
