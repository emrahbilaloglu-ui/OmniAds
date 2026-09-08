import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountScopeControl } from "@/components/layout/v2/account-scope-control";
import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";

const state = vi.hoisted(() => ({ pathname: "/c/biz_1/creative/performance" }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const CATALOGS: ProviderScopeCatalog[] = [
  {
    provider: "meta",
    accounts: [
      { id: "act_1", label: "Grandmix", currency: "TRY", timezone: "Europe/Istanbul" },
      { id: "act_2", label: "Vitahome", currency: "TRY", timezone: "Europe/Istanbul" },
    ],
  },
];

function envelope(
  provider: WorkspaceContextEnvelope["provider"],
): WorkspaceContextEnvelope {
  return {
    actor: {
      userId: "u1",
      name: "Op",
      language: "en",
      membershipRole: "admin",
      reviewerReadOnly: false,
      demo: false,
    },
    mode: "client",
    business: {
      id: "biz_1",
      name: "Biz",
      configuredCurrency: "TRY",
      businessTimezone: "Europe/Istanbul",
    },
    provider,
    evidence: {
      windowLabel: null,
      snapshotAt: null,
      sourceUpdatedAt: null,
      freshness: "unknown",
    },
    proof: { currency: "configured-only", timezone: "unknown" },
    rollout: { zeroBaseEnabled: true, mutationUiEnabled: false },
  };
}

function render(
  provider: WorkspaceContextEnvelope["provider"],
  catalogs: ProviderScopeCatalog[] = CATALOGS,
) {
  return renderToStaticMarkup(
    <WorkspaceContextProvider value={envelope(provider)}>
      <AccountScopeControl providerCatalogs={catalogs} />
    </WorkspaceContextProvider>,
  );
}

/**
 * D6's 0 / 1 / N, rendered.
 *
 * Account Intelligence and every Creative Studio tab had no account control at
 * all, so a business with several assigned Meta accounts could reach a surface
 * that refused for want of a selection and had no way to make one — the
 * `account_required` dead-end.
 */
describe("AccountScopeControl", () => {
  it("renders nothing on a surface with no provider family", () => {
    // Overview, Reports, Settings. A disabled control there would imply there
    // is an account question to answer.
    expect(render(null)).toBe("");
  });

  it("0 assigned: points at assignment, not at selection", () => {
    const html = render(
      {
        id: "meta",
        selectedAccountIds: [],
        assignedAccountIds: [],
        selectedAccountLabel: null,
        mode: "none",
      },
      [{ provider: "meta", accounts: [] }],
    );
    expect(html).toContain('data-account-scope-state="none"');
    expect(html).toContain("No Meta ad account");
  });

  it("1 assigned: names the account instead of offering a choice", () => {
    const html = render(
      {
        id: "meta",
        selectedAccountIds: ["act_1"],
        assignedAccountIds: ["act_1"],
        selectedAccountLabel: "Grandmix",
        mode: "single",
      },
      [{ provider: "meta", accounts: [CATALOGS[0]!.accounts[0]!] }],
    );
    expect(html).toContain('data-account-scope-state="single"');
    expect(html).toContain("Grandmix");
    // A one-option dropdown reads as a decision the operator still owes.
    expect(html).not.toContain("Select a ");
  });

  it("N assigned, none chosen: asks for a choice and picks nothing", () => {
    const html = render({
      id: "meta",
      selectedAccountIds: [],
      assignedAccountIds: ["act_1", "act_2"],
      selectedAccountLabel: null,
      mode: "portfolio",
    });
    expect(html).toContain('data-account-scope-state="required"');
    expect(html).toContain("Select a Meta ad account");
    // Never auto-selects the first: a figure attributed to an account nobody
    // chose is worse than a surface that refuses.
    expect(html).toContain('data-account-id=""');
  });

  it("N assigned, one chosen: names it and stays changeable", () => {
    const html = render({
      id: "meta",
      selectedAccountIds: ["act_2"],
      assignedAccountIds: ["act_1", "act_2"],
      selectedAccountLabel: "Vitahome",
      mode: "portfolio",
    });
    expect(html).toContain('data-account-scope-state="selected"');
    expect(html).toContain('data-account-id="act_2"');
    expect(html).toContain("Vitahome");
  });

  it("renders account choices by buyer label without visible provider ids", () => {
    const html = render({
      id: "meta",
      selectedAccountIds: ["act_1"],
      assignedAccountIds: ["act_1", "act_2"],
      selectedAccountLabel: "Grandmix",
      mode: "portfolio",
    });
    const visibleText = html.replace(/<[^>]+>/g, " ");

    expect(visibleText).toContain("Grandmix");
    expect(visibleText).toContain("Vitahome");
    expect(visibleText).not.toContain("act_1");
    expect(visibleText).not.toContain("act_2");
    expect(visibleText).not.toContain("TRY");
    expect(visibleText).not.toContain("Europe/Istanbul");
  });

  it("renders nothing when the provider family has no catalog entry", () => {
    // Reading a catalog that was never served must not invent an empty one that
    // then claims "no accounts assigned".
    const html = render(
      {
        id: "meta",
        selectedAccountIds: [],
        assignedAccountIds: [],
        selectedAccountLabel: null,
        mode: "none",
      },
      [{ provider: "google", accounts: [] }],
    );
    expect(html).toContain('data-account-scope-state="none"');
  });
});
