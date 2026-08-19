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
    creativeId: "cre_1",
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
    });
    expect(model.alternates).toHaveLength(1);
    expect(model.alternates?.[0]).toMatchObject({
      text: "Served alternative",
      angle: "—",
      why: "—",
    });
    expect(model.draftAllLabel).toBe("Draft all 1 in Launchpad");
  });

  /**
   * These used to pass a `draftHref` and assert it reached every alternate and
   * the footer. That was the defect, not the contract: the href was a bare
   * `/…/meta/launchpad?providerAccountId=…` with no copy id, no alternate text,
   * no evidence window and no lineage on it, while the footnote told the
   * operator the line's evidence was attached.
   *
   * THE LAW, restated for what exists now: a "Draft" control may never be a
   * LINK. Preparing a draft is a POST the server has to answer — `POST
   * /api/meta/launchpad-handoff/copy` re-reads the served copy for the named
   * creative and window and refuses a line Meta never served — so an href here
   * could only ever be a claim with nothing behind it, whatever it pointed at.
   * The adapter's job is therefore to hand back `draftHref: null` always, and
   * to say in the footnote what a draft does and does not carry.
   */
  it("never gives an alternate an href, because drafting is a verified POST", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ text: "Real copy", variants: ["Real copy", "Served alternative"] }),
      draftingAvailable: true,
    });
    expect(model.alternates).toHaveLength(1);
    expect(model.alternates?.[0]?.draftHref).toBeNull();
    // And the footer stays destination-less even when single drafting works: a
    // handoff carries ONE line by construction, so "draft all" has no honest
    // implementation.
    expect(model.draftAllHref).toBeNull();
  });

  it("withholds the footer destination when nothing can be drafted", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row() });
    expect(model.alternates).toHaveLength(0);
    expect(model.draftAllHref).toBeNull();
    expect(model.draftAllLabel).toBe("Draft all in Launchpad");
  });

  it("describes the alternates as what they are, not as angle-shifted rewrites", () => {
    const model = buildCopyDetailDrawerExactViewModel({ row: row() });
    expect(model.alternatesNote).toBe("served with this creative · Meta-reported");
    expect(model.footnote).toContain("Nothing publishes from here.");
  });

  // The original sentence — "Drafting one opens a Launchpad draft with this
  // line's evidence attached." — was untrue on every render. It may not come
  // back in that shape even now that a payload exists, because the phrase
  // claims more than the payload delivers.
  it("never re-states the old evidence-attached claim", () => {
    for (const draftingAvailable of [false, true]) {
      const model = buildCopyDetailDrawerExactViewModel({
        row: row({ text: "Real copy", variants: ["Real copy", "Served alternative"] }),
        draftingAvailable,
      });
      expect(model.footnote).not.toContain("evidence attached");
    }
  });

  it("says drafting is unavailable when the host cannot prepare one", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ text: "Real copy", variants: ["Real copy", "Served alternative"] }),
    });
    expect(model.footnote).toContain("Drafting is unavailable");
  });

  // A creative id is what binds the line to a provider object. Without it the
  // handoff endpoint has nothing to name, so the control must not be offered
  // even when the host says drafting is otherwise possible.
  it("does not offer drafting for a row whose creative is unknown", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({
        creativeId: null,
        text: "Real copy",
        variants: ["Real copy", "Served alternative"],
      }),
      draftingAvailable: true,
    });
    expect(model.footnote).toContain("Drafting is unavailable");
  });

  // What the enabled footnote is allowed to say: the line travels with the
  // draft, and it does NOT become ad copy. The second half is the honest part —
  // no Launchpad payload field can hold it.
  it("states both what a draft carries and what Launchpad still cannot do with it", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ text: "Real copy", variants: ["Real copy", "Served alternative"] }),
      draftingAvailable: true,
    });
    expect(model.footnote).toContain("the server re-checks the line was served");
    expect(model.footnote).toContain("Launchpad has no copy field");
    expect(model.footnote).toContain("does not become ad copy");
    expect(model.footnote).toContain("Nothing publishes from here.");
  });

  // A refusal comes back from the server with its own sentence. The drawer
  // restates it rather than inventing one, so an operator whose draft was
  // refused is told what the server said.
  it("restates the server's own refusal sentence verbatim", () => {
    const model = buildCopyDetailDrawerExactViewModel({
      row: row({ text: "Real copy", variants: ["Real copy", "Served alternative"] }),
      draftingAvailable: true,
      draftStatusMessage:
        "That copy line is not in the current served universe for this account and window.",
    });
    expect(model.footnote).toContain(
      "That copy line is not in the current served universe for this account and window.",
    );
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
