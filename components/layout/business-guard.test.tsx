import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessGuard } from "@/components/layout/business-guard";

const state = vi.hoisted(() => ({
  hasHydrated: false,
  authBootstrapStatus: "idle" as "idle" | "loading" | "ready",
  workspaceResolved: false,
  businesses: [] as Array<{ id: string }>,
  selectedBusinessId: null as string | null,
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  usePathname: () => "/platforms/meta",
}));

vi.mock("@/lib/auth-diagnostics", () => ({
  logClientAuthEvent: vi.fn(),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) => selector(state),
}));

describe("BusinessGuard", () => {
  beforeEach(() => {
    state.hasHydrated = false;
    state.authBootstrapStatus = "idle";
    state.workspaceResolved = false;
    state.businesses = [];
    state.selectedBusinessId = null;
    state.replace.mockReset();
  });

  it("renders a loading shell instead of a blank dashboard while workspace state resolves", () => {
    const html = renderToStaticMarkup(
      <BusinessGuard>
        <div>dashboard content</div>
      </BusinessGuard>,
    );

    expect(html).toContain('data-testid="business-guard-loading"');
    expect(html).toContain("Loading workspace...");
    expect(html).not.toContain("dashboard content");
  });

  it("renders a loading shell while a business setup redirect is pending", () => {
    state.hasHydrated = true;
    state.authBootstrapStatus = "ready";
    state.workspaceResolved = true;
    state.businesses = [];
    state.selectedBusinessId = null;

    const html = renderToStaticMarkup(
      <BusinessGuard>
        <div>dashboard content</div>
      </BusinessGuard>,
    );

    expect(html).toContain('data-testid="business-guard-loading"');
    expect(html).not.toContain("dashboard content");
  });

  it("renders children when hydration, auth, and workspace are ready", () => {
    state.hasHydrated = true;
    state.authBootstrapStatus = "ready";
    state.workspaceResolved = true;
    state.businesses = [{ id: "biz_1" }];
    state.selectedBusinessId = "biz_1";

    const html = renderToStaticMarkup(
      <BusinessGuard>
        <div>dashboard content</div>
      </BusinessGuard>,
    );

    expect(html).toContain("dashboard content");
    expect(html).not.toContain('data-testid="business-guard-loading"');
  });
});
