// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const navigation = vi.hoisted(() => ({
  pathname: "/c/client-controlled/meta/decisions",
  searchParams: new URLSearchParams(),
}));
const frameSelections = vi.hoisted(() => [] as Array<string | null>);

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

vi.mock("@/components/layout/dashboard-frame", async () => {
  const { useAppStore } = await import("@/store/app-store");
  return {
    DashboardFrame: ({ children }: { children: React.ReactNode }) => {
      const selectedBusinessId = useAppStore.getState().selectedBusinessId;
      frameSelections.push(selectedBusinessId);
      return (
        <div data-testid="dashboard-frame" data-business-id={selectedBusinessId}>
          {children}
        </div>
      );
    },
  };
});

import { UnifiedDashboardClientShell } from "@/components/dashboard-v2/unified-client-shell";
import { useAppStore } from "@/store/app-store";

const businesses = [
  {
    id: "business_A",
    name: "Business A",
    timezone: "Europe/Istanbul",
    currency: "TRY",
  },
  {
    id: "business_B",
    name: "Business B",
    timezone: "America/New_York",
    currency: "USD",
  },
];

const envelopeA: WorkspaceContextEnvelope = {
  actor: {
    userId: "user_1",
    name: "Operator",
    language: "en",
    membershipRole: "admin",
    reviewerReadOnly: false,
    demo: false,
  },
  mode: "client",
  business: {
    id: "business_A",
    name: "Business A",
    configuredCurrency: "TRY",
    businessTimezone: "Europe/Istanbul",
  },
  provider: null,
  evidence: {
    windowLabel: null,
    snapshotAt: null,
    sourceUpdatedAt: null,
    freshness: "unknown",
  },
  proof: { currency: "configured-only", timezone: "unknown" },
  rollout: { zeroBaseEnabled: true, mutationUiEnabled: false },
};

describe("business-scoped Dashboard v2 shell binding", () => {
  beforeEach(() => {
    navigation.pathname = "/c/client-controlled/meta/decisions";
    navigation.searchParams = new URLSearchParams();
    frameSelections.length = 0;
    useAppStore.setState({
      businesses,
      selectedBusinessId: "business_B",
      workspaceOwnerId: "user_1",
      hasHydrated: true,
      authBootstrapStatus: "ready",
      workspaceResolved: true,
    });
  });

  afterEach(() => cleanup());

  it("never mounts B-backed shell hooks on route A and narrows only the active selection", async () => {
    render(
      <UnifiedDashboardClientShell envelope={envelopeA}>
        <div>Route A body</div>
      </UnifiedDashboardClientShell>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-frame")).toHaveAttribute(
        "data-business-id",
        "business_A",
      );
    });

    expect(frameSelections).not.toContain("business_B");
    expect(frameSelections.every((id) => id === "business_A")).toBe(true);
    expect(useAppStore.getState().selectedBusinessId).toBe("business_A");
    expect(useAppStore.getState().businesses).toEqual(businesses);
    expect(useAppStore.getState().authBootstrapStatus).toBe("ready");
    expect(screen.getByText("Route A body")).toBeInTheDocument();
  });

  it("fails closed without inventing an A membership", async () => {
    useAppStore.setState({
      businesses: [businesses[1]!],
      selectedBusinessId: "business_B",
    });

    render(
      <UnifiedDashboardClientShell envelope={envelopeA}>
        <div>Route A body</div>
      </UnifiedDashboardClientShell>,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-dashboard-scope-binding="pending"]'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("dashboard-frame")).not.toBeInTheDocument();
    expect(frameSelections).toEqual([]);
    expect(useAppStore.getState().selectedBusinessId).toBe("business_B");
    expect(useAppStore.getState().businesses).toEqual([businesses[1]]);
    expect(useAppStore.getState().authBootstrapStatus).toBe("ready");
  });

  it("leaves the session-active selection authoritative for the /app family", () => {
    navigation.pathname = "/app/meta/decisions";

    render(
      <UnifiedDashboardClientShell envelope={envelopeA}>
        <div>Readable route body</div>
      </UnifiedDashboardClientShell>,
    );

    expect(screen.getByTestId("dashboard-frame")).toHaveAttribute(
      "data-business-id",
      "business_B",
    );
    expect(useAppStore.getState().selectedBusinessId).toBe("business_B");
    expect(useAppStore.getState().businesses).toEqual(businesses);
  });
});
