import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchpadAdSets } from "@/components/launchpad/LaunchpadAdSets";

/**
 * WP14 item 4 — a failed pixel read must not wipe the operator's choice.
 *
 * An empty pixel list has two causes and they call for opposite handling. If
 * the read worked and the account owns no pixels, a stored `pixelId` names
 * something that does not exist and clearing it is right. If the read FAILED —
 * a 401, a 500, an offline moment — we do not know what the account owns, and
 * clearing destroys a choice the operator made across every ad set in a draft
 * they may have spent minutes building.
 *
 * Both produced `[]`, so the second case silently destroyed work. This is D8 on
 * a form rather than on a metric.
 */
const AD_SET = {
  clientId: "as_1",
  name: "Prospecting",
  optimizationGoal: "OFFSITE_CONVERSIONS" as const,
  pixelId: "px_kept",
  customEventType: "PURCHASE" as const,
  countries: "TR",
  ageMin: "18",
  ageMax: "65",
  advantageAudience: false,
  advantagePlacements: true,
  publisherPlatforms: [],
  facebookPositions: [],
  instagramPositions: [],
  attributionPresetId: "default" as never,
  attributionSpec: [],
  budgetAmount: "100",
  bidStrategy: "LOWEST_COST_WITHOUT_CAP" as never,
  bidAmount: "",
};

function renderAdSets(onChange: (value: unknown[]) => void) {
  return render(
    <LaunchpadAdSets
      businessId="biz_1"
      providerAccountId="act_1"
      campaignName="Prospecting campaign"
      currency="TRY"
      budget={{ mode: "ABO", amount: "100", schedule: "daily" }}
      value={[AD_SET] as never}
      onChange={onChange as never}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("pixel selection retention", () => {
  it("keeps the chosen pixel when the read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    );
    const onChange = vi.fn();
    await act(async () => {
      renderAdSets(onChange);
      await Promise.resolve();
    });

    for (const call of onChange.mock.calls) {
      const next = call[0] as Array<{ pixelId: string }>;
      expect(next[0]!.pixelId, "a failed read cleared the pixel").not.toBe("");
    }
  });

  it("keeps the chosen pixel when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const onChange = vi.fn();
    await act(async () => {
      renderAdSets(onChange);
      await Promise.resolve();
    });
    for (const call of onChange.mock.calls) {
      const next = call[0] as Array<{ pixelId: string }>;
      expect(next[0]!.pixelId).not.toBe("");
    }
  });

  it("keeps the chosen pixel when a 200 carries no readable pixels key", async () => {
    // A gateway or a shape change answers 200 with something else. That is not
    // an account with no pixels.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const onChange = vi.fn();
    await act(async () => {
      renderAdSets(onChange);
      await Promise.resolve();
    });
    for (const call of onChange.mock.calls) {
      const next = call[0] as Array<{ pixelId: string }>;
      expect(next[0]!.pixelId).not.toBe("");
    }
  });

  it("clears the pixel when the read succeeds and the account owns none", async () => {
    // The case that justifies clearing: a stored id naming something that does
    // not exist would be sent to Meta and refused.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ pixels: [] }), { status: 200 })),
    );
    const onChange = vi.fn();
    await act(async () => {
      renderAdSets(onChange);
      await Promise.resolve();
    });
    const cleared = onChange.mock.calls.some((call) => {
      const next = call[0] as Array<{ pixelId: string }>;
      return next[0]!.pixelId === "";
    });
    expect(cleared, "a proven-empty account did not clear the pixel").toBe(true);
  });
});
// @vitest-environment jsdom
