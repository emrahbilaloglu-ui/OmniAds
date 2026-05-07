import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFER_TOOLTIP_BODY,
  DEFER_TOOLTIP_TITLE,
  DeferTooltip,
} from "@/components/common/briefing/DeferTooltip";

describe("DeferTooltip", () => {
  it("explains the 24 hour defer behavior for hover and focus", () => {
    const html = renderToStaticMarkup(
      <DeferTooltip>
        <button type="button">Defer 24h</button>
      </DeferTooltip>,
    );

    expect(html).toContain("role=\"tooltip\"");
    expect(html).toContain(DEFER_TOOLTIP_TITLE);
    expect(html).toContain(DEFER_TOOLTIP_BODY);
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-focus-within:opacity-100");
  });
});
