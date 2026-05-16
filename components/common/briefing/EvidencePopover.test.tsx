import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidencePopover } from "@/components/common/briefing/EvidencePopover";

const sections = [
  {
    key: "decision",
    title: "Decision",
    content: <div>Decision evidence</div>,
  },
];

describe("EvidencePopover", () => {
  it("renders the default modal presentation", () => {
    const html = renderToStaticMarkup(
      <EvidencePopover open title="Evidence" sections={sections} onClose={() => undefined} />,
    );

    expect(html).toContain('data-evidence-presentation="modal"');
    expect(html).toContain("max-w-[620px]");
  });

  it("renders the drawer presentation for briefing card evidence", () => {
    const html = renderToStaticMarkup(
      <EvidencePopover
        open
        title="Evidence"
        sections={sections}
        presentation="drawer"
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('data-evidence-presentation="drawer"');
    expect(html).toContain("md:right-0");
    expect(html).toContain("Decision evidence");
  });
});
