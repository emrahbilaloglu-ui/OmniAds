/**
 * The account-refresh verb contract.
 *
 * Refreshing a provider's account list performs a real provider call and a
 * snapshot write, so both providers' endpoints expose it on POST. Google's
 * route once accepted `refresh=1` on the GET and silently ignored it; when
 * that was corrected to a 405 pointing at POST, this client was left issuing
 * the GET. Nothing caught it — this file had no tests — and the result was
 * that Google's "Refresh" button could not clear the staleness that blocks
 * account assignment.
 *
 * These tests pin the verb for BOTH providers so the pair cannot drift again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmProviderAccountSnapshot } from "@/lib/provider-account-client";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function mockFetchOk(body: unknown = { data: [] }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("warmProviderAccountSnapshot refreshes over POST", () => {
  for (const provider of ["meta", "google"] as const) {
    it(`uses POST for ${provider}, never a GET carrying refresh=1`, async () => {
      const fetchMock = mockFetchOk();

      await warmProviderAccountSnapshot(provider, BUSINESS_ID);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      // A refresh smuggled onto the read path is exactly the bug this pins:
      // the server answers it with 405, so the snapshot never refreshes.
      expect(url).not.toContain("refresh=1");
      expect(url).toContain(`businessId=${BUSINESS_ID}`);
    });

    it(`surfaces the server's own message when ${provider} refresh is refused`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 405,
          json: async () => ({ message: "Refresh over POST." }),
        }),
      );

      await expect(warmProviderAccountSnapshot(provider, BUSINESS_ID)).rejects.toThrow(
        "Refresh over POST.",
      );
    });
  }

  it("returns the accounts the refresh wrote, with assignment flags preserved", async () => {
    mockFetchOk({
      data: [
        { id: "act_1", name: "Main", assigned: true },
        { id: "act_2", name: "Spare", assigned: false },
      ],
    });

    const snapshot = await warmProviderAccountSnapshot("google", BUSINESS_ID);

    expect(snapshot.accounts.map((account) => account.id)).toEqual(["act_1", "act_2"]);
    expect(snapshot.assignedAccountIds).toEqual(["act_1"]);
  });
});
