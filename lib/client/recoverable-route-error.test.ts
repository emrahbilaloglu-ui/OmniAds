import { describe, expect, it } from "vitest";
import { isRecoverableRouteLoadError, routeErrorMessage } from "@/lib/client/recoverable-route-error";

describe("recoverable route errors", () => {
  it("detects stale deployment chunk load failures", () => {
    expect(isRecoverableRouteLoadError(new Error("ChunkLoadError: Loading chunk 123 failed."))).toBe(true);
    expect(isRecoverableRouteLoadError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isRecoverableRouteLoadError(new Error("fetch server response failed while loading RSC payload"))).toBe(true);
  });

  it("does not classify normal API failures as recoverable route loads", () => {
    expect(isRecoverableRouteLoadError(new Error("Request failed (500)"))).toBe(false);
    expect(isRecoverableRouteLoadError(new Error("Could not load creatives"))).toBe(false);
  });

  it("extracts error-like object messages", () => {
    expect(routeErrorMessage({ name: "ChunkLoadError", message: "Loading chunk 9 failed" })).toContain(
      "Loading chunk 9 failed",
    );
  });
});
