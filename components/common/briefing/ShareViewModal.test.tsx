import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShareViewModal } from "@/components/common/briefing/ShareViewModal";

describe("ShareViewModal", () => {
  it("renders nothing when closed", () => {
    expect(
      renderToStaticMarkup(
        <ShareViewModal
          open={false}
          presetLabel="Creative teams"
          itemCount={4}
          onClose={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it("renders audience picker, options, and a default share URL when open", () => {
    const html = renderToStaticMarkup(
      <ShareViewModal
        open
        presetLabel="Creative teams"
        itemCount={4}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Share view");
    expect(html).toContain("preset · Creative teams · 4 creatives");
    expect(html).toContain(">Buyer<");
    expect(html).toContain(">Creative team<");
    expect(html).toContain(">External<");
    expect(html).toContain("Hide all decision language");
    expect(html).toContain("Freeze data snapshot");
    expect(html).toContain("/share/creative/[token]");
    expect(html).toContain("Create share link");
  });

  it("uses a custom buildShareUrl when provided", () => {
    const html = renderToStaticMarkup(
      <ShareViewModal
        open
        presetLabel="Creative teams"
        itemCount={4}
        buildShareUrl={(state) => `https://example.com/${state.audience}`}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("https://example.com/creative_team");
  });
});
