import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MetaAudiencesPage from "./legacy-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("businessId=biz_1&providerAccountId=act_1"),
}));

describe("MetaAudiencesPage", () => {
  it("renders an honest planned/readiness surface without placeholder audience metrics", () => {
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain("data-testid=\"audience-readiness-ledger\"");
    expect(html).toContain("No live audience contract");
    expect(html).toContain("No server buyerAction");
    expect(html).toContain("All gates closed");
    expect(html).toContain("providerAccountId=act_1");
    expect(html).not.toContain("No live audience score");
    expect(html).not.toContain(">--<");
  });
});
