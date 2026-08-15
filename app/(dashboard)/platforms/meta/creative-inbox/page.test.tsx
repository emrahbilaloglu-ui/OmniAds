import React from "react";
import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";

const appState = vi.hoisted(() => ({
  businesses: [] as Array<{ id: string; name: string; currency: string }>,
  selectedBusinessId: null as string | null,
  workspaceResolved: false,
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  accountsError: null as Error | null,
  accountsLoading: false,
  inbox: undefined as unknown,
  inboxError: null as Error | null,
  inboxLoading: false,
}));

const navigationState = vi.hoisted(() => ({
  providerAccountId: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      navigationState.providerAccountId
        ? `providerAccountId=${navigationState.providerAccountId}`
        : "",
    ),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      businesses: Array<{ id: string; name: string; currency: string }>;
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
    }) => unknown,
  ) => selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

const useQueryMock = vi.mocked(useQuery);

describe("MetaCreativeInboxPage", () => {
  beforeEach(() => {
    appState.businesses = [];
    appState.selectedBusinessId = null;
    appState.workspaceResolved = false;
    queryState.accounts = undefined;
    queryState.accountsError = null;
    queryState.accountsLoading = false;
    queryState.inbox = undefined;
    queryState.inboxError = null;
    queryState.inboxLoading = false;
    navigationState.providerAccountId = "";
    useQueryMock.mockReset();
    useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const error = accountQuery ? queryState.accountsError : queryState.inboxError;
      const loading = accountQuery ? queryState.accountsLoading : queryState.inboxLoading;
      return {
        data: accountQuery ? queryState.accounts : queryState.inbox,
        error,
        isError: Boolean(error),
        isFetching: loading,
        isLoading: loading,
      } as ReturnType<typeof useQuery>;
    });
  });

  it("withholds empty counts until the workspace scope is resolved", () => {
    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(html).toContain("Loading workspace");
    expect(html).toContain("Loading");
    expect(html).not.toContain("0 items");
    expect(html).not.toContain("No creative priorities are available");
  });

  it("does not render missing optional metrics as zeros", () => {
    appState.workspaceResolved = true;
    appState.businesses = [{ id: "biz_1", name: "TheSwaf", currency: "USD" }];
    appState.selectedBusinessId = "biz_1";
    queryState.accounts = [
      { id: "act_1", name: "Main account", currency: "USD", timezone: null },
    ];
    queryState.inbox = {
        inbox: [
          {
            id: "creative_1",
            businessId: "biz_1",
            providerAccountId: "act_1",
            name: "Hook test",
            campaign: "Prospecting",
            label: "keep",
            priorityScore: null,
            spend: null,
            roas: null,
            confidence: null,
          },
        ],
        errors: [],
      };

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("1 items");
    expect(html).toContain("Priority");
    expect(html).toContain("Spend —");
    expect(html).toContain("ROAS —");
    expect(html).toContain("Confidence unavailable");
    expect(html).toContain("Priority unavailable");
    expect(html).not.toContain("Spend $0");
    expect(html).not.toContain("ROAS 0.00");
    expect(html).not.toContain("Confidence 0%");
  });

  it("surfaces query failure instead of presenting an empty inbox", () => {
    appState.workspaceResolved = true;
    appState.businesses = [{ id: "biz_1", name: "TheSwaf", currency: "USD" }];
    appState.selectedBusinessId = "biz_1";
    queryState.accounts = [
      { id: "act_1", name: "Main account", currency: "USD", timezone: null },
    ];
    queryState.inboxError = new Error("briefing failed");

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("Creative inbox unavailable");
    expect(html).not.toContain("No creative priorities are available");
  });

  it("renders only the selected business and provider account", () => {
    appState.workspaceResolved = true;
    appState.businesses = [
      { id: "biz_1", name: "TheSwaf", currency: "USD" },
      { id: "biz_2", name: "Other", currency: "EUR" },
    ];
    appState.selectedBusinessId = "biz_1";
    queryState.accounts = [
      { id: "act_1", name: "Primary", currency: "USD", timezone: null },
    ];
    queryState.inbox = {
        inbox: [
          { id: "one", creativeId: "one", businessId: "biz_1", providerAccountId: "act_1", name: "Visible" },
          { id: "two", creativeId: "two", businessId: "biz_1", providerAccountId: "act_2", name: "Wrong account" },
          { id: "three", creativeId: "three", businessId: "biz_2", providerAccountId: "act_1", name: "Wrong business" },
          { id: "four", creativeId: "four", businessId: "biz_1", providerAccountId: null, name: "Missing account" },
        ],
        errors: [],
      };

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("Visible");
    expect(html).not.toContain("Wrong account");
    expect(html).not.toContain("Wrong business");
    expect(html).not.toContain("Missing account");
    expect(html).toContain("1 item was withheld because provider account identity is missing");
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", "act_1"],
        enabled: true,
      }),
    );
  });

  it("withholds cards when multiple assigned accounts need an explicit choice", () => {
    appState.workspaceResolved = true;
    appState.businesses = [{ id: "biz_1", name: "TheSwaf", currency: "USD" }];
    appState.selectedBusinessId = "biz_1";
    queryState.accounts = [
      { id: "act_1", name: "Primary", currency: "USD", timezone: null },
      { id: "act_2", name: "Secondary", currency: "EUR", timezone: null },
    ];
    queryState.inbox = {
      inbox: [
        { id: "one", businessId: "biz_1", providerAccountId: "act_1", name: "Hidden" },
      ],
      errors: [],
    };

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("creative-inbox-account-required");
    expect(html).toContain("Withheld");
    expect(html).not.toContain("Hidden");
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", ""],
        enabled: false,
      }),
    );
  });

  it("honors the requested provider account and preserves it in Studio links", () => {
    appState.workspaceResolved = true;
    appState.businesses = [{ id: "biz_1", name: "IwaStore", currency: "USD" }];
    appState.selectedBusinessId = "biz_1";
    navigationState.providerAccountId = "act_2";
    queryState.accounts = [
      { id: "act_1", name: "Primary", currency: "USD", timezone: null },
      { id: "act_2", name: "IWA-MDNLLC", currency: "USD", timezone: null },
    ];
    queryState.inbox = {
      inbox: [
        { id: "one", businessId: "biz_1", providerAccountId: "act_1", name: "Hidden" },
        { id: "two", businessId: "biz_1", providerAccountId: "act_2", name: "IWA creative" },
      ],
      errors: [],
    };

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("IWA creative");
    expect(html).not.toContain("Hidden");
    expect(html).toContain("providerAccountId=act_2");
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", "act_2"],
        enabled: true,
      }),
    );
  });
});
