import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaEvidenceAccordion, buildMetaEvidenceSections } from "@/components/meta/redesign/MetaEvidenceAccordion";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaEvidenceAccordion", () => {
  it("builds the six Phase 6 evidence sections from persisted trail data", () => {
    const rec = metaRec();
    expect(buildMetaEvidenceSections(rec).map((section) => section.key)).toEqual([
      "decision",
      "inputs",
      "trend",
      "engine",
      "operator",
      "provenance",
    ]);
    const html = renderToStaticMarkup(<MetaEvidenceAccordion rec={rec} />);
    expect(html).toContain("Engine trail");
    expect(html).toContain("Provenance");
  });
});
