import { useQueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";
import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import { useAppStore } from "@/store/app-store";

const workspace: WorkspaceContextEnvelope = {
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
    id: "business_1",
    name: "IwaStore",
    configuredCurrency: "USD",
    businessTimezone: "America/Los_Angeles",
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

function QueryConsumer() {
  useQueryClient();
  return <div>legacy interior mounted</div>;
}

describe("LegacyInteriorBridge", () => {
  beforeEach(() => {
    act(() => useAppStore.getState().clearWorkspaceState());
  });

  it("supplies the legacy query client and synchronizes the canonical business", async () => {
    render(
      <WorkspaceContextProvider value={workspace}>
        <LegacyInteriorBridge>
          <QueryConsumer />
        </LegacyInteriorBridge>
      </WorkspaceContextProvider>,
    );

    expect(screen.getByText("legacy interior mounted")).toBeInTheDocument();
    await waitFor(() => {
      expect(useAppStore.getState()).toMatchObject({
        workspaceOwnerId: "user_1",
        selectedBusinessId: "business_1",
        hasHydrated: true,
        authBootstrapStatus: "ready",
        workspaceResolved: true,
        businesses: [
          {
            id: "business_1",
            name: "IwaStore",
            currency: "USD",
            timezone: "America/Los_Angeles",
          },
        ],
      });
    });
  });
});
// @vitest-environment jsdom
