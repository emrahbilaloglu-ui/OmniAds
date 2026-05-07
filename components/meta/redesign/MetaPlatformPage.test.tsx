import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaAnomaly, metaLanePayload, metaPulse } from "@/components/meta/redesign/test-fixtures";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  queryKeys: [] as unknown[][],
}));

function queryState(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  useSearchParams: () => new URLSearchParams("window=28d"),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: { queryKey: unknown[] }) => {
    state.queryKeys.push(input.queryKey);
    const key = String(input.queryKey[0]);
    if (key === "meta-account-pulse") return queryState(metaPulse());
    if (key === "meta-lanes") return queryState(metaLanePayload());
    if (key === "meta-anomalies") {
      return queryState({ anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 });
    }
    if (key === "triage-state") return queryState({ rows: [], deferredCount: 0 });
    return queryState(null);
  },
}));

describe("MetaPlatformPage", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.routerPush.mockClear();
    state.routerReplace.mockClear();
  });

  it("renders pulse, alerts strip, lanes, and cards from snapshot payloads", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Meta Decision Center");
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Action Now");
    expect(html).toContain("Watching");
    expect(html).toContain("Healthy ASC");
    expect(state.queryKeys.map((key) => key[0])).toContain("meta-lanes");
  });
});
