import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CustomizeKpisModal,
  type KpiCatalogEntry,
} from "@/components/common/briefing/CustomizeKpisModal";

const CATALOG: KpiCatalogEntry[] = [
  {
    key: "spend",
    label: "Spend",
    group: "Performance",
    description: "Total spend.",
  },
  {
    key: "roas",
    label: "ROAS",
    group: "Performance",
    description: "Return on ad spend.",
  },
  {
    key: "hookScore",
    label: "Hook score",
    group: "Creative scores",
    description: "0–100 score for hook strength.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
];

describe("CustomizeKpisModal", () => {
  it("renders nothing when closed", () => {
    expect(
      renderToStaticMarkup(
        <CustomizeKpisModal
          open={false}
          catalog={CATALOG}
          selectedKeys={["spend"]}
          onClose={() => undefined}
          onApply={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it("renders selected list, catalog groups, and an about panel when open", () => {
    const html = renderToStaticMarkup(
      <CustomizeKpisModal
        open
        catalog={CATALOG}
        selectedKeys={["spend", "roas"]}
        presetLabel="Facebook Ecommerce"
        onClose={() => undefined}
        onApply={() => undefined}
      />,
    );

    expect(html).toContain("Customize KPIs");
    expect(html).toContain("preset · Facebook Ecommerce");
    expect(html).toContain("Selected (2)");
    expect(html).toContain(">Performance<");
    expect(html).toContain(">Creative scores<");
    expect(html).toContain("Requires the creative scoring pipeline.");
    expect(html).toContain("Cancel");
    expect(html).toContain("Apply");
  });

  it("renders Save as new preset input when onSaveAsNewPreset is provided", () => {
    const html = renderToStaticMarkup(
      <CustomizeKpisModal
        open
        catalog={CATALOG}
        selectedKeys={["spend"]}
        onClose={() => undefined}
        onApply={() => undefined}
        onSaveAsNewPreset={() => undefined}
      />,
    );

    expect(html).toContain('placeholder="New preset name"');
    expect(html).toContain("Save as new preset");
  });
});
