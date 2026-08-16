import { describe, expect, it } from "vitest";

import { CUSTOM_REPORT_TEMPLATES } from "@/lib/custom-reports";

describe("Dashboard v2 report template gallery", () => {
  it("keeps the seven reference templates wired to editable report definitions", () => {
    expect(CUSTOM_REPORT_TEMPLATES.map((template) => template.name)).toEqual([
      "Executive Overview",
      "Meta Deep Dive",
      "Creative Performance Review",
      "Meta Creative Briefs",
      "Store Economics",
      "Channel Mix",
      "SEO & AI Visibility",
    ]);
    expect(
      CUSTOM_REPORT_TEMPLATES.every((template) =>
        template.definition.widgets.some((widget) => Boolean(widget.dataSource)),
      ),
    ).toBe(true);
  });
});
