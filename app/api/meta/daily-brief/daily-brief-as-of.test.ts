/**
 * A date the caller can name is a date the route has to check.
 *
 * `asOf` went from the query string straight into the builder's date
 * arithmetic. `dayBefore` does `new Date(`${asOf}T00:00:00.000Z`)` and then
 * `.toISOString()`, which throws `RangeError: Invalid time value` on an
 * unparseable value — so `?asOf=abc` produced a 500 and no brief at all, not a
 * degraded one. A well-formed day the calendar does not contain was worse than
 * that: `2026-02-30` parses to 2026-03-02, so the brief silently answered
 * about a different day than the one it was asked about and stamped itself
 * with the requested string.
 *
 * Refusing is the fix rather than defaulting to today: this brief's whole
 * failure history is sections quietly answering about a day nobody asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/meta/daily-brief", () => ({
  buildMetaDailyBrief: vi.fn(async (input: { asOf?: string }) => ({
    contract: "meta.daily-brief.v1",
    asOf: input.asOf ?? "today",
  })),
}));
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(async () => ({ session: {}, membership: {} })),
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(async () => ({ account_ids: ["act_1"] })),
}));

import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";
import { GET } from "@/app/api/meta/daily-brief/route";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function request(asOf?: string) {
  const url = new URL("https://app.test/api/meta/daily-brief");
  url.searchParams.set("businessId", BUSINESS);
  if (asOf !== undefined) url.searchParams.set("asOf", asOf);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("asOf is a real calendar day or the request is refused", () => {
  it.each([
    ["abc", "not a date at all"],
    ["2026-13-45", "well-formed and unparseable"],
    ["2026-02-30", "well-formed and not on the calendar"],
    ["2026-9-5", "not the zero-padded form the builder parses"],
  ])("refuses %s (%s)", async (asOf) => {
    const response = await GET(request(asOf));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false, error: { code: "as_of_invalid" },
    });
    // The point is that the builder never sees it. Reaching it with `abc`
    // threw out of the route as a 500; reaching it with `2026-02-30` produced
    // a brief about 2026-03-02 labelled 2026-02-30.
    expect(vi.mocked(buildMetaDailyBrief)).not.toHaveBeenCalled();
  });

  it("passes a real day through unchanged", async () => {
    const response = await GET(request("2026-09-01"));

    expect(response.status).toBe(200);
    expect(vi.mocked(buildMetaDailyBrief)).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: "2026-09-01" }),
    );
  });

  it("leaves the day to the builder when the caller names none", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(vi.mocked(buildMetaDailyBrief)).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: undefined }),
    );
  });
});
