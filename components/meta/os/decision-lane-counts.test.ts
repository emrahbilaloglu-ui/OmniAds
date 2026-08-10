import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import {
  presentationLaneCount,
  resolveAvailableDecisionLane,
} from "@/components/meta/os/DecisionsOsView";

const presentation = {
  structure: { actCount: 3, blockedCount: 1, monitorCount: 7 },
  ads: { actCount: 5, blockedCount: 0, monitorCount: 12 },
} as never;

/**
 * The lane chips previously showed 0 whenever there was no server presentation,
 * which is what a still-loading or failed workspace looks like. "Act Now 0"
 * reads as "nothing to act on today" — the most expensive thing this surface
 * could get wrong during morning triage.
 */
describe("decision lane counts distinguish unknown from zero", () => {
  it("reports an unknown count while there is no presentation", () => {
    expect(presentationLaneCount(null, "ads", "act")).toBeNull();
    expect(presentationLaneCount(undefined, "structure", "act")).toBeNull();
  });

  it("never reports unknown as zero", () => {
    expect(presentationLaneCount(null, "ads", "act")).not.toBe(0);
  });

  it("reports a genuine zero as zero once the server has answered", () => {
    expect(presentationLaneCount(presentation, "ads", "blocked")).toBe(0);
  });

  it("reports real counts per layer and lane", () => {
    expect(presentationLaneCount(presentation, "ads", "act")).toBe(5);
    expect(presentationLaneCount(presentation, "ads", "monitor")).toBe(12);
    expect(presentationLaneCount(presentation, "structure", "act")).toBe(3);
    expect(presentationLaneCount(presentation, "structure", "blocked")).toBe(1);
  });

  it("keeps lane selection stable when counts are unknown", () => {
    expect(resolveAvailableDecisionLane(null, "ads", "act")).toBe("act");
  });

  it("still moves to a lane that has work once counts are known", () => {
    expect(resolveAvailableDecisionLane(presentation, "ads", "blocked")).toBe("act");
  });
});
