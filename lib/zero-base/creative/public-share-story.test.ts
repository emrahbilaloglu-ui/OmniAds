import { describe, expect, it } from "vitest";
import { buildCreativeStory } from "@/lib/zero-base/creative/public-share-story";

function creative(overrides: Record<string, unknown> = {}) {
  return {
    format: "video" as const,
    thumbstop: 38,
    ctrAll: 1.63,
    video25: 65,
    video50: 42,
    video75: 25,
    video100: 12,
    ...overrides,
  };
}

describe("buildCreativeStory — honesty invariants", () => {
  it("never claims a band with no served benchmark", () => {
    const story = buildCreativeStory(creative(), undefined);
    expect(story).not.toBeNull();
    for (const stage of story!.stages) {
      expect(stage.band).toBeNull();
      expect(stage.benchmarkPercent).toBeNull();
    }
    // No banded stage means nothing to verdict on — not a fabricated read.
    expect(story!.verdict).toBeNull();
    expect(story!.tone).toBe("unclear");
    expect(story!.suggestion).toBeNull();
  });

  it("bands Strong only at >=15% above a real benchmark", () => {
    const story = buildCreativeStory(creative({ thumbstop: 40 }), { thumbstop: 30 });
    const hook = story!.stages.find((stage) => stage.key === "hook")!;
    expect(hook.band).toBe("Strong");
  });

  it("bands Weak below 85% of a real benchmark", () => {
    const story = buildCreativeStory(creative({ thumbstop: 20 }), { thumbstop: 28 });
    const hook = story!.stages.find((stage) => stage.key === "hook")!;
    expect(hook.band).toBe("Weak");
  });

  it("bands Typical inside the 85%-115% band", () => {
    const story = buildCreativeStory(creative({ thumbstop: 28 }), { thumbstop: 28 });
    const hook = story!.stages.find((stage) => stage.key === "hook")!;
    expect(hook.band).toBe("Typical");
  });

  it("never fabricates a hold stage for a static image — the field does not exist on the model", () => {
    const story = buildCreativeStory(
      creative({ format: "image", thumbstop: null, video25: null, video50: null, video75: null, video100: null }),
      { thumbstop: 28, ctrAll: 1.3 },
    );
    expect(story!.stages.map((stage) => stage.key)).toEqual(["click"]);
  });

  it("gives a catalog a hook stage but never a hold stage", () => {
    const story = buildCreativeStory(
      creative({ format: "catalog", video25: null, video50: null, video75: null, video100: null }),
      { thumbstop: 28, ctrAll: 1.3 },
    );
    expect(story!.stages.map((stage) => stage.key)).toEqual(["hook", "click"]);
  });

  it("computes the drop-off chart only when the full quartile ladder is served", () => {
    const complete = buildCreativeStory(creative(), undefined);
    expect(complete!.dropOff).not.toBeNull();
    expect(complete!.dropOff).toHaveLength(5);

    const partial = buildCreativeStory(creative({ video100: null }), undefined);
    expect(partial!.dropOff).toBeNull();
    expect(partial!.dropOffCaption).toBeNull();
  });

  it("names the segment with the single biggest measured loss", () => {
    // start 100 -> 65 -> 42 -> 25 -> 12: drops are 35, 23, 17, 13 — biggest is the opening quarter.
    const story = buildCreativeStory(creative(), undefined);
    expect(story!.dropOffCaption).toContain("the opening quarter");
    expect(story!.dropOffCaption).toContain("35 of 100");
  });

  it("returns null entirely when a creative carries no video, thumbstop or CTR signal", () => {
    const story = buildCreativeStory(
      creative({ format: "image", thumbstop: null, ctrAll: null, video25: null, video50: null, video75: null, video100: null }),
      { thumbstop: 28, ctrAll: 1.3 },
    );
    expect(story).toBeNull();
  });

  it("keeps a measured zero as a real zero, not an absence", () => {
    const story = buildCreativeStory(creative({ ctrAll: 0 }), { ctrAll: 1.3 });
    const click = story!.stages.find((stage) => stage.key === "click")!;
    expect(click.valueLabel).toBe("0.00%");
    expect(click.band).toBe("Weak");
  });

  it("suggests a fix only alongside a real verdict", () => {
    const noBenchmark = buildCreativeStory(creative(), undefined);
    expect(noBenchmark!.verdict).toBeNull();
    expect(noBenchmark!.suggestion).toBeNull();

    const healthy = buildCreativeStory(creative({ thumbstop: 40, video50: 45, ctrAll: 2.0 }), {
      thumbstop: 28,
      videoCompletion50: 30,
      ctrAll: 1.34,
    });
    expect(healthy!.verdict).not.toBeNull();
  });
});
