// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitScreenView } from "@/lib/zero-base/instrumentation-client";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

function mockFetch(...responses: Array<{ ok: boolean; status: number } | "throw">) {
  const fn = vi.fn();
  for (const response of responses) {
    if (response === "throw") fn.mockRejectedValueOnce(new Error("offline"));
    else fn.mockResolvedValueOnce(response);
  }
  fn.mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("emitScreenView", () => {
  it("sends the v2 discriminator and a UUID event id", async () => {
    const fetchMock = mockFetch({ ok: true, status: 202 });
    await emitScreenView({ surface: "pub_home" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contract).toBe("zero-base.v2");
    expect(body.event).toBe("screen_view");
    expect(body.eventId).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("never sends actor_role or width_bucket — the server derives both", async () => {
    const fetchMock = mockFetch({ ok: true, status: 202 });
    await emitScreenView({ surface: "pub_home" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("actorRole");
    expect(body).not.toHaveProperty("widthBucket");
    expect(typeof body.width).toBe("number");
  });

  it("retries exactly once when offline, then drops", async () => {
    const fetchMock = mockFetch("throw", "throw");
    await emitScreenView({ surface: "pub_home" });
    // Two attempts total, not a queue that keeps growing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the same event id on the retry so it cannot double-count", async () => {
    const fetchMock = mockFetch("throw", { ok: true, status: 202 });
    await emitScreenView({ surface: "pub_home" });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.eventId).toBe(first.eventId);
  });

  it("does not retry a 4xx, which retrying cannot fix", async () => {
    const fetchMock = mockFetch({ ok: false, status: 400 });
    await emitScreenView({ surface: "pub_home" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an undeclared surface", async () => {
    const fetchMock = mockFetch({ ok: true, status: 202 });
    await emitScreenView({ surface: "not_a_surface" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, whatever fetch does", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    await expect(emitScreenView({ surface: "pub_home" })).resolves.toBeUndefined();
  });
});
