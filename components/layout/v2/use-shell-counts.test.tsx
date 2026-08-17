// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { useGoogleAdvisorCount } from "./use-shell-signals";

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: { selectedBusinessId: string }) => unknown) =>
    selector({ selectedBusinessId: "biz_1" }),
}));

describe("dashboard rail cached counts", () => {
  it("keeps Google Advisor absent until a real response is cached", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useGoogleAdvisorCount(), { wrapper });
    expect(result.current).toBeNull();

    act(() => {
      queryClient.setQueryData(["google-advisor", "biz_1"], {
        recommendations: [{ id: "one" }, { id: "two" }, { id: "three" }],
      });
    });

    expect(result.current).toBe(3);
  });
});
