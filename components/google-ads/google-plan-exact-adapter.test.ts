import { describe, expect, it } from "vitest";

import {
  buildGooglePlanExactViewModel,
  googlePlanRetentionLine,
  GOOGLE_PLAN_STEP_SOURCE,
} from "@/components/google-ads/google-plan-exact-adapter";
import type { GoogleAdsActivityEntry } from "@/lib/google-ads/advisor-memory";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

const identity = {
  accountId: "4931182201",
  currencyCode: "USD",
  windowLabel: "28d",
  syncLabel: "Synced 26m ago",
};

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

function activity(
  overrides: Partial<GoogleAdsActivityEntry> = {},
): GoogleAdsActivityEntry {
  return {
    id: "log_1",
    createdAt: "2026-08-15T09:12:00.000Z",
    operation: "apply",
    mutateActionType: "adjust_portfolio_target",
    status: "applied",
    accountId: "4931182201",
    receiptId: "gw_01K2F4",
    detail: null,
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildGooglePlanExactViewModel>[0]> = {}) {
  return buildGooglePlanExactViewModel({
    identity,
    recommendations: [recommendation()],
    activity: [activity()],
    activityRetentionDays: 30,
    asOf,
    writeAuthority: "allowed",
    ...overrides,
  });
}

describe("buildGooglePlanExactViewModel", () => {
  it("names the account, currency and window in the reference's four segments", () => {
    expect(build().eyebrow).toBe("Google Ads · 4931182201 · USD · 28d window");
  });

  it("counts queued and applied the way the reference's own model does", () => {
    const model = build({
      recommendations: [
        recommendation(),
        recommendation({
          id: "rec_2",
          rankScore: 80,
          executionStatus: "applied",
          transactionId: "gw_09QX72",
          rollbackActionType: "restore_portfolio_target",
          rollbackPayloadPreview: { value: 2.4 },
        }),
        recommendation({ id: "rec_3", rankScore: 70 }),
      ],
    });
    expect(model.queuedLabel).toBe("3");
    expect(model.appliedLabel).toBe("1");
  });

  it("renders every served recommendation and counts the true queue length", () => {
    // The reference's `sc-for` is uncapped and its counter is the raw served
    // length, so a queue longer than any convenient bound must arrive whole.
    const recommendations = Array.from({ length: 20 }, (_, index) =>
      recommendation({
        id: `rec_${index + 1}`,
        title: `Step ${index + 1}`,
        rankScore: 100 - index,
        ...(index < 4 ? { executionStatus: "applied" as const } : {}),
      }),
    );
    const model = build({ recommendations });

    expect(model.steps).toHaveLength(20);
    expect(model.queuedLabel).toBe("20");
    expect(model.appliedLabel).toBe("4");
    expect(model.steps.at(-1)?.number).toBe("20");
    expect(model.steps.at(-1)?.title).toBe("Step 20");
    expect(model.steps.map((step) => step.title)).toContain("Step 13");
  });

  it("ranks the queue and puts the fixed advisor provenance on every step", () => {
    const model = build({
      recommendations: [
        recommendation({ id: "low", rankScore: 1 }),
        recommendation({ id: "high", rankScore: 99 }),
      ],
    });
    expect(model.steps.map((step) => step.key)).toEqual(["high", "low"]);
    expect(model.steps.map((step) => step.number)).toEqual(["1", "2"]);
    for (const step of model.steps) {
      expect(step.source).toBe(GOOGLE_PLAN_STEP_SOURCE);
    }
  });

  it("says queued before apply and names the receipt once applied", () => {
    const queued = build().steps[0]!;
    expect(queued.applied).toBe(false);
    expect(queued.statusLabel).toBe("queued — awaiting apply");
    expect(queued.applyLabel).toBe("Apply now");

    const applied = build({
      recommendations: [
        recommendation({
          executionStatus: "applied",
          transactionId: "gw_01K2F4",
          rollbackActionType: "restore_portfolio_target",
          rollbackPayloadPreview: { value: 2.4 },
        }),
      ],
    }).steps[0]!;
    expect(applied.applied).toBe(true);
    expect(applied.statusLabel).toBe("applied · receipt gw_01K2F4");
    expect(applied.applyLabel).toBe("Roll back");
  });

  it("prints the em dash for a receipt the execution boundary did not stamp", () => {
    const applied = build({
      recommendations: [
        recommendation({
          executionStatus: "applied",
          rollbackActionType: "restore_portfolio_target",
          rollbackPayloadPreview: { value: 2.4 },
        }),
      ],
    }).steps[0]!;
    expect(applied.statusLabel).toBe("applied · receipt —");
  });

  it("puts the advisor's blockers on the amber note line", () => {
    const model = build({
      recommendations: [
        recommendation({ blockers: ["Blocked once by quiet hours", "Re-queued for 08:00"] }),
      ],
    });
    expect(model.steps[0]?.note).toBe(
      "Blocked once by quiet hours · Re-queued for 08:00",
    );
    expect(build().steps[0]?.note).toBeNull();
  });

  it("offers Open ↗ only when the advisor served a deep link", () => {
    expect(build().steps[0]?.openHref).toBeNull();
    expect(
      build({
        recommendations: [recommendation({ deepLinkUrl: "https://ads.google.com/x" })],
      }).steps[0]?.openHref,
    ).toBe("https://ads.google.com/x");
  });

  describe("the guarded write boundary", () => {
    it("disarms every control for a viewer the server did not clear to write", () => {
      for (const writeAuthority of ["denied", "unknown"] as const) {
        const model = build({ writeAuthority });
        expect(model.steps[0]?.applyEnabled).toBe(false);
        expect(model.steps[0]?.dismissEnabled).toBe(false);
        expect(model.applyAllEnabled).toBe(false);
      }
    });

    it("refuses to arm Apply on a step with no mutate payload", () => {
      const model = build({
        recommendations: [
          recommendation({ mutateActionType: null, mutatePayloadPreview: null }),
        ],
      });
      expect(model.steps[0]?.applyEnabled).toBe(false);
      expect(model.applyAllEnabled).toBe(false);
    });

    it("refuses to arm Roll back on an applied step with no rollback payload", () => {
      const model = build({
        recommendations: [
          recommendation({ executionStatus: "applied", transactionId: "gw_1" }),
        ],
      });
      expect(model.steps[0]?.applyLabel).toBe("Roll back");
      expect(model.steps[0]?.applyEnabled).toBe(false);
    });

    it("refuses to arm Roll back once the server withdrew rollback availability", () => {
      const model = build({
        recommendations: [
          recommendation({
            executionStatus: "applied",
            transactionId: "gw_1",
            rollbackActionType: "restore_portfolio_target",
            rollbackPayloadPreview: { value: 2.4 },
            rollbackAvailable: false,
          }),
        ],
      });
      expect(model.steps[0]?.applyEnabled).toBe(false);
    });

    it("arms Apply only for a cleared viewer on a step that carries its payload", () => {
      const model = build();
      expect(model.steps[0]?.applyEnabled).toBe(true);
      expect(model.applyAllEnabled).toBe(true);
    });

    it("does not treat a pending or failed execution as applied", () => {
      for (const executionStatus of ["pending", "failed", "not_started"] as const) {
        const model = build({ recommendations: [recommendation({ executionStatus })] });
        expect(model.steps[0]?.applied).toBe(false);
      }
    });
  });

  describe("activity", () => {
    it("states the retention boundary from the log's own window", () => {
      expect(googlePlanRetentionLine(30, asOf)).toBe(
        "Entries before Jul 20 are past retention and cannot be shown.",
      );
      expect(googlePlanRetentionLine(null, asOf)).toBe("—");
      expect(googlePlanRetentionLine(0, asOf)).toBe("—");
    });

    it("renders the receipt in Detail and the em dash for the unrecorded actor", () => {
      const row = build().activityRows[0]!;
      expect(row.what).toBe("Applied");
      expect(row.detail).toBe("Adjust portfolio target · receipt gw_01K2F4");
      // `google_ads_advisor_execution_logs` has no actor column.
      expect(row.who).toBe("—");
    });

    it("carries a failure message into Detail rather than dropping it", () => {
      const row = build({
        activity: [
          activity({
            status: "failed",
            receiptId: null,
            detail: "Quiet hours",
          }),
        ],
      }).activityRows[0]!;
      expect(row.what).toBe("Failed");
      expect(row.detail).toBe("Adjust portfolio target · Quiet hours");
    });

    it("renders an empty feed rather than a notice when the log is empty", () => {
      expect(build({ activity: [] }).activityRows).toEqual([]);
      expect(build({ activity: null }).activityRows).toEqual([]);
    });
  });
});
