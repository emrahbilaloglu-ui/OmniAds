import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/healthz/route";

vi.mock("@/lib/build-runtime", () => ({
  getCurrentRuntimeBuildId: vi.fn(() => "build-1"),
}));

describe("GET /api/healthz", () => {
  it("returns lightweight runtime liveness without control-plane dependencies", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(payload).toEqual({
      ok: true,
      buildId: "build-1",
      nodeEnv: process.env.NODE_ENV ?? "unknown",
    });
  });
});
