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
          launchIntentId: "11111111-1111-4111-8111-111111111111",
          launchIntentStatus: "silent_failure",
          campaignId: "cmp_1",
          adsetIds: ["adset_1"],
          adIds: [],
          failedAt: "ad:1:1",
          error: {
            code: "silent_failure",
            message: "Verification could not find the ad.",
          },
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
              error: {
                code: "silent_failure",
                message: "Verification could not find the ad.",
              },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Launch stopped before completion");
    expect(html).toContain(
      "Some items were created before the launch stopped.",
    );
    expect(html).toContain("Review them in Ads Manager before trying again.");
    expect(html).toContain("Meta did not confirm the final state.");
    expect(html).toContain("Open in Ads Manager");
    expect(html).not.toContain("ad:1:1");
    expect(html).not.toContain("silent_failure:");
    expect(html).not.toContain("11111111-1111-4111-8111-111111111111");
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
            message:
              "A Meta launch with this idempotency key is already pending.",
          },
        }}
      />,
    );

    expect(html).toContain("Another change is still running.");
    expect(html).toContain("Wait for it to finish before trying again.");
    expect(html).toContain("The final item count is pending.");
    expect(html).not.toContain("No items were created.");
    expect(html).not.toContain(">Retry<");
  });

  it("renders write-time validation blockers without backend detail or a retry control", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          error: {
            code: "validation_blocked",
            message: "Launch validation failed.",
          },
          blockers: [
            { code: "billing_not_ok", message: "Billing is not ready." },
          ],
        }}
      />,
    );

    expect(html).toContain("Launch could not start");
    expect(html).toContain("Resolve the Meta account billing issue.");
    expect(html).not.toContain("Billing is not ready.");
    expect(html).not.toContain("billing_not_ok");
    expect(html).not.toContain(">Retry<");
  });

  it("uses fixed no-retry guidance for reconciliation responses", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        mode="manage_existing"
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          halted: true,
          haltedReason: {
            code: "meta_ad_status_reconciliation_required",
            message: "Internal persistence detail with provider id 123456.",
            reconciliationRequired: true,
            retryAllowed: false,
          },
          reconciliationRequired: true,
          retryAllowed: false,
        }}
      />,
    );

    expect(html).toContain("Check History and Meta Ads.");
    expect(html).toContain("Do not retry this change.");
    expect(html).not.toContain("meta_ad_status_reconciliation_required");
    expect(html).not.toContain("Internal persistence detail");
    expect(html).not.toContain("try again");
  });

  it("shows partially succeeded launches as a warning state", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: true,
          launchIntentStatus: "partially_succeeded",
          adIds: ["ad_1"],
        }}
      />,
    );

    expect(html).toContain("Partially created");
    expect(html).not.toContain("Created and paused");
  });

  // A transport failure after the POST already reached the server arrives with
  // no counts and no id arrays. Printing 0 asserts that nothing was created at
  // the exact moment the client cannot know — the operator then closes the
  // wizard believing the account is untouched, and may resubmit and duplicate
  // whatever really landed. An unreported outcome is unknown, never zero.
  it("never prints zero for counts a countless response did not supply", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          error: {
            code: "launch_request_failed",
            message: "Failed to fetch",
          },
        }}
      />,
    );

    expect(html).toContain("The final item count is unavailable.");
    expect(html).not.toContain("0</strong> ad sets");
    expect(html).not.toContain("0</strong> ads");
  });

  // The counts that *were* supplied still render as numbers, including a real
  // zero the server actually reported.
  it("prints supplied counts without creating a placeholder for withheld counts", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        mode="manage_existing"
        loading={false}
        onDone={vi.fn()}
        result={{ ok: false, successCount: 0, campaignId: "cmp_1" }}
      />,
    );

    expect(html).toContain("0 updated");
    expect(html).not.toContain("—");
    expect(html).not.toContain("failed");
  });
});
