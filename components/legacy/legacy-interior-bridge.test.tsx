import { useQueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";
import { resolveCurrencySymbol } from "@/hooks/currency-support";
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

  /**
   * INVARIANTS.md, verbatim: "Provider-money copy must use the canonical
   * account currency. Missing currency must not silently become USD, $, TRY, or
   * EUR."
   *
   * This bridge wrote `configuredCurrency ?? "USD"` into the store, so a
   * workspace that had never configured a currency was handed one — and every
   * money cell downstream then printed a "$" nobody had chosen. Null is the
   * only honest value here, and the symbol resolver must refuse to invent a
   * symbol from it rather than pairing a real number with a wrong currency.
   */
  it("carries a missing currency as null instead of minting USD", async () => {
    render(
      <WorkspaceContextProvider
        value={{
          ...workspace,
          business: { ...workspace.business!, configuredCurrency: null },
          proof: { ...workspace.proof, currency: "unknown" },
        }}
      >
        <LegacyInteriorBridge>
          <QueryConsumer />
        </LegacyInteriorBridge>
      </WorkspaceContextProvider>,
    );

    await waitFor(() => {
      expect(useAppStore.getState().businesses).toEqual([
        {
          id: "business_1",
          name: "IwaStore",
          currency: null,
          timezone: "America/Los_Angeles",
        },
      ]);
    });

    const state = useAppStore.getState();
    expect(
      resolveCurrencySymbol(state.businesses, state.selectedBusinessId),
    ).toBeNull();
  });

  it("does not name a workspace with its own identifier", async () => {
    render(
      <WorkspaceContextProvider
        value={{
          ...workspace,
          business: { ...workspace.business!, name: null },
        }}
      >
        <LegacyInteriorBridge>
          <QueryConsumer />
        </LegacyInteriorBridge>
      </WorkspaceContextProvider>,
    );

    await waitFor(() => {
      expect(useAppStore.getState().businesses[0]).toMatchObject({
        id: "business_1",
        name: null,
      });
    });
    // The id is never reused as a display name.
    expect(useAppStore.getState().businesses[0]!.name).not.toBe("business_1");
  });
});
// @vitest-environment jsdom
