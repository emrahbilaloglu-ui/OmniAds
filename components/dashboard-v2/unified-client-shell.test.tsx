import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const navigation = vi.hoisted(() => ({
  pathname: "/app/home",
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
}));

vi.mock("@/providers/query-provider", () => ({
  QueryProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/layout/auth-bootstrap", () => ({
  AuthBootstrap: () => null,
}));

vi.mock("@/components/layout/dashboard-frame", () => ({
  DashboardFrame: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

import {
  UnifiedDashboardClientShell,
  buildEffectiveDashboardEnvelope,
  dashboardProviderForPathname,
} from "@/components/dashboard-v2/unified-client-shell";
import { useWorkspaceContext } from "@/components/workspace/workspace-context-provider";

const envelope: WorkspaceContextEnvelope = {
  actor: {
    userId: "user_1",
    name: "Operator",
    language: "en",
    membershipRole: "admin",
    reviewerReadOnly: true,
    demo: true,
  },
  mode: "client",
  business: {
    id: "business_1",
    name: "Real business",
    configuredCurrency: "USD",
    businessTimezone: "America/Los_Angeles",
  },
  provider: null,
  evidence: {
    windowLabel: "Server evidence window",
    snapshotAt: "2026-08-16T12:00:00.000Z",
    sourceUpdatedAt: "2026-08-16T11:55:00.000Z",
    freshness: "fresh",
  },
  proof: { currency: "configured-only", timezone: "unknown" },
  rollout: { zeroBaseEnabled: true, mutationUiEnabled: false },
};

const catalogs: ProviderScopeCatalog[] = [
  {
    provider: "meta",
    accounts: [
      {
        id: "act_1",
        label: "Meta One",
        currency: "USD",
        timezone: "America/Los_Angeles",
      },
      {
        id: "act_2",
        label: "Meta Two",
        currency: "EUR",
        timezone: "Europe/Berlin",
      },
    ],
  },
  {
    provider: "google",
    accounts: [
      {
        id: "gads_1",
        label: "Google One",
        currency: "USD",
        timezone: "America/Los_Angeles",
      },
    ],
  },
];

function ContextProbe() {
  const value = useWorkspaceContext();
  return <output>{JSON.stringify(value)}</output>;
}

describe("Dashboard v2 unified client shell scope", () => {
  it("maps both canonical route families to the same provider", () => {
    expect(dashboardProviderForPathname("/app/meta/decisions")).toBe("meta");
    expect(dashboardProviderForPathname("/app/creative/performance")).toBe(
      "meta",
    );
    expect(dashboardProviderForPathname("/c/business_1/google/advisor")).toBe(
      "google",
    );
    expect(dashboardProviderForPathname("/c/business_1/home")).toBeNull();
    expect(dashboardProviderForPathname("/app/metadata")).toBeNull();
  });

  it("selects only a server-catalogued account and carries the explicit creative window", () => {
    const effective = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/app/creative/performance",
      searchParams: new URLSearchParams({
        providerAccountId: "act_2",
        start: "2026-07-20",
        end: "2026-08-16",
      }),
      providerCatalogs: catalogs,
    });

    expect(effective.provider).toEqual({
      id: "meta",
      selectedAccountIds: ["act_2"],
      selectedAccountLabel: "Meta Two",
      mode: "single",
    });
    expect(effective.evidence).toEqual({
      ...envelope.evidence,
      windowLabel: "2026-07-20 → 2026-08-16",
    });
    expect(effective.actor).toEqual(envelope.actor);
    expect(effective.business).toEqual(envelope.business);
    expect(effective.proof).toEqual(envelope.proof);
    expect(effective.rollout).toEqual(envelope.rollout);
  });

  it("does not let an unknown query account widen the server-authorized catalog", () => {
    const effective = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/c/business_1/meta/decisions",
      searchParams: new URLSearchParams({
        providerAccountId: "foreign_account",
      }),
      providerCatalogs: catalogs,
    });

    expect(effective.provider).toEqual({
      id: "meta",
      selectedAccountIds: ["act_1", "act_2"],
      selectedAccountLabel: null,
      mode: "portfolio",
    });
    expect(effective.provider?.selectedAccountIds).not.toContain(
      "foreign_account",
    );
  });

  it("preserves the single-account default and non-creative evidence semantics", () => {
    const effective = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/c/business_1/google/advisor",
      searchParams: new URLSearchParams(),
      providerCatalogs: catalogs,
    });

    expect(effective.provider).toEqual({
      id: "google",
      selectedAccountIds: ["gads_1"],
      selectedAccountLabel: "Google One",
      mode: "single",
    });
    expect(effective.evidence.windowLabel).toBe("Server evidence window");
  });

  /**
   * Rewritten: this pinned the shell asserting "Last 28 days" as a constant on
   * any creative path with no window in the URL. The shell measures nothing —
   * it printed a caption for a window the body may never have read, which is a
   * confident claim in place of an unknown. The law is that an unstated window
   * is not captioned at all; the server's own label answers, and when it has
   * none the label stays null so the surface can render it as unavailable.
   */
  it("never captions a creative window the URL did not state", () => {
    const effective = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/c/business_1/creative/copies",
      searchParams: new URLSearchParams(),
      providerCatalogs: catalogs,
    });

    expect(effective.provider?.id).toBe("meta");
    expect(effective.evidence.windowLabel).toBe("Server evidence window");
    expect(effective.evidence.windowLabel).not.toBe("Last 28 days");
  });

  it("captions the window the shell control stated, in either spelling", () => {
    const canonical = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/c/business_1/creative/copies",
      searchParams: new URLSearchParams({
        window: "custom",
        startDate: "2026-07-01",
        endDate: "2026-07-14",
      }),
      providerCatalogs: catalogs,
    });
    expect(canonical.evidence.windowLabel).toBe("2026-07-01 → 2026-07-14");

    const creativeSpelling = buildEffectiveDashboardEnvelope({
      envelope,
      pathname: "/c/business_1/creative/copies",
      searchParams: new URLSearchParams({
        start: "2026-07-01",
        end: "2026-07-14",
      }),
      providerCatalogs: catalogs,
    });
    expect(creativeSpelling.evidence.windowLabel).toBe(
      "2026-07-01 → 2026-07-14",
    );
  });

  it("provides the effective envelope before the shared Dashboard v2 frame", () => {
    navigation.pathname = "/app/creative/inbox";
    navigation.searchParams = new URLSearchParams({
      providerAccountId: "act_1",
      start: "2026-08-01",
      end: "2026-08-16",
    });

    const markup = renderToStaticMarkup(
      <UnifiedDashboardClientShell
        envelope={envelope}
        providerCatalogs={catalogs}
      >
        <ContextProbe />
      </UnifiedDashboardClientShell>,
    );

    expect(markup).toContain(
      "&quot;selectedAccountIds&quot;:[&quot;act_1&quot;]",
    );
    expect(markup).toContain("2026-08-01 → 2026-08-16");
  });

  it("keeps provider catalogs wired in both server-authorized layouts and removes posture banners", () => {
    const shellSource = readFileSync(
      "components/dashboard-v2/unified-client-shell.tsx",
      "utf8",
    );
    expect(shellSource).not.toContain("PostureNotice");

    for (const path of [
      "app/app/layout.tsx",
      "app/c/[businessId]/layout.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("UnifiedDashboardClientShell");
      expect(source, path).toContain(
        'readProviderScopeCatalog(businessId, "meta")',
      );
      expect(source, path).toContain(
        'readProviderScopeCatalog(businessId, "google")',
      );
      expect(source, path).toContain(
        "providerCatalogs={[metaAccounts, googleAccounts]}",
      );
      expect(source, path).not.toContain("zero-base/shell/client-shell");
    }
  });
});
