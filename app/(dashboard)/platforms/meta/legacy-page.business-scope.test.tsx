// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One link, one workspace — or nothing.
 *
 * `/platforms/meta` has no `[businessId]` segment, so the business it renders
 * can only come from the session: the same answer the switcher, the rail and
 * every shell query already use. This file previously pinned the opposite —
 * that `?businessId=` selects the body's workspace — and that is the live
 * defect it was meant to prevent, inverted: opening
 * `/platforms/meta?businessId=<Grandmix>` while IwaStore was active painted
 * "IwaStore" in the switcher, "Grandmix" in the body, and split the requests
 * between the two. A query parameter cannot authorize scope, so it cannot
 * select it either.
 *
 * The law now: the body renders the server-authorized business and nothing
 * else. When the link names a different one the route refuses and asks, and
 * the only thing that resolves it is a switch the server performs — after
 * which the switcher, the body and every request name the same workspace.
 */
const grandmix = {
  id: "biz_grandmix",
  name: "Grandmix",
  currency: "TRY",
  timezone: "Europe/Istanbul",
};
const iwa = {
  id: "biz_iwa",
  name: "IwaStore",
  currency: "USD",
  timezone: "Europe/Istanbul",
};

const state = {
  businesses: [grandmix, iwa] as Array<typeof grandmix>,
  selectedBusinessId: "biz_iwa" as string | null,
  workspaceResolved: true,
  selectBusiness: vi.fn(),
};
const navigation = {
  search: new URLSearchParams(),
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.search,
  usePathname: () => "/platforms/meta",
  useRouter: () => ({
    replace: navigation.replace,
    refresh: navigation.refresh,
    push: navigation.push,
  }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

/**
 * Every Meta read this surface performs is scoped by the props below —
 * `businessId` selects the account catalog, `currency` labels the money — so
 * recording them records the scope of every request the body can make.
 */
const seen: Array<{
  businessId: string;
  businessName: string | null;
  currency: string | null;
}> = [];
vi.mock("@/components/meta/redesign/MetaPlatformPage", () => ({
  MetaPlatformPage: (props: {
    businessId: string;
    businessName: string | null;
    currency: string | null;
  }) => {
    seen.push({
      businessId: props.businessId,
      businessName: props.businessName,
      currency: props.currency,
    });
    return <div data-testid="meta" />;
  },
}));

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => <div data-testid="empty" />,
}));

const fetchMock = vi.fn();
const MetaPage = (await import("./legacy-page")).default;

describe("the legacy Meta route never renders two workspaces at once", () => {
  beforeEach(() => {
    seen.length = 0;
    state.businesses = [grandmix, iwa];
    state.selectedBusinessId = "biz_iwa";
    state.workspaceResolved = true;
    state.selectBusiness.mockReset();
    navigation.search = new URLSearchParams();
    window.history.replaceState(null, "", "/platforms/meta");
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("refuses instead of rendering the link's business under the active one", () => {
    navigation.search = new URLSearchParams("businessId=biz_grandmix");
    render(<MetaPage />);

    expect(screen.getByTestId("meta-business-scope-refusal")).toBeTruthy();
    // Not one render reached the body: not with Grandmix, which the URL asked
    // for and nothing authorized, and not with IwaStore, whose account and
    // currency would then be sitting under a link naming Grandmix.
    expect(seen).toEqual([]);
    expect(screen.queryByTestId("meta")).toBeNull();
    expect(document.body.textContent).toContain("Grandmix");
    expect(document.body.textContent).not.toContain("USD");
  });

  it("resolves the split only through a switch the server performs", async () => {
    navigation.search = new URLSearchParams("businessId=biz_grandmix");
    const view = render(<MetaPage />);

    fireEvent.click(screen.getByRole("button", { name: /Switch to Grandmix/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: "biz_grandmix" }),
    });
    // The store is told only after the server moved the session, so no render
    // exists in which this body and the switcher above it disagree.
    await waitFor(() =>
      expect(state.selectBusiness).toHaveBeenCalledWith("biz_grandmix"),
    );
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      state.selectBusiness.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledOnce());

    // What the session now answers, re-rendered through the same route.
    state.selectedBusinessId = "biz_grandmix";
    view.rerender(<MetaPage />);

    expect(seen).toEqual([
      {
        businessId: "biz_grandmix",
        businessName: "Grandmix",
        currency: "TRY",
      },
    ]);
    expect(seen.some((render) => render.businessId === "biz_iwa")).toBe(false);
    expect(seen.some((render) => render.currency === "USD")).toBe(false);
  });

  it("keeps the refusal when the server declines the switch", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    navigation.search = new URLSearchParams("businessId=biz_grandmix");
    render(<MetaPage />);

    fireEvent.click(screen.getByRole("button", { name: /Switch to Grandmix/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    await waitFor(() =>
      expect(document.body.textContent).toContain("The workspace switch was refused"),
    );
  });

  it("offers no switch for a business this account cannot open, and shows none of it", () => {
    navigation.search = new URLSearchParams("businessId=biz_someone_else");
    render(<MetaPage />);

    expect(screen.getByTestId("meta-business-scope-refusal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("drops the contradicting parameter instead of guessing, on request", () => {
    navigation.search = new URLSearchParams(
      "businessId=biz_grandmix&providerAccountId=act_9",
    );
    // The address bar is the live one; the router snapshot can trail it.
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?businessId=biz_grandmix&providerAccountId=act_9",
    );
    render(<MetaPage />);

    fireEvent.click(screen.getByRole("button", { name: /Continue in IwaStore/ }));

    expect(navigation.replace).toHaveBeenCalledOnce();
    const target = navigation.replace.mock.calls[0]![0] as string;
    expect(target).toBe("/platforms/meta?providerAccountId=act_9");
  });

  it("renders the session's business when the link names none", () => {
    render(<MetaPage />);
    expect(seen[0]).toEqual({
      businessId: "biz_iwa",
      businessName: "IwaStore",
      currency: "USD",
    });
  });

  it("renders normally when the link names the business already active", () => {
    navigation.search = new URLSearchParams("businessId=biz_iwa");
    render(<MetaPage />);
    expect(seen[0]?.businessId).toBe("biz_iwa");
  });

  it("lets a route-scoped server answer win, and refuses a query that contradicts it", () => {
    navigation.search = new URLSearchParams("businessId=biz_grandmix");
    render(
      <MetaPage businessId="biz_iwa" businessName="IwaStore" currency="USD" />,
    );

    expect(seen).toEqual([]);
    expect(screen.getByTestId("meta-business-scope-refusal")).toBeTruthy();
    // A path-scoped route is already the authority; a session switch would not
    // change the path, so the only offer is to drop the contradiction.
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
  });

  it("holds the surface rather than claiming a workspace is unavailable before the list arrives", () => {
    state.businesses = [];
    state.selectedBusinessId = "biz_iwa";
    state.workspaceResolved = false;
    navigation.search = new URLSearchParams("businessId=biz_grandmix");
    const { container } = render(<MetaPage />);

    expect(container.querySelector("[data-meta-scope-binding]")).toBeTruthy();
    expect(screen.queryByTestId("meta-business-scope-refusal")).toBeNull();
    expect(seen).toEqual([]);
  });
});
