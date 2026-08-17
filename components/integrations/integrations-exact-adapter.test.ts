import { describe, expect, it } from "vitest";

import {
  buildFirstSyncModel,
  buildFirstSyncSteps,
  buildIntegrationsExactModel,
  googleFirstSyncSignals,
  INTEGRATIONS_LIVE_ORDER,
  INTEGRATIONS_META_NO_AUTH_FLOW,
  INTEGRATIONS_META_NOT_CONNECTED,
  INTEGRATIONS_META_SYNCING,
  metaFirstSyncSignals,
  resolveFirstSyncPercent,
  shopifyFirstSyncSignals,
} from "@/components/integrations/integrations-exact-adapter";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import type {
  IntegrationProvider,
  ProviderViewState,
} from "@/store/integrations-store";

function view(
  provider: IntegrationProvider,
  overrides: Partial<ProviderViewState> = {},
): ProviderViewState {
  return {
    provider,
    status: "disconnected",
    connectionLabel: "Not connected",
    primaryActionLabel: "Connect",
    statusLabel: "Not connected",
    detailLabel: "Assigned",
    detailValue: "Not configured yet",
    accountLabel: "Account",
    accountValue: "—",
    lastSyncLabel: "Last sync",
    lastSyncValue: "—",
    assignedCount: 0,
    assignedSummary: "No accounts assigned",
    connectedAt: undefined,
    errorMessage: undefined,
    notice: null,
    canManageAssignments: false,
    isConnected: false,
    ...overrides,
  } as ProviderViewState;
}

const CONNECTED = {
  status: "ready" as const,
  isConnected: true,
  connectionLabel: "Live",
  detailValue: "2 accounts",
  connectedAt: "2026-03-02T00:00:00.000Z",
  lastSyncValue: "2026-08-17T11:56:00.000Z",
};

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

const logoFor = (provider: IntegrationProvider) => `/platform-logos/${provider}.svg`;

const CONNECTABLE: IntegrationProvider[] = [
  "meta",
  "google",
  "ga4",
  "search_console",
  "shopify",
];

function baseViews(): Partial<Record<IntegrationProvider, ProviderViewState>> {
  return Object.fromEntries(
    INTEGRATIONS_LIVE_ORDER.map((provider) => [provider, view(provider)]),
  );
}

describe("buildFirstSyncSteps", () => {
  it("names the design's four stages in order", () => {
    expect(buildFirstSyncSteps(0).map((step) => step.label)).toEqual([
      "Authorize",
      "Fetch entities",
      "Backfill 28 days",
      "Validate & snapshot",
    ]);
  });

  it("marks stages done past their upper bound and current inside it", () => {
    const steps = buildFirstSyncSteps(40);
    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
    expect(steps[1]!.note).toBe("done");
    expect(steps[2]!.note).toBe("events & revenue");
    expect(steps[3]!.note).toBe("");
  });
});

describe("resolveFirstSyncPercent", () => {
  it("shows nothing when the provider is not connected", () => {
    expect(
      resolveFirstSyncPercent({
        connected: false,
        entitiesReady: false,
        backfillFraction: 0.5,
        snapshotReady: false,
      }),
    ).toBeNull();
  });

  it("shows nothing once the first import has landed — the block appears once", () => {
    expect(
      resolveFirstSyncPercent({
        connected: true,
        entitiesReady: true,
        backfillFraction: 1,
        snapshotReady: true,
      }),
    ).toBeNull();
  });

  it("parks at the entity stage until entities are discovered", () => {
    expect(
      resolveFirstSyncPercent({
        connected: true,
        entitiesReady: false,
        backfillFraction: 0.9,
        snapshotReady: false,
      }),
    ).toBe(8);
  });

  it("parks at the start of the backfill stage when no progress is reported", () => {
    expect(
      resolveFirstSyncPercent({
        connected: true,
        entitiesReady: true,
        backfillFraction: null,
        snapshotReady: false,
      }),
    ).toBe(35);
  });

  it("interpolates the backfill stage from the served fraction", () => {
    expect(
      resolveFirstSyncPercent({
        connected: true,
        entitiesReady: true,
        backfillFraction: 0.5,
        snapshotReady: false,
      }),
    ).toBeCloseTo(58.5, 5);
  });

  it("moves to validation only when the backfill is complete", () => {
    expect(
      resolveFirstSyncPercent({
        connected: true,
        entitiesReady: true,
        backfillFraction: 1,
        snapshotReady: false,
      }),
    ).toBe(82);
  });
});

describe("provider first-sync signals", () => {
  it("reads Meta's priority window rather than any clock", () => {
    const status = {
      state: "syncing",
      connected: true,
      assignedAccountIds: ["act_1"],
      priorityWindow: {
        startDate: "2026-07-20",
        endDate: "2026-08-17",
        completedDays: 14,
        totalDays: 28,
        isActive: true,
      },
      coreReadiness: { complete: false },
    } as unknown as MetaStatusResponse;

    expect(metaFirstSyncSignals(status)).toEqual({
      connected: true,
      entitiesReady: true,
      backfillFraction: 0.5,
      snapshotReady: false,
    });
  });

  it("treats Meta core readiness as the snapshot verdict", () => {
    const status = {
      state: "partial",
      connected: true,
      assignedAccountIds: ["act_1"],
      coreReadiness: { complete: true },
    } as unknown as MetaStatusResponse;
    expect(metaFirstSyncSignals(status)?.snapshotReady).toBe(true);
  });

  it("holds Google at the entity stage before an account is assigned", () => {
    const status = {
      state: "connected_no_assignment",
      connected: true,
      assignedAccountIds: [],
    } as unknown as GoogleAdsStatusResponse;
    expect(googleFirstSyncSignals(status)?.entitiesReady).toBe(false);
  });

  it("reads Google's historical progress percent", () => {
    const status = {
      state: "syncing",
      connected: true,
      assignedAccountIds: ["493-118-2201"],
      historicalProgress: { percent: 40, visible: true, summary: "" },
    } as unknown as GoogleAdsStatusResponse;
    expect(googleFirstSyncSignals(status)?.backfillFraction).toBeCloseTo(0.4, 5);
  });

  it("only claims a finished Shopify backfill when ready-through reaches the target", () => {
    const partial = {
      state: "partial",
      connected: true,
      shopId: "shop_1",
      sync: {
        ordersHistorical: {
          readyThroughDate: "2026-08-01",
          historicalTargetEnd: "2026-08-17",
        },
      },
    } as unknown as ShopifyStatusResponse;
    expect(shopifyFirstSyncSignals(partial)?.backfillFraction).toBeNull();

    const done = {
      state: "partial",
      connected: true,
      shopId: "shop_1",
      sync: {
        ordersHistorical: {
          readyThroughDate: "2026-08-17",
          historicalTargetEnd: "2026-08-17",
        },
      },
    } as unknown as ShopifyStatusResponse;
    expect(shopifyFirstSyncSignals(done)?.backfillFraction).toBe(1);
  });

  it("returns no signals at all for a provider that serves no status", () => {
    expect(metaFirstSyncSignals(null)).toBeNull();
    expect(googleFirstSyncSignals(undefined)).toBeNull();
    expect(shopifyFirstSyncSignals({ connected: false } as ShopifyStatusResponse)).toBeNull();
  });
});

describe("buildFirstSyncModel", () => {
  it("labels the percent and bar from the same number", () => {
    const model = buildFirstSyncModel({
      connected: true,
      entitiesReady: true,
      backfillFraction: 0.5,
      snapshotReady: false,
    });
    expect(model?.percentLabel).toBe("59%");
    expect(model?.barWidth).toBe("58.5%");
    expect(model?.complete).toBe(false);
  });
});

describe("buildIntegrationsExactModel", () => {
  it("opens the grid with Shopify and lists the design's six providers in order", () => {
    const model = buildIntegrationsExactModel({
      views: baseViews(),
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    expect(model.cards.map((card) => card.provider)).toEqual([
      "shopify",
      "meta",
      "google",
      "ga4",
      "search_console",
      "klaviyo",
    ]);
    expect(model.cards.map((card) => card.name)).toEqual([
      "Shopify",
      "Meta Ads",
      "Google Ads",
      "GA4",
      "Search Console",
      "Klaviyo",
    ]);
  });

  it("uses the design's card descriptions verbatim", () => {
    const model = buildIntegrationsExactModel({
      views: baseViews(),
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    expect(model.cards[0]!.description).toBe(
      "Orders and revenue ledger — the trusted commercial source.",
    );
    expect(model.cards[4]!.description).toBe(
      "Query and indexing data behind SEO insights.",
    );
  });

  it("gives a disconnected connectable provider one Connect button", () => {
    const model = buildIntegrationsExactModel({
      views: baseViews(),
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    const meta = model.cards.find((card) => card.provider === "meta")!;
    expect(meta.status).toBe("Not connected");
    expect(meta.statusTone).toBe("neutral");
    expect(meta.button).toEqual({ caption: "Connect", kind: "connect" });
    expect(meta.meta).toBe(INTEGRATIONS_META_NOT_CONNECTED);
  });

  it("captions every connected provider's button Manage", () => {
    const views = baseViews();
    for (const provider of ["shopify", "meta", "google", "ga4", "search_console"] as const) {
      views[provider] = view(provider, CONNECTED);
    }
    const model = buildIntegrationsExactModel({
      views,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    for (const card of model.cards.filter((item) => item.provider !== "klaviyo")) {
      expect(card.button).toEqual({ caption: "Manage", kind: "manage" });
      expect(card.status).toBe("Connected");
    }
  });

  it("renders no button for Klaviyo, which has no authorization route", () => {
    const model = buildIntegrationsExactModel({
      views: baseViews(),
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    const klaviyo = model.cards.find((card) => card.provider === "klaviyo")!;
    expect(klaviyo.button).toBeNull();
    expect(klaviyo.meta).toBe(INTEGRATIONS_META_NO_AUTH_FLOW);
  });

  it("hides the button and swaps the meta line while the first import runs", () => {
    const views = baseViews();
    views.meta = view("meta", CONNECTED);
    const model = buildIntegrationsExactModel({
      views,
      metaStatus: {
        state: "syncing",
        connected: true,
        assignedAccountIds: ["act_1"],
        priorityWindow: { completedDays: 7, totalDays: 28 },
        coreReadiness: { complete: false },
      } as unknown as MetaStatusResponse,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    const card = model.cards.find((item) => item.provider === "meta")!;
    expect(card.syncing).toBe(true);
    expect(card.status).toBe("Connecting");
    expect(card.button).toBeNull();
    expect(card.meta).toBe(INTEGRATIONS_META_SYNCING);
    expect(card.firstSync?.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
  });

  it("builds the connected meta line from identity, connect date and freshness", () => {
    const views = baseViews();
    views.shopify = view("shopify", {
      ...CONNECTED,
      detailValue: "aurora-supply.myshopify.com",
    });
    const model = buildIntegrationsExactModel({
      views,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    expect(model.cards[0]!.meta).toBe(
      "aurora-supply.myshopify.com · connected Mar 2 · fresh 4m ago",
    );
  });

  it("renders an em-dash for any meta fact the provider does not supply", () => {
    const views = baseViews();
    views.shopify = view("shopify", {
      status: "ready",
      isConnected: true,
      detailValue: "Not configured yet",
      accountValue: "—",
      connectedAt: undefined,
      lastSyncValue: "—",
    });
    const model = buildIntegrationsExactModel({
      views,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    expect(model.cards[0]!.meta).toBe("— · — · —");
  });

  it("lists the three roadmap providers with an em-dash where no date is served", () => {
    const model = buildIntegrationsExactModel({
      views: baseViews(),
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    expect(model.soonCards.map((card) => card.name)).toEqual([
      "TikTok Ads",
      "Pinterest",
      "Snapchat",
    ]);
    expect(model.soonCards.every((card) => card.eta === "—")).toBe(true);
  });
});
