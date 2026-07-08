import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchpadProgress } from "@/components/launchpad/LaunchpadProgress";

describe("LaunchpadProgress", () => {
  it("renders partial-halt, silent-failure, and Ads Manager evidence distinctly", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          campaignId: "cmp_1",
          adsetIds: ["adset_1"],
          adIds: [],
          failedAt: "ad:1:1",
          error: { code: "silent_failure", message: "Verification could not find the ad." },
          steps: [
            {
              kind: "campaign",
              index: 0,
              name: "Campaign",
              status: "success",
              id: "cmp_1",
              adsManagerUrl: "https://adsmanager.facebook.com/campaigns/cmp_1",
            },
            {
              kind: "ad",
              index: 0,
              name: "Creative 1",
              status: "silent_failure",
              id: "ad_1",
              error: { code: "silent_failure", message: "Verification could not find the ad." },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Partial launch stopped at ad:1:1");
    expect(html).toContain("New-campaign mode HALTS on failure");
    expect(html).toContain("silent_failure:");
    expect(html).toContain("Logged to Audit Trail");
    expect(html).toContain("Ads Manager ↗");
  });

  it("renders launch-in-flight as a caution state instead of a blind retry error", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          error: {
            code: "launch_in_flight",
            message: "A Meta launch with this idempotency key is already pending.",
          },
        }}
      />,
    );

    expect(html).toContain("Launch already in flight (409)");
    expect(html).toContain("not an error to retry blindly");
  });
});
