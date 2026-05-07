import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CreativesPage from "./page";

vi.mock("@/components/creatives/briefing/CreativesBriefingPage", () => ({
  CreativesBriefingPage: () => <main data-testid="creatives-briefing-page">Creatives briefing</main>,
}));

describe("/platforms/meta/creatives page", () => {
  it("routes to the Creative briefing redesign surface", () => {
    const html = renderToStaticMarkup(<CreativesPage />);

    expect(html).toContain("data-testid=\"creatives-briefing-page\"");
    expect(html).toContain("Creatives briefing");
  });
});
