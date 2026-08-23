import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hasHydrated: true,
  authBootstrapStatus: "idle" as "idle" | "loading" | "ready",
  pathname: "/platforms/meta",
  setAuthBootstrapStatus: vi.fn(),
  setWorkspaceResolved: vi.fn(),
  setLanguage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({
      hasHydrated: state.hasHydrated,
      authBootstrapStatus: state.authBootstrapStatus,
      setAuthBootstrapStatus: state.setAuthBootstrapStatus,
      setWorkspaceResolved: state.setWorkspaceResolved,
    }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ setLanguage: state.setLanguage }),
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));
vi.mock("@/lib/public-url", () => ({ normalizeBindAllOriginForBrowser: (v: string) => v }));
vi.mock("@/lib/client-auth-state", () => ({
  applyAuthenticatedWorkspace: vi.fn(),
  clearAuthScopedClientState: vi.fn(),
}));

import { AuthBootstrap } from "@/components/layout/auth-bootstrap";

/**
 * The effect is keyed on pathname so failures can be logged with their route.
 * That also meant every sidebar hop refetched /api/auth/me and pushed the
 * status back to "loading", which unmounts the page the operator was reading.
 */
describe("auth bootstrap runs once per session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.authBootstrapStatus = "idle";
    state.hasHydrated = true;
  });

  it("renders without crashing while idle", () => {
    expect(() => renderToStaticMarkup(<AuthBootstrap />)).not.toThrow();
  });

  it("guards on a ready session so navigation cannot restart the bootstrap", async () => {
    state.authBootstrapStatus = "ready";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { AuthBootstrap: Fresh } = await import("@/components/layout/auth-bootstrap");
    renderToStaticMarkup(<Fresh />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.setAuthBootstrapStatus).not.toHaveBeenCalledWith("loading");
    vi.unstubAllGlobals();
  });

  it("does not re-trigger itself through its own status transition", async () => {
    /**
     * `load()` sets the status to "loading" as its first act. While that status
     * was an effect dependency, the effect re-ran immediately, its cleanup
     * aborted the request already in flight, and the re-run issued a second
     * `/api/auth/me`. The abort is client-side: the server had answered both.
     * Measured on the mounted routes — every page load made two session reads.
     */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/layout/auth-bootstrap.tsx", "utf8");
    // Read, not depended on.
    expect(source).toContain('useAppStore.getState().authBootstrapStatus === "ready"');
    const bootstrapDeps = source.slice(
      source.indexOf("}, [hasHydrated, pathname"),
      source.indexOf("}, [hasHydrated, pathname") + 120,
    );
    expect(bootstrapDeps).not.toContain("authBootstrapStatus");
  });
});
