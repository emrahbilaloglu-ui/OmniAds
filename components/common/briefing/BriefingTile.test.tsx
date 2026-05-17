import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BriefingTile,
  deriveTileFormat,
  deriveTileShape,
} from "@/components/common/briefing/BriefingTile";

describe("BriefingTile", () => {
  it("renders the tile shell with thumb, chips, body, and metric grid", () => {
    const html = renderToStaticMarkup(
      <BriefingTile
        laneVariant="action"
        shape="portrait"
        format="VID"
        durationLabel="15s"
        chips={<span data-testid="chip">Promote</span>}
        name="UGC-Sarah-V2"
        meta="BFCM-Test-A · Adset 04 · 9d"
        why={<>ROAS strong</>}
        metrics={[
          { key: "roas", label: "ROAS", value: "2.74", tone: "good" },
          { key: "spend", label: "Spend", value: "$1.2k" },
          { key: "purch", label: "Purch", value: "11" },
        ]}
        primaryAction={<button type="button">Promote to main</button>}
      />,
    );

    expect(html).toContain('data-tile-variant="action"');
    expect(html).toContain("VID · 15s");
    expect(html).toContain("UGC-Sarah-V2");
    expect(html).toContain("BFCM-Test-A");
    expect(html).toContain("ROAS strong");
    expect(html).toContain("$1.2k");
    expect(html).toContain("Promote to main");
    expect(html).toContain("9:16");
    expect(html).toContain("width:90px");
  });

  it("uses a 1:1 ratio tag for square shapes", () => {
    const html = renderToStaticMarkup(
      <BriefingTile
        laneVariant="watch"
        shape="square"
        format="IMG"
        chips={null}
        name="Static-Promo-B"
        meta="Adset 03 · 17d"
        why="At target."
        metrics={[{ key: "roas", label: "ROAS", value: "1.1" }]}
      />,
    );

    expect(html).toContain("1:1");
    expect(html).toContain("width:140px");
  });

  it("toggles the corner-check aria-checked state when selected", () => {
    const off = renderToStaticMarkup(
      <BriefingTile
        laneVariant="action"
        shape="square"
        format="IMG"
        chips={null}
        name="x"
        meta="y"
        why="z"
        metrics={[]}
      />,
    );
    const on = renderToStaticMarkup(
      <BriefingTile
        laneVariant="action"
        shape="square"
        format="IMG"
        chips={null}
        name="x"
        meta="y"
        why="z"
        metrics={[]}
        selected
      />,
    );

    expect(off).toContain('aria-checked="false"');
    expect(on).toContain('aria-checked="true"');
  });

  it("shows the deferred opacity class when deferred", () => {
    const html = renderToStaticMarkup(
      <BriefingTile
        laneVariant="watch"
        shape="square"
        format="IMG"
        chips={null}
        name="x"
        meta="y"
        why="z"
        metrics={[]}
        deferred
      />,
    );

    expect(html).toContain("opacity-60");
  });
});

describe("deriveTileShape", () => {
  it("returns portrait when bestPlacement contains Reels or Stories", () => {
    expect(deriveTileShape({ bestPlacement: "instagram_reels" })).toBe("portrait");
    expect(deriveTileShape({ bestPlacement: "facebook_stories" })).toBe("portrait");
  });

  it("returns portrait when any placementList entry mentions Reels", () => {
    expect(
      deriveTileShape({
        placementList: [{ name: "facebook_feed" }, { name: "instagram_reels" }],
      }),
    ).toBe("portrait");
  });

  it("returns square otherwise", () => {
    expect(deriveTileShape({ bestPlacement: "facebook_feed" })).toBe("square");
    expect(deriveTileShape({})).toBe("square");
  });
});

describe("deriveTileFormat", () => {
  it("returns CAR for multi-placement carousels", () => {
    expect(deriveTileFormat({ placements: 4 })).toBe("CAR");
  });

  it("returns IMG by default", () => {
    expect(deriveTileFormat({})).toBe("IMG");
    expect(deriveTileFormat({ placements: 1 })).toBe("IMG");
  });
});
