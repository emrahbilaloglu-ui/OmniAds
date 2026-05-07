import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";

describe("MetaLaunchpadOverlay", () => {
  it("wraps the shared overlay with Meta launch modes", () => {
    const html = renderToStaticMarkup(
      <MetaLaunchpadOverlay open mode="rebuild" item={{ id: "cmp_1", name: "ASC" }} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(html).toContain("Rebuild in Launchpad");
    expect(html).toContain("ASC");
  });
});
