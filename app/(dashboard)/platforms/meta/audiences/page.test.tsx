import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MetaAudiencesPage from "./legacy-page";

const state = {
  selectedBusinessId: "biz_1" as string | null,
  workspaceResolved: true,
};
let pathname = "/platforms/meta/audiences";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams("providerAccountId=act_1"),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

describe("MetaAudiencesPage", () => {
  beforeEach(() => {
    state.selectedBusinessId = "biz_1";
    state.workspaceResolved = true;
    pathname = "/platforms/meta/audiences";
  });

  it("keeps the canonical audience geometry while withholding unsupported metrics", () => {
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-creative-studio-exact="true"');
    expect(html).toContain('data-creative-studio-tab="audiences"');
    expect(html.match(/data-audience-summary=/g)).toHaveLength(4);
    expect(html.match(/data-audience-breakdown=/g)).toHaveLength(5);
    expect(html).toContain("Creative × audience matrix");
    expect(html).toContain(
      "Audience-level creative evidence is unavailable for this assigned Meta account.",
    );
    expect(html).not.toContain("No live audience score");
    expect(html).not.toContain("buyerAction");
  });

  it("uses the server-authorized scope and keeps every tab in the scoped route family", () => {
    pathname = "/c/biz_authorized/creative/audiences";
    const html = renderToStaticMarkup(
      <MetaAudiencesPage businessId="biz_authorized" providerAccountId="act_authorized" />,
    );

    expect(html).toContain('/c/biz_authorized/creative/performance?');
    expect(html).toContain('/c/biz_authorized/creative/audiences?');
    expect(html).toContain("providerAccountId=act_authorized");
    expect(html).not.toContain("biz_1");
    expect(html).not.toContain("act_1");
  });

  it("shows the account-required state without inventing a default account", () => {
    const html = renderToStaticMarkup(
      <MetaAudiencesPage businessId="biz_authorized" providerAccountId={null} />,
    );

    expect(html).toContain('data-audiences-state="account_required"');
    expect(html).toContain("Select one assigned Meta ad account.");
    expect(html).not.toContain("USD");
    expect(html).not.toContain("$0");
  });
});
