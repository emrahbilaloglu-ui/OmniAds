import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";

const appState = vi.hoisted(() => ({
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
  pathname: "/platforms/meta/creative-inbox",
  providerAccountId: "",
}));

const freshness = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
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
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
    }) => unknown,
  ) => selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: freshness,
}));

const useQueryMock = vi.mocked(useQuery);

function inboxCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "creative_1",
    creativeId: "creative_1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    name: "Server briefing item",
    campaign: "Prospecting",
    label: "Review",
    spend: null,
    roas: null,
    ...overrides,
  };
}

beforeEach(() => {
  appState.selectedBusinessId = null;
  appState.workspaceResolved = false;
  queryState.accounts = undefined;
  queryState.accountsError = null;
  queryState.accountsLoading = false;
  queryState.inbox = undefined;
  queryState.inboxError = null;
  queryState.inboxLoading = false;
  navigationState.pathname = "/platforms/meta/creative-inbox";
  navigationState.providerAccountId = "";
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const data = accountQuery ? queryState.accounts : queryState.inbox;
      const error = accountQuery
        ? queryState.accountsError
        : queryState.inboxError;
      const loading = accountQuery
        ? queryState.accountsLoading
        : queryState.inboxLoading;
      return {
        data,
        error,
        fetchStatus: loading ? "fetching" : "idle",
        isError: Boolean(error),
        isFetching: loading,
        isLoading: loading,
        refetch: vi.fn(),
        status: error ? "error" : data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

describe("MetaCreativeInboxPage exact integration", () => {
  it("uses server-authorized props instead of workspace or URL scope", () => {
    appState.selectedBusinessId = "biz_store";
    appState.workspaceResolved = false;
    navigationState.pathname = "/c/biz_authorized/creative/inbox";
    navigationState.providerAccountId = "act_url";
    queryState.inbox = {
      inbox: [
        inboxCard({
          businessId: "biz_authorized",
          providerAccountId: "act_authorized",
        }),
        inboxCard({
          id: "wrong",
          businessId: "biz_store",
          providerAccountId: "act_url",
          name: "Wrong scope",
        }),
      ],
      errors: [],
    };

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["meta-provider-accounts", "biz_authorized"],
        enabled: false,
      }),
    );
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "creative-account-inbox",
          "biz_authorized",
          "act_authorized",
        ],
        enabled: true,
      }),
    );
    expect(html).toContain('data-creative-studio-exact="true"');
    expect(html).toContain(
      'href="/c/biz_authorized/creative/copies?providerAccountId=act_authorized"',
    );
    expect(html).not.toContain("Wrong scope");
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_authorized" }),
    );
  });

  it("renders the exact four-column board without inventing workflow placement", () => {
    queryState.inbox = {
      inbox: [inboxCard()],
      errors: [],
    };

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html.match(/data-inbox-column=/g)).toHaveLength(4);
    expect(html).toContain('data-inbox-column="requested"');
    expect(html).toContain('data-inbox-column="in-production"');
    expect(html).toContain('data-inbox-column="delivered"');
    expect(html).toContain('data-inbox-column="live"');
    expect(html).not.toContain("data-inbox-card=");
    expect(html).not.toContain("Server briefing item");
    expect(html).toContain(
      "workflow status, owner, and due date are not supplied",
    );
    expect(html).toContain("Requests route here from");
    expect(html).toMatch(/<button disabled=""[^>]*>Browse files<\/button>/);
    expect(html).not.toContain("Ad account");
    expect(html).not.toContain("Open Decisions");
  });

  it("surfaces query failure instead of presenting an empty workflow", () => {
    queryState.inboxError = new Error("briefing failed");

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).toContain("briefing failed");
    expect(html).not.toContain("No workflow items are available");
    expect(html).not.toContain("data-inbox-card=");
  });

  it("keeps a server-refused account null and does not fall back to URL scope", () => {
    navigationState.providerAccountId = "act_url";

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId={null} />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", ""],
        enabled: false,
      }),
    );
    expect(html).toContain(
      "Select one assigned Meta account to load the creative workflow",
    );
    expect(html).not.toContain("providerAccountId=act_url");
  });

  it("retains legacy assigned-account discovery while isolating the inbox query", () => {
    appState.workspaceResolved = true;
    appState.selectedBusinessId = "biz_1";
    navigationState.providerAccountId = "act_1";
    queryState.accounts = [
      { id: "act_1", name: "Primary", currency: "USD", timezone: null },
      { id: "act_2", name: "Other", currency: "EUR", timezone: null },
    ];
    queryState.inbox = {
      inbox: [
        inboxCard(),
        inboxCard({
          id: "wrong-account",
          providerAccountId: "act_2",
          name: "Wrong account",
        }),
      ],
      errors: [],
    };

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", "act_1"],
        enabled: true,
      }),
    );
    expect(html).not.toContain("Wrong account");
    expect(html).toContain("1 scoped decision item is available");
  });

  it("withholds counts and reads until the legacy workspace scope resolves", () => {
    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "", ""],
        enabled: false,
      }),
    );
    expect(html).toContain("Loading assigned Meta account scope");
    expect(html).not.toContain("0 items");
    expect(html).not.toContain("data-inbox-card=");
  });
});
