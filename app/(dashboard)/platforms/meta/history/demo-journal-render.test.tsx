// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MetaHistoryAccount,
  MetaHistoryResponse,
} from "@/lib/meta/history-contract";
import { META_FAILURES } from "@/lib/meta/read-state-contract";

/**
 * D071 rendered proof: a demo journal must not read as a measured zero.
 *
 * The route already returned zero entries, `page.total: null` and a
 * `demo_journal_not_recorded` limitation, and the page still rendered
 * "0 shown · end of results", "No journal entries match" and "The selected
 * account and filters returned no keyed persisted rows" — with the one
 * truthful sentence hidden inside the collapsed "Identity and join limits"
 * disclosure.
 *
 * These tests mount the real view and assert what a reader sees without
 * clicking anything.
 */

const clientMock = vi.hoisted(() => ({
  fetchMetaHistoryAccounts: vi.fn(),
  fetchMetaHistoryPage: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  selectedBusinessId: "biz_demo",
  businesses: [{ id: "biz_demo", name: "Adsecute Demo" }],
}));

vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: clientMock.fetchMetaHistoryAccounts,
  fetchMetaHistoryPage: clientMock.fetchMetaHistoryPage,
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeMock),
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/tier-zero-freshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

const MetaHistoryView = (
  await import("@/app/(dashboard)/platforms/meta/history/history-view")
).default;

const DEMO_ACCOUNT: MetaHistoryAccount = {
  id: "act_210009998877",
  name: "UrbanTrail DTC",
  currency: "USD",
  timezone: "America/Los_Angeles",
};

// The UI must render whatever sentence the server sent, and the server sends
// the contracted one. Sourcing it here from the same dictionary is what makes
// this a drift test rather than a duplicate of the copy.
const DEMO_MESSAGE = META_FAILURES.demo_journal_not_recorded.message;

function response(
  overrides: Partial<MetaHistoryResponse> = {},
): MetaHistoryResponse {
  return {
    mode: "read_only",
    scope: {
      businessId: "biz_demo",
      providerAccountId: DEMO_ACCOUNT.id,
      providerAccountName: DEMO_ACCOUNT.name,
      currency: DEMO_ACCOUNT.currency,
      timezone: DEMO_ACCOUNT.timezone,
    },
    filters: {
      businessId: "biz_demo",
      providerAccountId: DEMO_ACCOUNT.id,
      kind: null,
      entity: null,
      label: null,
      outcome: null,
      from: null,
      to: null,
      q: null,
    },
    entries: [],
    page: { limit: 50, returned: 0, total: null, nextCursor: null },
    identityContract: {
      canonicalDecisionIdAvailable: false,
      grouping: "persisted_source_rows",
      limitation: "Demo workspaces record no provider-action journal.",
    },
    limitations: [
      { code: "demo_journal_not_recorded", message: DEMO_MESSAGE },
    ],
    ...overrides,
  } as MetaHistoryResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.fetchMetaHistoryAccounts.mockResolvedValue([DEMO_ACCOUNT]);
});
afterEach(cleanup);

async function mountDemoJournal(payload: MetaHistoryResponse) {
  clientMock.fetchMetaHistoryPage.mockResolvedValue(payload);
  render(<MetaHistoryView />);
  await waitFor(() =>
    expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalled(),
  );
  await waitFor(() =>
    expect(screen.getAllByText(/Demo journal is not recorded/i).length)
      .toBeGreaterThan(0),
  );
}

describe("a demo journal states why it is empty, without being opened", () => {
  it("shows the limitation outside any collapsed disclosure", async () => {
    await mountDemoJournal(response());

    // The notice must not be inside the <details> the reader has to open.
    const notice = document.querySelector('[role="status"]');
    expect(notice).toBeTruthy();
    expect(notice!.closest("details")).toBeNull();
    expect(notice!.textContent).toContain("Demo journal is not recorded");
    expect(notice!.textContent).toContain(DEMO_MESSAGE);

    // And the collapsed disclosure is still closed, proving no click happened.
    const details = document.querySelector("details");
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
  });

  it("drops the false-zero title and body", async () => {
    await mountDemoJournal(response());

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("No journal entries match");
    expect(text).not.toContain(
      "The selected account and filters returned no keyed persisted rows.",
    );
    expect(text).toContain("Demo journal is not recorded");
    expect(text).toContain(DEMO_MESSAGE);
  });

  it("never claims end of results while the total is unknown", async () => {
    await mountDemoJournal(response());

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("end of results");
    expect(text).toContain("total unavailable");
    expect(text).toContain("0 shown");
  });
});

describe("a live journal keeps its existing copy", () => {
  it("still says end of results with a known total and no demo limitation", async () => {
    clientMock.fetchMetaHistoryPage.mockResolvedValue(
      response({
        page: { limit: 50, returned: 0, total: 0, nextCursor: null },
        limitations: [],
      }),
    );
    render(<MetaHistoryView />);
    // Wait for the payload, not the empty state: the empty state renders from
    // `entries.length === 0` before the response lands, and the result count is
    // gated on `payload`.
    await waitFor(() =>
      expect(document.body.textContent ?? "").toContain("0 shown"),
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("No journal entries match");
    expect(text).toContain(
      "The selected account and filters returned no keyed persisted rows.",
    );
    expect(text).toContain("end of results");
    expect(text).not.toContain("Demo journal is not recorded");
    expect(text).not.toContain("total unavailable");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
