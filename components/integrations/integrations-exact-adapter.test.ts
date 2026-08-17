import { describe, expect, it } from "vitest";

import {
  buildFirstSyncModel,
  buildFirstSyncSteps,
  buildIntegrationsExactModel,
  ga4FirstSyncSignals,
  googleFirstSyncSignals,
  INTEGRATIONS_LIVE_ORDER,
  INTEGRATIONS_META_NOT_CONNECTED,
  INTEGRATIONS_META_SYNCING,
  isFirstImportConnection,
  metaFirstSyncSignals,
  resolveFirstSyncPercent,
  searchConsoleFirstSyncSignals,
  shopifyFirstSyncSignals,
} from "@/components/integrations/integrations-exact-adapter";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { GoogleAnalyticsStatusResponse } from "@/lib/google-analytics-status";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { SearchConsoleStatusResponse } from "@/lib/search-console-status";
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

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

/** A source connected months ago — long past any first import. */
const CONNECTED = {
  status: "ready" as const,
  isConnected: true,
  connectionLabel: "Live",
  detailValue: "2 accounts",
  connectedAt: "2026-03-02T00:00:00.000Z",
  lastSyncValue: "2026-08-17T11:56:00.000Z",
};

/** A source connected two hours ago — a first import can still be running. */
const JUST_CONNECTED = {
  ...CONNECTED,
  connectedAt: "2026-08-17T10:00:00.000Z",
};

/** Signal defaults for a brand-new connection with work in flight. */
const FRESH_IMPORT = {
  connected: true,
  importing: true,
  connectedAt: "2026-08-17T10:00:00.000Z",
};

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
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          connected: false,
          entitiesReady: false,
          backfillFraction: 0.5,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("shows nothing once the first import has landed — the block appears once", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          entitiesReady: true,
          backfillFraction: 1,
          snapshotReady: true,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("shows nothing when the provider's own state says no work is in flight", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          importing: false,
          entitiesReady: true,
          backfillFraction: 0.5,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("shows nothing for a connection older than the window a first import covers", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          connectedAt: "2026-03-02T00:00:00.000Z",
          entitiesReady: true,
          backfillFraction: 0.5,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("shows nothing when the connect date is unknown, because nothing proves it is the first", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          connectedAt: null,
          entitiesReady: true,
          backfillFraction: 0.5,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("parks at the entity stage until entities are discovered", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          entitiesReady: false,
          backfillFraction: 0.9,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBe(8);
  });

  it("parks at the start of the backfill stage when no progress is reported", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          entitiesReady: true,
          backfillFraction: null,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBe(35);
  });

  it("interpolates the backfill stage from the served fraction", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          entitiesReady: true,
          backfillFraction: 0.5,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBeCloseTo(58.5, 5);
  });

  it("moves to validation only when the backfill is complete", () => {
    expect(
      resolveFirstSyncPercent(
        {
          ...FRESH_IMPORT,
          entitiesReady: true,
          backfillFraction: 1,
          snapshotReady: false,
        },
        NOW,
      ),
    ).toBe(82);
  });
});

describe("isFirstImportConnection", () => {
  it("accepts a connection made inside the 28-day backfill window", () => {
    expect(isFirstImportConnection("2026-07-25T12:00:00.000Z", NOW)).toBe(true);
  });

  it("rejects an older connection, an unknown one and an unparseable one", () => {
    expect(isFirstImportConnection("2026-07-19T11:00:00.000Z", NOW)).toBe(false);
    expect(isFirstImportConnection(null, NOW)).toBe(false);
    expect(isFirstImportConnection("not-a-date", NOW)).toBe(false);
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

    expect(metaFirstSyncSignals(status, "2026-08-17T10:00:00.000Z")).toEqual({
      connected: true,
      importing: true,
      entitiesReady: true,
      backfillFraction: 0.5,
      snapshotReady: false,
      connectedAt: "2026-08-17T10:00:00.000Z",
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
    const model = buildFirstSyncModel(
      {
        ...FRESH_IMPORT,
        entitiesReady: true,
        backfillFraction: 0.5,
        snapshotReady: false,
      },
      NOW,
    );
    expect(model?.percentLabel).toBe("59%");
    expect(model?.barWidth).toBe("58.5%");
    expect(model?.complete).toBe(false);
  });
});

/**
 * F1: the block used to exist for any connected provider that was not "ready",
 * so a months-old Google connection whose token had been revoked rendered
 * "First sync — 82%" under a "Connecting" pill. These walk the long-lived
 * non-ready states of all three providers that serve a status.
 */
describe("long-lived non-ready provider states", () => {
  const LONG_LIVED_STATES = ["stale", "paused", "action_required"] as const;

  function cardFor(
    provider: "meta" | "google" | "shopify",
    state: string,
    viewOverrides: Partial<ProviderViewState> = {},
  ) {
    const views = baseViews();
    views[provider] = view(provider, { ...CONNECTED, ...viewOverrides });
    const model = buildIntegrationsExactModel({
      views,
      metaStatus:
        provider === "meta"
          ? ({
              state,
              connected: true,
              assignedAccountIds: ["act_1"],
              priorityWindow: { completedDays: 28, totalDays: 28 },
              coreReadiness: { complete: false },
            } as unknown as MetaStatusResponse)
          : null,
      googleStatus:
        provider === "google"
          ? ({
              state,
              connected: true,
              assignedAccountIds: ["493-118-2201"],
              historicalProgress: { percent: 100, visible: true, summary: "" },
            } as unknown as GoogleAdsStatusResponse)
          : null,
      shopifyStatus:
        provider === "shopify"
          ? ({
              state,
              connected: true,
              shopId: "shop_1",
              sync: {
                ordersHistorical: {
                  readyThroughDate: "2026-08-17",
                  historicalTargetEnd: "2026-08-17",
                },
              },
            } as unknown as ShopifyStatusResponse)
          : null,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    return model.cards.find((card) => card.provider === provider)!;
  }

  for (const provider of ["meta", "google", "shopify"] as const) {
    for (const state of LONG_LIVED_STATES) {
      it(`claims no first import for ${provider} in state "${state}"`, () => {
        const card = cardFor(provider, state);
        expect(card.firstSync).toBeNull();
        expect(card.syncing).toBe(false);
        expect(card.meta).not.toBe(INTEGRATIONS_META_SYNCING);
        // The store still calls the connection healthy, so the design's own
        // connected caption is what shows — never "Connecting".
        expect(card.status).toBe("Connected");
        expect(card.button).toEqual({ caption: "Manage", kind: "manage" });
      });
    }

    it(`reads a broken ${provider} connection as Action required, not Connecting`, () => {
      const card = cardFor(provider, "syncing", {
        status: "action_required",
        isConnected: false,
        connectedAt: "2026-08-17T10:00:00.000Z",
      });
      expect(card.firstSync).toBeNull();
      expect(card.status).toBe("Action required");
      expect(card.statusTone).toBe("attention");
    });

    it(`reads a degraded ${provider} connection as Degraded, not Connecting`, () => {
      const card = cardFor(provider, "syncing", {
        status: "degraded",
        connectedAt: "2026-08-17T10:00:00.000Z",
      });
      expect(card.status).toBe("Degraded");
      expect(card.statusTone).toBe("attention");
    });
  }

  it("still shows the block for a genuinely new connection that is importing", () => {
    const card = cardFor("google", "syncing", {
      connectedAt: "2026-08-17T10:00:00.000Z",
    });
    expect(card.status).toBe("Connecting");
    expect(card.firstSync?.percentLabel).toBe("82%");
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
    // The design's non-connected line, the same one every other card gets.
    expect(klaviyo.meta).toBe(INTEGRATIONS_META_NOT_CONNECTED);
  });

  it("hides the button and swaps the meta line while the first import runs", () => {
    const views = baseViews();
    views.meta = view("meta", JUST_CONNECTED);
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

/**
 * GA4 and Search Console: two sources whose importer is the report warmer.
 *
 * Both now serve a status endpoint, so both must obey the same five-condition
 * rule as Meta, Google and Shopify — and neither may claim a backfill share,
 * because their importer stores a window whole or not at all.
 */
function ga4Status(
  overrides: Partial<GoogleAnalyticsStatusResponse> = {},
): GoogleAnalyticsStatusResponse {
  return {
    provider: "ga4",
    connected: true,
    state: "syncing",
    connectedAt: "2026-08-17T10:00:00.000Z",
    property: { id: "properties/3322114455", name: "Aurora Store GA4" },
    propertyReady: true,
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage: null,
    ...overrides,
  };
}

function searchConsoleStatus(
  overrides: Partial<SearchConsoleStatusResponse> = {},
): SearchConsoleStatusResponse {
  return {
    provider: "search_console",
    connected: true,
    state: "syncing",
    connectedAt: "2026-08-17T10:00:00.000Z",
    site: { url: "sc-domain:aurora.example", type: "domain" },
    siteReady: true,
    googleAuthority: { connected: true, hasSearchConsoleScope: true },
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("ga4FirstSyncSignals / searchConsoleFirstSyncSignals", () => {
  it("returns nothing at all when the provider serves no status", () => {
    expect(ga4FirstSyncSignals(null, "2026-08-17T10:00:00.000Z")).toBeNull();
    expect(
      searchConsoleFirstSyncSignals(undefined, "2026-08-17T10:00:00.000Z"),
    ).toBeNull();
  });

  it("maps GA4's in-flight warm job onto an import with an unknown backfill", () => {
    const signals = ga4FirstSyncSignals(
      ga4Status(),
      "2026-08-17T10:00:00.000Z",
    );
    expect(signals).toEqual({
      connected: true,
      importing: true,
      entitiesReady: true,
      backfillFraction: null,
      snapshotReady: false,
      connectedAt: "2026-08-17T10:00:00.000Z",
    });
    // An unknown backfill parks the bar at the start of its own stage rather
    // than drifting upward — the same reading Shopify already gets.
    expect(resolveFirstSyncPercent(signals, NOW)).toBe(35);
  });

  it("maps Search Console's in-flight warm job the same way", () => {
    const signals = searchConsoleFirstSyncSignals(
      searchConsoleStatus(),
      "2026-08-17T10:00:00.000Z",
    );
    expect(signals?.importing).toBe(true);
    expect(signals?.entitiesReady).toBe(true);
    expect(signals?.backfillFraction).toBeNull();
    expect(resolveFirstSyncPercent(signals, NOW)).toBe(35);
  });

  it("holds GA4 at the entities stage until a property is selected", () => {
    const signals = ga4FirstSyncSignals(
      ga4Status({ state: "syncing", propertyReady: false, property: { id: null, name: null } }),
      "2026-08-17T10:00:00.000Z",
    );
    expect(signals?.entitiesReady).toBe(false);
    expect(resolveFirstSyncPercent(signals, NOW)).toBe(8);
  });

  it("refuses to paint a bar for any non-importing state", () => {
    for (const state of [
      "connected_no_property",
      "awaiting_first_sync",
      "first_sync_stalled",
      "ready",
    ] as const) {
      const signals = ga4FirstSyncSignals(
        ga4Status({ state, snapshotReady: state === "ready" }),
        "2026-08-17T10:00:00.000Z",
      );
      expect(resolveFirstSyncPercent(signals, NOW)).toBeNull();
    }
    for (const state of [
      "connected_no_site",
      "awaiting_first_sync",
      "first_sync_stalled",
      "action_required",
      "ready",
    ] as const) {
      const signals = searchConsoleFirstSyncSignals(
        searchConsoleStatus({ state, snapshotReady: state === "ready" }),
        "2026-08-17T10:00:00.000Z",
      );
      expect(resolveFirstSyncPercent(signals, NOW)).toBeNull();
    }
  });

  it("never calls a long-connected GA4 property a first import", () => {
    const signals = ga4FirstSyncSignals(
      ga4Status(),
      // Connected in March: older than the window the first import backfills.
      "2026-03-02T00:00:00.000Z",
    );
    expect(signals?.importing).toBe(true);
    expect(resolveFirstSyncPercent(signals, NOW)).toBeNull();
  });
});

describe("GA4 and Search Console cards", () => {
  function cardFor(
    provider: "ga4" | "search_console",
    status: GoogleAnalyticsStatusResponse | SearchConsoleStatusResponse,
    viewOverrides: Partial<ProviderViewState> = JUST_CONNECTED,
  ) {
    const views = baseViews();
    views[provider] = view(provider, viewOverrides);
    const model = buildIntegrationsExactModel({
      views,
      ga4Status: provider === "ga4" ? (status as GoogleAnalyticsStatusResponse) : null,
      searchConsoleStatus:
        provider === "search_console" ? (status as SearchConsoleStatusResponse) : null,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    return model.cards.find((card) => card.provider === provider)!;
  }

  it("shows the design's block for a GA4 property that just started importing", () => {
    const card = cardFor("ga4", ga4Status());
    expect(card.syncing).toBe(true);
    expect(card.status).toBe("Connecting");
    expect(card.meta).toBe(INTEGRATIONS_META_SYNCING);
    expect(card.button).toBeNull();
    expect(card.firstSync?.percentLabel).toBe("35%");
    expect(card.firstSync?.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
  });

  it("shows the block for a Search Console site that just started importing", () => {
    const card = cardFor("search_console", searchConsoleStatus());
    expect(card.syncing).toBe(true);
    expect(card.firstSync?.percentLabel).toBe("35%");
  });

  it("shows no block for a GA4 property connected months ago", () => {
    const card = cardFor("ga4", ga4Status(), CONNECTED);
    expect(card.firstSync).toBeNull();
    expect(card.syncing).toBe(false);
    expect(card.status).toBe("Connected");
    expect(card.button).toEqual({ caption: "Manage", kind: "manage" });
  });

  it("names a Search Console card whose Google authority is broken", () => {
    const card = cardFor(
      "search_console",
      searchConsoleStatus({
        state: "action_required",
        googleAuthority: { connected: false, hasSearchConsoleScope: false },
      }),
      { ...JUST_CONNECTED, status: "action_required", isConnected: false },
    );
    expect(card.firstSync).toBeNull();
    expect(card.status).toBe("Action required");
    expect(card.statusTone).toBe("attention");
  });

  it("leaves both cards blockless when neither status has been served yet", () => {
    const views = baseViews();
    views.ga4 = view("ga4", JUST_CONNECTED);
    views.search_console = view("search_console", JUST_CONNECTED);
    const model = buildIntegrationsExactModel({
      views,
      connectableProviders: CONNECTABLE,
      logoFor,
      now: NOW,
    });
    for (const provider of ["ga4", "search_console"] as const) {
      const card = model.cards.find((entry) => entry.provider === provider)!;
      expect(card.firstSync).toBeNull();
      expect(card.syncing).toBe(false);
    }
  });
});
