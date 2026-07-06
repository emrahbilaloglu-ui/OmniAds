import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaWatchingCard } from "@/components/meta/redesign/MetaWatchingCard";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaWatchingCard", () => {
  it("shows the real action when no defer handler exists (no false Let-cook)", () => {
    const html = renderToStaticMarkup(
      <MetaWatchingCard rec={metaRec({ decisionState: "watch", confidenceScore: 0.44 })} />,
    );
    // Without an onDefer handler the primary click opens the real flow, so
    // the label must name it - "Let cook" would promise a defer that the
    // control cannot perform (Codex review: CTA copy must match the click).
    expect(html).toContain("Rebuild in Launchpad");
    expect(html).not.toContain("Let cook");
    expect(html).toContain("44%");
  });

  it("labels the primary Let cook only when it actually defers", () => {
    const html = renderToStaticMarkup(
      <MetaWatchingCard
        rec={metaRec({ decisionState: "watch", confidenceScore: 0.44 })}
        onDefer={() => undefined}
      />,
    );
    expect(html).toContain("Let cook");
  });
});
