import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `fetchKlaviyoFlows` and the page it must not stop at.
 *
 * Klaviyo paginates `/api/flows/` with a JSON:API `links.next` cursor. Reading
 * only the first page is not a smaller import — it is a WRONG one, because
 * `replaceKlaviyoFlowMetrics` deletes every stored flow the import did not
 * carry. A half-read collection therefore has to either become a whole one or
 * fail loudly; it must never be handed to the writer as if it were complete.
 */

const { fetchKlaviyoFlows, KLAVIYO_FLOW_PAGE_LIMIT, KlaviyoApiError } =
  await import("@/lib/klaviyo/api");

const FLOWS_URL = "https://a.klaviyo.com/api/flows/";

function flowPage(
  ids: string[],
  next: string | null,
): { ok: true; status: number; json: () => Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: ids.map((id) => ({
        type: "flow",
        id,
        attributes: { name: `Flow ${id}`, status: "live", archived: false },
      })),
      links: { self: FLOWS_URL, next },
    }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchKlaviyoFlows", () => {
  it("follows links.next so page two's flows are imported, not deleted", async () => {
    const secondPage = `${FLOWS_URL}?page%5Bcursor%5D=cursor2`;
    fetchMock
      .mockResolvedValueOnce(flowPage(["flow_1", "flow_2"], secondPage))
      .mockResolvedValueOnce(flowPage(["flow_3", "flow_4"], null));

    const flows = await fetchKlaviyoFlows("token");

    expect(flows.map((flow) => flow.id)).toEqual([
      "flow_1",
      "flow_2",
      "flow_3",
      "flow_4",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(secondPage);
  });

  it("carries the bearer credential and revision onto every following page", async () => {
    const secondPage = `${FLOWS_URL}?page%5Bcursor%5D=cursor2`;
    fetchMock
      .mockResolvedValueOnce(flowPage(["flow_1"], secondPage))
      .mockResolvedValueOnce(flowPage(["flow_2"], null));

    await fetchKlaviyoFlows("token");

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers.revision).toBeTruthy();
  });

  it("fails loudly instead of returning a truncated collection when the cursor never ends", async () => {
    // A `links.next` that always points forward. Bounded, and the bound is a
    // failure — returning what has been read so far would let the writer delete
    // every flow it has not seen.
    fetchMock.mockImplementation(async () =>
      flowPage(["flow_x"], `${FLOWS_URL}?page%5Bcursor%5D=endless`),
    );

    await expect(fetchKlaviyoFlows("token")).rejects.toBeInstanceOf(
      KlaviyoApiError,
    );
    await expect(fetchKlaviyoFlows("token")).rejects.toMatchObject({
      code: "klaviyo_flow_pagination_unbounded",
    });
    expect(fetchMock.mock.calls.length).toBe(KLAVIYO_FLOW_PAGE_LIMIT * 2);
  });

  it("refuses to send the access token to a next link off Klaviyo's own host", async () => {
    fetchMock.mockResolvedValueOnce(
      flowPage(["flow_1"], "https://evil.example.com/api/flows/?page=2"),
    );

    await expect(fetchKlaviyoFlows("token")).rejects.toMatchObject({
      code: "klaviyo_flow_pagination_invalid_link",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at a page that reports no next link", async () => {
    fetchMock.mockResolvedValueOnce(flowPage(["flow_1"], null));

    const flows = await fetchKlaviyoFlows("token");
    expect(flows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a mid-pagination failure rather than returning page one", async () => {
    fetchMock
      .mockResolvedValueOnce(
        flowPage(["flow_1"], `${FLOWS_URL}?page%5Bcursor%5D=cursor2`),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

    await expect(fetchKlaviyoFlows("token")).rejects.toBeInstanceOf(
      KlaviyoApiError,
    );
  });
});
