import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaWatchingCard } from "@/components/meta/redesign/MetaWatchingCard";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaWatchingCard", () => {
  it("shows the server-owned review action when no defer handler exists", () => {
    const html = renderToStaticMarkup(
      <MetaWatchingCard rec={metaRec({ decisionState: "watch", confidenceScore: 0.44 })} />,
    );
    // The watch projection is server-owned review_drill. The card must not
    // recover a Launchpad action from the legacy rebuild label.
    expect(html).toContain("Open diagnostics");
    expect(html).not.toContain("Let cook");
    // Cards expose the server confidence band without leaking a numeric score;
    // detailed evidence remains in the inspector.
    expect(html).toContain('data-confidence-band');
    expect(html).toContain("High");
    expect(html).not.toContain("0.44");
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
