import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GooglePlanExact } from "@/components/google-ads/GooglePlanExact";
import { buildGooglePlanExactViewModel } from "@/components/google-ads/google-plan-exact-adapter";
import type { GoogleAdsActivityEntry } from "@/lib/google-ads/advisor-memory";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

const source = readFileSync("components/google-ads/GooglePlanExact.tsx", "utf8");

const asOf = new Date("2026-08-19T09:00:00.000Z");

function recommendation(
  overrides: Partial<GoogleRecommendation> = {},
): GoogleRecommendation {
  return {
    id: "rec_1",
    title: "Raise Shopping tROAS to 2.6",
    rankScore: 90,
    blockers: [],
    recommendationFingerprint: "fp_1",
    recommendedAction: "Raise the target",
    whyNow: "Headroom above target",
    mutateActionType: "adjust_portfolio_target",
    mutatePayloadPreview: { value: 2.6 },
    ...overrides,
  } as unknown as GoogleRecommendation;
}

const activity: GoogleAdsActivityEntry[] = [
  {
    id: "log_1",
    createdAt: "2026-08-15T09:12:00.000Z",
    operation: "apply",
    mutateActionType: "adjust_portfolio_target",
    status: "applied",
    accountId: "4931182201",
    receiptId: "gw_01K2F4",
    detail: null,
  },
];

function render(
  overrides: Partial<Parameters<typeof buildGooglePlanExactViewModel>[0]> = {},
) {
  const model = buildGooglePlanExactViewModel({
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    recommendations: [recommendation()],
    activity,
    activityRetentionDays: 30,
    asOf,
    writeAuthority: "allowed",
    ...overrides,
  });
  return renderToStaticMarkup(
    React.createElement(GooglePlanExact, { model, syncTone: "positive" }),
  );
}

describe("GooglePlanExact structure", () => {
  it("opens on the canonical head", () => {
    const markup = render();
    expect(markup).toContain('data-screen-label="Google Ads · Plan"');
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
    expect(markup).toContain("Plan &amp; activity");
    expect(markup).toContain("writes guarded · receipt on every change");
  });

  it("carries the queue head, its counter and both buttons unconditionally", () => {
    for (const recommendations of [[recommendation()], [], null]) {
      const markup = render({ recommendations });
      expect(markup).toContain('data-google-execution-queue="true"');
      expect(markup).toContain("Execution queue");
      expect(markup).toContain("queued · ");
      expect(markup).toContain("applied");
      expect(markup).toContain("Apply all approved");
      expect(markup).toContain("Download CSV");
      expect(markup).toContain(
        "Approved changes execute here through the guarded write boundary —",
      );
    }
  });

  it("says applied, not approved, in the queue counter", () => {
    const markup = render();
    expect(markup).toContain("1 queued · 0 applied");
    expect(markup).not.toContain("approved</span>");
  });

  it("gives every step the reference's three controls", () => {
    const markup = render();
    expect(markup).toContain("Apply now");
    expect(markup).toContain("Copy");
    expect(markup).toContain("Dismiss");
    expect(markup).toContain("queued — awaiting apply");
  });

  it("switches Apply now to Roll back once the step executed", () => {
    const markup = render({
      recommendations: [
        recommendation({
          executionStatus: "applied",
          transactionId: "gw_01K2F4",
          rollbackActionType: "restore_portfolio_target",
          rollbackPayloadPreview: { value: 2.4 },
        }),
      ],
    });
    expect(markup).toContain("Roll back");
    expect(markup).toContain("applied · receipt gw_01K2F4");
    expect(markup).not.toContain("Apply now");
  });

  it("keeps the provenance line fixed rather than a layer breadcrumb", () => {
    const markup = render();
    expect(markup).toContain("served by the advisor from the last complete day");
  });

  it("carries the batch contract copy including the kill switch", () => {
    const markup = render();
    expect(markup).toContain("Batch apply — guarded");
    expect(markup).toContain(
      "One execution target type per run, up to 250 items, one receipt",
    );
    expect(markup).toContain(
      "Batches run inside the same guardrails — the kill switch and",
    );
  });

  it("renders the four-column activity table and its retention boundary", () => {
    const markup = render();
    const headers = Array.from(markup.matchAll(/<th[^>]*>([^<]+)<\/th>/g)).map(
      (match) => match[1],
    );
    expect(headers).toEqual(["When", "Who", "What", "Detail"]);
    expect(markup).toContain(
      "Every guarded write lands here with its receipt and is confirmed",
    );
    expect(markup).toContain("on the next sync");
    expect(markup).toContain(
      "Entries before Jul 20 are past retention and cannot be shown.",
    );
    expect(markup).toContain("gw_01K2F4");
  });

  it("renders the activity table even when the log is empty — never a notice", () => {
    const markup = render({ activity: [] });
    const headers = Array.from(markup.matchAll(/<th[^>]*>([^<]+)<\/th>/g)).map(
      (match) => match[1],
    );
    expect(headers).toEqual(["When", "Who", "What", "Detail"]);
    expect(markup).not.toContain("unavailable");
    expect(markup).not.toContain("read-only");
  });

  it("closes on the reference's blocked-stays-queued sentence", () => {
    expect(render()).toContain(
      "Anything blocked stays queued with its blocker named rather",
    );
  });

  it("appends no budget workspace and no result banner", () => {
    const markup = render();
    expect(markup).not.toContain("Budget headroom");
    expect(markup).not.toContain("Spend Concentration");
    expect(markup).not.toContain("Campaign Detail");
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("<select");
  });

  describe("the provider-write guard", () => {
    it("disables Apply, Apply all and Dismiss for a viewer who may not write", () => {
      for (const writeAuthority of ["denied", "unknown"] as const) {
        const markup = render({ writeAuthority });
        expect(markup).toMatch(/data-google-plan-apply="rec_1"[^>]*disabled/);
        expect(markup).toMatch(/data-google-plan-dismiss="rec_1"[^>]*disabled/);
        expect(markup).toMatch(/Apply all approved/);
        const applyAll = markup.match(
          /<button type="button" class="_primaryButton[^"]*"([^>]*)>/,
        );
        expect(applyAll?.[1]).toContain("disabled");
      }
    });

    it("disables Apply on a step the advisor served with no mutate payload", () => {
      const markup = render({
        recommendations: [
          recommendation({ mutateActionType: null, mutatePayloadPreview: null }),
        ],
      });
      expect(markup).toMatch(/data-google-plan-apply="rec_1"[^>]*disabled/);
    });

    it("arms Apply only for a cleared viewer on a step that carries its payload", () => {
      const markup = render();
      const apply = markup.match(/data-google-plan-apply="rec_1"([^>]*)>/);
      expect(apply?.[1]).not.toContain("disabled");
    });

    // The surface must never call the provider itself; the caller owns the
    // guarded endpoint so the server guard is always in the path.
    it("issues no fetch of its own", () => {
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain('"/api/');
    });
  });
});
