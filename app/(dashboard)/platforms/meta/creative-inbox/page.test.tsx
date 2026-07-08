import React from "react";
import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/page";

const appState = vi.hoisted(() => ({
  businesses: [] as Array<{ id: string; name: string; currency: string }>,
  workspaceResolved: false,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      businesses: Array<{ id: string; name: string; currency: string }>;
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
    appState.workspaceResolved = false;
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);
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
    useQueryMock.mockReturnValue({
      data: {
        inbox: [
          {
            id: "creative_1",
            businessId: "biz_1",
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
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("1 items");
    expect(html).toContain("Priority");
    expect(html).toContain("Spend —");
    expect(html).toContain("ROAS —");
    expect(html).toContain("Confidence —");
    expect(html).not.toContain("Spend $0");
    expect(html).not.toContain("ROAS 0.00");
    expect(html).not.toContain("Confidence 0%");
  });

  it("surfaces query failure instead of presenting an empty inbox", () => {
    appState.workspaceResolved = true;
    appState.businesses = [{ id: "biz_1", name: "TheSwaf", currency: "USD" }];
    useQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("briefing failed"),
      isError: true,
      isFetching: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(html).toContain("Creative inbox unavailable");
    expect(html).not.toContain("No creative priorities are available");
  });
});
