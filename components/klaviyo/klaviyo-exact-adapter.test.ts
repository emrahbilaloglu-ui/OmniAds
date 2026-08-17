import { describe, expect, it } from "vitest";

import {
  buildKlaviyoExactModel,
  KLAVIYO_TABS,
} from "@/components/klaviyo/klaviyo-exact-adapter";
import type { ProviderDomainState } from "@/store/integrations-store";

function domain(status: "connected" | "disconnected"): ProviderDomainState {
  return {
    provider: "klaviyo",
    connection: { status },
    discovery: {
      status: "idle",
      entities: [],
      source: null,
      sourceHealth: null,
      trustLevel: null,
      trustScore: null,
      fetchedAt: null,
      notice: null,
      stale: false,
      refreshFailed: false,
      failureClass: null,
      retryAfterAt: null,
    },
    assignment: { status: "idle", selectedIds: [], updatedAt: null },
  } as unknown as ProviderDomainState;
}

describe("buildKlaviyoExactModel", () => {
  it("carries the design's four tabs with the first one selected", () => {
    const model = buildKlaviyoExactModel({ domain: null, flows: null });
    expect(model.tabs).toEqual(["Flows", "Campaigns", "Templates", "Segments"]);
    expect(model.tabs).toBe(KLAVIYO_TABS);
    expect(model.activeTabIndex).toBe(0);
  });

  it("renders one em-dash row when no route serves flows", () => {
    const model = buildKlaviyoExactModel({
      domain: domain("disconnected"),
      flows: null,
    });
    expect(model.unavailable).toBe(true);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      name: "—",
      status: "—",
      revenue: "—",
      openRate: "—",
      recipients: "—",
    });
  });

  it("never substitutes seeded flow names for a connected-but-unserved account", () => {
    const model = buildKlaviyoExactModel({
      domain: domain("connected"),
      flows: null,
    });
    expect(model.rows.map((row) => row.name)).toEqual(["—"]);
  });

  it("maps served flows onto the design's row shape", () => {
    const model = buildKlaviyoExactModel({
      domain: domain("connected"),
      flows: [
        {
          id: "flow_1",
          name: "Welcome Series",
          status: "Live",
          revenue: "$18,420",
          openRate: "54%",
          recipients: "12,480",
        },
        {
          id: "flow_2",
          name: "Win-back 60d",
          status: "Draft",
          revenue: null,
          openRate: null,
          recipients: null,
        },
      ],
    });
    expect(model.unavailable).toBe(false);
    expect(model.rows[0]).toEqual({
      key: "flow_1",
      name: "Welcome Series",
      status: "Live",
      statusTone: "live",
      revenue: "$18,420",
      openRate: "54%",
      recipients: "12,480",
    });
    expect(model.rows[1]).toMatchObject({
      statusTone: "draft",
      revenue: "—",
      openRate: "—",
      recipients: "—",
    });
  });
});
