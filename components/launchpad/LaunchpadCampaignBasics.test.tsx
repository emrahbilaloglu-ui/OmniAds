import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LaunchpadCampaignBasics } from "./LaunchpadCampaignBasics";

describe("LaunchpadCampaignBasics", () => {
  it("shows campaign choices in buyer-facing language", () => {
    const html = renderToStaticMarkup(
      <LaunchpadCampaignBasics
        value={{
          name: "Prospecting",
          smartPromotion: true,
          specialAdCategories: [],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Sales");
    expect(html).toContain("Optimize for purchases");
    expect(html).toContain("Guided campaign setup");
    expect(html).not.toContain("OUTCOME_SALES");
    expect(html).not.toContain("GUIDED_CREATION");
  });
});
