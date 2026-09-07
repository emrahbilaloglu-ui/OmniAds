// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCreatives: vi.fn(),
  fetchDecisions: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "IwaStore", currency: "USD" }],
    }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: mocks.fetchDecisions,
  fetchMetaCreatives: mocks.fetchCreatives,
  mapApiRowToUiRow: (row: unknown) => row,
}));

const MetaLaunchpadPage = (await import("./legacy-page")).default;

const DRAFT = {
  id: "draft_1",
  businessId: "biz_1",
  providerAccountId: "act_1",
  name: "EU Prospecting v2",
  payload: { mode: "add_to_existing", copyMode: "reuse_creative" },
  status: "draft",
  updatedAt: "2026-08-11T14:12:00.000Z",
};

function json(body: unknown) {
  return { ok: true, json: async () => body };
}

/**
 * The route answers a batch with `{ok, results:[{key, ok, blockers, warnings}]}`.
 * One page of drafts is one request: billing and the pixel list belong to the
 * account, so asking per row cost a Graph read per draft.
 */
function batchReply(
  verdict: { ok: boolean; blockers: unknown[]; warnings: unknown[] },
  keys: string[],
) {
  return {
    ok: true,
    results: keys.map((key) => ({ key, ...verdict })),
  };
}

function stubEndpoints(validate: {
  ok: boolean;
  blockers: unknown[];
  warnings: unknown[];
}) {
  const validateCalls: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith("/api/launchpad/meta/workspace"))
      return json({
        ok: true,
        accounts: [{ id: "act_1", name: "Account 1", currency: "USD" }],
        sections: Object.fromEntries(
          [
            "accounts",
            "templates",
            "recentTemplates",
            "drafts",
            "intents",
            "recentAdActions",
            "targetCpa",
          ].map((section) => [
            section,
            { status: "complete", errorCode: null, observedAt: "t" },
          ]),
        ),
        capability: {},
        templates: [],
        recentTemplates: [],
        drafts: [DRAFT],
        intents: [],
        recentAdActions: [],
        targetCpa: 40,
      });
    if (url.startsWith("/api/launchpad/meta/validate")) {
      const body = JSON.parse(init?.body ?? "null");
      validateCalls.push(body);
      const keys = (body?.payloads ?? []).map(
        (entry: { key?: string }) => entry.key ?? "",
      );
      return json(batchReply(validate, keys));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return validateCalls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchCreatives.mockResolvedValue([]);
  mocks.fetchDecisions.mockResolvedValue({ decisions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Launchpad drafts validation is the server's verdict", () => {
  it("validates each listed draft with its own persisted payload", async () => {
    const validateCalls = stubEndpoints({
      ok: false,
      blockers: [{ code: "pixel_required" }, { code: "budget_below_minimum" }],
      warnings: [],
    });

    render(
      <MetaLaunchpadPage
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
      />,
    );

    const row = await screen.findByTestId("launchpad-draft-row");
    await waitFor(() => {
      expect(within(row).getByText("2 issues")).toBeTruthy();
    });
    // One request for the page, carrying each draft's own persisted payload
    // keyed by its id — not one request per row.
    expect(validateCalls).toEqual([
      {
        businessId: "biz_1",
        providerAccountId: "act_1",
        payloads: [{ key: DRAFT.id, payload: DRAFT.payload }],
      },
    ]);
  });

  it("renders the clean verdict as Ready", async () => {
    stubEndpoints({ ok: true, blockers: [], warnings: [] });

    render(
      <MetaLaunchpadPage
        businessId="biz_1"
        businessName="IwaStore"
        providerAccountId="act_1"
      />,
    );

    const row = await screen.findByTestId("launchpad-draft-row");
    await waitFor(() => {
      expect(within(row).getByText("Ready")).toBeTruthy();
    });
  });
});
