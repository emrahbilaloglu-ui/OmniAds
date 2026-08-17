// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * The wiring, end to end through the screen: `/api/klaviyo/flows` is the ONLY
 * source of lifecycle rows, and a `flows: null` answer — not connected, or the
 * first import has not landed — renders the design's row geometry with an
 * em-dash in every cell rather than the prototype's seeded flow names.
 */

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedBusinessId: null }),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: unknown) => unknown) =>
    selector({ domainsByBusinessId: {} }),
}));

const { KlaviyoClient } = await import("@/components/klaviyo/klaviyo-client");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const fetchMock = vi.fn();

function bodyCells() {
  const rows = Array.from(
    document.querySelectorAll("tbody tr"),
  ) as HTMLTableRowElement[];
  return rows.map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) =>
      (cell.textContent ?? "").trim(),
    ),
  );
}

describe("KlaviyoClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => cleanup());

  it("reads the design's five columns from /api/klaviyo/flows", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        state: "ready",
        flows: [
          {
            id: "flow_1",
            name: "Welcome Series",
            status: "Live",
            revenue: "$18,420",
            openRate: "54%",
            recipients: "12,480",
          },
        ],
      }),
    });

    render(<KlaviyoClient businessId={BUSINESS_ID} />);

    await waitFor(() => expect(screen.getByText("Welcome Series")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/klaviyo/flows?businessId=${BUSINESS_ID}`,
    );
    expect(bodyCells()).toEqual([
      ["Welcome Series", "Live", "$18,420", "54%", "12,480"],
    ]);
  });

  it("em-dashes every cell when the route serves flows:null", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ state: "not_connected", flows: null }),
    });

    render(<KlaviyoClient businessId={BUSINESS_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyCells()).toEqual([["—", "—", "—", "—", "—"]]);
    expect(screen.queryByText("Welcome Series")).toBeNull();
    expect(screen.queryByText("Abandoned Cart")).toBeNull();
  });

  it("em-dashes a served flow's unreported statistics without inventing zeros", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        state: "ready",
        flows: [
          {
            id: "flow_2",
            name: "Win-back 60d",
            status: "Draft",
            revenue: null,
            openRate: null,
            recipients: null,
          },
        ],
      }),
    });

    render(<KlaviyoClient businessId={BUSINESS_ID} />);

    await waitFor(() => expect(screen.getByText("Win-back 60d")).toBeTruthy());
    expect(bodyCells()).toEqual([["Win-back 60d", "Draft", "—", "—", "—"]]);
  });

  it("shows the em-dash row, not stale rows, when the read fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    render(<KlaviyoClient businessId={BUSINESS_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyCells()).toEqual([["—", "—", "—", "—", "—"]]);
  });

  it("does not call the route at all without a business", async () => {
    render(<KlaviyoClient businessId={null} />);
    await waitFor(() => expect(bodyCells()).toEqual([["—", "—", "—", "—", "—"]]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
