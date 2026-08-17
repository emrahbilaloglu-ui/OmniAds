import React from "react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockAppState = {
  businesses: [{ id: "biz_1", name: "Workspace One", currency: "USD" }],
  selectedBusinessId: "biz_1" as string | null,
  workspaceOwnerId: "user_1" as string | null,
};

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockAppState) => unknown) => selector(mockAppState),
}));

// The gate this screen used to sit behind: a Starter workspace must still see
// the roster, so the plan read is stubbed at the bottom of the ladder.
vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "starter", isLoading: false, isReady: true }),
}));

const originalFetch = globalThis.fetch;

describe("/team", () => {
  beforeEach(() => {
    mockAppState.selectedBusinessId = "biz_1";
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })) as unknown as typeof fetch;
  });

  it("renders the Team screen itself on a plan without seat entitlement", async () => {
    const { default: TeamPage } = await import("@/app/(dashboard)/team/legacy-page");
    const html = renderToStaticMarkup(React.createElement(TeamPage));

    expect(html).toContain('data-screen-label="Team"');
    expect(html).toContain("Invite people");
    expect(html).toContain("What each role can do");
    expect(html).toContain("Pending invites");
    expect(html).toContain("Recent access events");
    // The upsell the design never draws must not have replaced the page.
    expect(html).not.toContain("plan required");
    globalThis.fetch = originalFetch;
  });

  it("disables only the invite action and says why", async () => {
    const { default: TeamPage } = await import("@/app/(dashboard)/team/legacy-page");
    const html = renderToStaticMarkup(React.createElement(TeamPage));
    expect(html).toContain("Adding a seat needs the Scale plan.");
    expect(html).toContain("Send invite");
    globalThis.fetch = originalFetch;
  });
});

describe("every route family that reaches Team uses one component", () => {
  it("the legacy body mounts the exact screen and no plan gate", () => {
    const source = readFileSync("app/(dashboard)/team/legacy-page.tsx", "utf8");
    expect(source).toContain("TeamExact");
    expect(source).not.toContain("PlanGate");
    // Server-side role enforcement is untouched: every write still posts to the
    // admin-gated team routes.
    expect(source).toContain("/api/team/members");
    expect(source).toContain("/api/team/invites");
  });

  it("the /c/[businessId]/manage/team leaf mounts the same body", () => {
    const source = readFileSync("app/c/[businessId]/manage/team/page.tsx", "utf8");
    expect(source).toContain('@/app/(dashboard)/team/legacy-page');
    expect(source).toContain("requireBusinessPageContext");
  });
});
