import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GoogleAuthorizedScope } from "@/components/google-ads/google-authorized-scope";

const screenMocks = vi.hoisted(() => ({
  dashboard: vi.fn((_props: Record<string, unknown>) => null),
  selectedBusinessId: "stale_business" as string | null,
  businesses: [] as Array<Record<string, unknown>>,
  domainsByBusinessId: {} as Record<string, unknown>,
  bootstrap: {
    isBootstrapping: true,
    bootstrapStatus: "loading" as const,
  },
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: screenMocks.selectedBusinessId,
      businesses: screenMocks.businesses,
    }),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ domainsByBusinessId: screenMocks.domainsByBusinessId }),
}));
vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: vi.fn(() => screenMocks.bootstrap),
}));
vi.mock("@/lib/business-mode", () => ({
  isDemoBusinessSelected: vi.fn(() => false),
}));
vi.mock("@/store/integrations-support", () => ({
  buildDefaultProviderDomains: vi.fn(() => ({
    google: { status: "disconnected", isConnected: false },
  })),
  deriveProviderViewState: vi.fn(() => ({
    status: "disconnected",
    isConnected: false,
  })),
}));
vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));
vi.mock("@/components/states/IntegrationEmptyState", () => ({
  IntegrationEmptyState: () => React.createElement("div", null, "integration-empty"),
}));
vi.mock("@/components/states/loading-skeleton", () => ({
  LoadingSkeleton: () => React.createElement("div", null, "bootstrap-loading"),
}));
vi.mock("@/components/google-ads/GoogleAdsIntelligenceDashboard", () => ({
  GoogleAdsIntelligenceDashboard: (props: Record<string, unknown>) => {
    screenMocks.dashboard(props);
    return React.createElement("div", null, "google-dashboard");
  },
}));

const { GoogleWorkspaceScreen } = await import(
  "@/components/google-ads/GoogleWorkspaceScreen"
);
const bootstrapModule = await import(
  "@/hooks/use-business-integrations-bootstrap"
);

const baseScope: GoogleAuthorizedScope = {
  businessId: "authorized_business",
  businessName: "Authorized Business",
  providerAccountId: "4931182201",
  accountLabel: "Primary Google",
  currency: "USD",
  timezone: "America/New_York",
  viewerReadOnly: false,
  demo: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  screenMocks.selectedBusinessId = "stale_business";
  screenMocks.businesses = [];
  screenMocks.domainsByBusinessId = {};
  screenMocks.bootstrap = {
    isBootstrapping: true,
    bootstrapStatus: "loading",
  };
});

describe("GoogleWorkspaceScreen server scope", () => {
  it("mounts the authorized dashboard despite stale client integration/bootstrap state", () => {
    const html = renderToStaticMarkup(
      <GoogleWorkspaceScreen
        panel="summary"
        title="Overview"
        authorizedScope={baseScope}
      />,
    );

    expect(html).toContain("google-dashboard");
    expect(html).not.toContain("bootstrap-loading");
    expect(html).not.toContain("integration-empty");
    expect(bootstrapModule.useBusinessIntegrationsBootstrap).toHaveBeenCalledWith(
      "authorized_business",
    );
    expect(screenMocks.dashboard).toHaveBeenCalledWith({
      businessId: "authorized_business",
      panel: "summary",
      screenTitle: "Overview",
      authorizedScope: baseScope,
    });
  });

  it("preserves an authoritative null account instead of falling back to client state", () => {
    const nullScope = { ...baseScope, providerAccountId: null };

    const html = renderToStaticMarkup(
      <GoogleWorkspaceScreen
        panel="insights"
        title="Advisor"
        authorizedScope={nullScope}
      />,
    );

    expect(html).toContain("google-dashboard");
    expect(screenMocks.dashboard.mock.calls[0]?.[0]).toMatchObject({
      businessId: "authorized_business",
      authorizedScope: { providerAccountId: null },
    });
  });

  it.each([
    ["summary", "Overview"],
    ["insights", "Advisor"],
    ["search", "Search intelligence"],
    ["products", "Products & feed"],
  ] as const)(
    "keeps the legacy exact %s skeleton mounted while connection state is unavailable",
    (panel, title) => {
      const html = renderToStaticMarkup(
        <GoogleWorkspaceScreen panel={panel} title={title} />,
      );

      expect(html).toContain("google-dashboard");
      expect(html).not.toContain("bootstrap-loading");
      expect(html).not.toContain("integration-empty");
      expect(screenMocks.dashboard).toHaveBeenCalledWith({
        businessId: "stale_business",
        panel,
        screenTitle: title,
        authorizedScope: undefined,
      });
    },
  );

  it("retains the legacy loading guard on a non-exact Google leaf", () => {
    const html = renderToStaticMarkup(
      <GoogleWorkspaceScreen panel="assets" title="Assets" />,
    );

    expect(html).toContain("bootstrap-loading");
    expect(html).not.toContain("google-dashboard");
  });
});
