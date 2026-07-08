import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComingSoonState } from "@/components/states/ComingSoonState";

describe("ComingSoonState", () => {
  it("renders an honest platform readiness surface without write controls", () => {
    const html = renderToStaticMarkup(
      <ComingSoonState
        platformId="klaviyo"
        status="beta"
        title="Klaviyo is in beta"
        description="Lifecycle surfaces are still gated."
      />,
    );

    expect(html).toContain("ad-platform-readiness");
    expect(html).toContain("Beta contract");
    expect(html).toContain("no write surface exposed");
    expect(html).toContain("unavailable, never as zero");
    expect(html).toContain("Open Integrations");
    expect(html).not.toContain("writes enabled");
  });
});
