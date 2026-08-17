// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  fetchCreatives: vi.fn(),
  fetchDecisions: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "store_business",
      businesses: [
        { id: "store_business", name: "Store Business", currency: "USD" },
      ],
    }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("providerAccountId=act_unassigned"),
}));
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: scopeMocks.fetchAccounts,
}));
vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: scopeMocks.fetchDecisions,
  fetchMetaCreatives: scopeMocks.fetchCreatives,
  mapApiRowToUiRow: (row: unknown) => row,
}));

const MetaLaunchpadPage = (await import("./legacy-page")).default;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Meta Launchpad authorized client scope", () => {
  it("does not restore an unassigned URL account or issue scoped reads when the server resolved null", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const { container } = render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='launchpad-exact']")).not.toBeNull();
    });

    expect(scopeMocks.fetchAccounts).not.toHaveBeenCalled();
    expect(scopeMocks.fetchCreatives).not.toHaveBeenCalled();
    expect(scopeMocks.fetchDecisions).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("act_unassigned");

  });
});
