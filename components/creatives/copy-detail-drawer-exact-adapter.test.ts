import { describe, expect, it } from "vitest";

import {
  buildCopyDetailDrawerExactViewModel,
  copyAngleTone,
  copyRoasTone,
  type CopyDetailDrawerExactRow,
} from "./copy-detail-drawer-exact-adapter";

function row(overrides: Partial<CopyDetailDrawerExactRow> = {}): CopyDetailDrawerExactRow {
  return {
    id: "t1",
    text: "I replaced three bags with this one",
    assetType: "primary_text",
    angle: null,
    seeMore: null,
    ctr: 1.72,
    engagement: null,
    roas: 5.2,
    variants: [],
    ...overrides,
  };
}

describe("buildCopyDetailDrawerExactViewModel", () => {
  it("prints the asset type and the character count in the eyebrow", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row() });
    expect(model.kind).toBe("Primary Text · 35 chars");
  });

  it("em-dashes the eyebrow's asset type when the provider does not label it", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ assetType: null, text: "abc" }),
    });
    expect(model.kind).toBe("— · 3 chars");
  });

  it("binds the angle chip to the served angle, not the asset type", () => {
    expect(buildCopyDetailDrawerExactViewModel({ row: row() }).angle).toBe("—");
    const tagged = buildCopyDetailDrawerExactViewModel({
      row: row({ angle: "Social proof" }),
    });
    expect(tagged.angle).toBe("Social proof");
    expect(tagged.angleTone).toBe("info");
  });

  it("renders the design's four tiles in order with their benchmark sub-lines", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row(),
      peers: [row(), row({ id: "t2", ctr: 1.34 }), row({ id: "t3", ctr: 1.1 })],
      targetRoas: 3.8,
    });
    expect(model.stats?.map((stat) => stat.label)).toEqual([
      "See more",
      "CTR",
      "Engage",
      "ROAS",
    ]);
    expect(model.stats?.[1]).toMatchObject({ value: "1.72%", sub: "median 1.34%" });
    expect(model.stats?.[3]).toMatchObject({ value: "5.2", sub: "target 3.80" });
  });

  it("em-dashes See more and Engage because the copies response has no such field", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row(), peers: [row()] });
    expect(model.stats?.[0]).toMatchObject({ value: "—", sub: "—" });
    expect(model.stats?.[2]).toMatchObject({ value: "—", sub: "—" });
  });

  it("keeps the design's headline note on lines that cannot truncate", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ assetType: "headline" }),
    });
    expect(model.stats?.[0]?.sub).toBe("headlines don’t truncate");
  });

  it("tones the ROAS tile with the copies table's own band", () => {
    expect(
      buildCopyDetailDrawerExactViewModel({ row: row({ roas: 5.2 }) }).stats?.[3]?.tone,
    ).toBe("positive");
    expect(
      buildCopyDetailDrawerExactViewModel({ row: row({ roas: 2.3 }) }).stats?.[3]?.tone,
    ).toBe("negative");
    expect(buildCopyDetailDrawerExactViewModel({ row: row({ roas: 2.7 }) }).edgeTone).toBe(
      "warning",
    );
  });

  it("shows the target as an em dash when no target is served", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row(), targetRoas: null });
    expect(model.stats?.[3]?.sub).toBe("target —");
  });

  it("leaves the Read card unserved rather than guessing a diagnosis", () => {
    expect(buildCopyDetailDrawerExactViewModel({ row: row() }).read).toBe("—");
  });

  it("lists the served variants as alternates, dropping the line itself and duplicates", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({
        text: "Real copy",
        variants: ["Real copy", "Served alternative", "Served alternative", "  "],
      }),
      draftHref: "/platforms/meta/launchpad",
    });
    expect(model.alternates).toHaveLength(1);
    expect(model.alternates?.[0]).toMatchObject({
      text: "Served alternative",
      angle: "—",
      why: "—",
      draftHref: "/platforms/meta/launchpad",
    });
    expect(model.draftAllLabel).toBe("Draft all 1 in Launchpad");
  });

  it("withholds the footer destination when nothing can be drafted", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row(),
      draftHref: "/platforms/meta/launchpad",
    });
    expect(model.alternates).toHaveLength(0);
    expect(model.draftAllHref).toBeNull();
    expect(model.draftAllLabel).toBe("Draft all in Launchpad");
  });

  it("describes the alternates as what they are, not as angle-shifted rewrites", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row() });
    expect(model.alternatesNote).toBe("served with this creative · Meta-reported");
    expect(model.footnote).toContain("Nothing publishes from here.");
  });
});

describe("copy tone helpers", () => {
  it("bands ROAS the way the copies table does", () => {
    expect(copyRoasTone(3.8)).toBe("positive");
    expect(copyRoasTone(3.2)).toBe("neutral");
    expect(copyRoasTone(2.7)).toBe("warning");
    expect(copyRoasTone(2.4)).toBe("negative");
    expect(copyRoasTone(null)).toBe("neutral");
  });

  it("maps served angle names onto the design's angle palette", () => {
    expect(copyAngleTone("UGC voice")).toBe("positive");
    expect(copyAngleTone("Social proof")).toBe("info");
    expect(copyAngleTone("Problem → solution")).toBe("automation");
    expect(copyAngleTone("Discount & urgency")).toBe("negative");
    expect(copyAngleTone(null)).toBe("neutral");
  });
});
