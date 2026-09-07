// @vitest-environment jsdom
/** Queue controls retained by the concise Decisions surface. */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetaDecisionCenterExact } from "./MetaDecisionCenterExact";

const VIEW_MODEL = {
  counts: { archive: 12 },
  actionRows: [{ id: "row_1", name: "Prospecting", onOpen: () => {} }],
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("removed queue chrome", () => {
  beforeEach(() => {
    window.history.replaceState(
      {},
      "",
      "/c/biz/meta/decisions?providerAccountId=act_1&area=monitor&segment=needs_resolution&levels=campaign&window=28d",
    );
  });

  it("does not render the removed share control or touch the clipboard", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);
    expect(
      document.querySelector('[data-ctl="live:INV-18 share-view"]'),
    ).toBeNull();
    expect(
      document.querySelector("[data-meta-exact-share-copied]"),
    ).toBeNull();
    expect(
      document.querySelector("[data-meta-exact-share-manual]"),
    ).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps the scoped URL intact while the surface renders", () => {
    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);

    expect(window.location.search).toContain("providerAccountId=act_1");
    expect(window.location.search).toContain("segment=needs_resolution");
    expect(window.location.search).toContain("levels=campaign");
    expect(window.location.search).toContain("window=28d");
    expect(
      document.querySelector('[data-meta-exact-action-row="row_1"]'),
    ).toBeTruthy();
  });
});

describe("the search box answers the / key", () => {
  it("focuses the box from anywhere on the surface", () => {
    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);

    const box = screen.getByRole("textbox", { name: "Find entities" });
    expect(box.getAttribute("data-ctl")).toBe("live:META-DEC-17 search");

    fireEvent.keyDown(document.querySelector("[data-screen-label]")!, {
      key: "/",
    });
    expect(document.activeElement).toBe(box);
  });

  it("leaves / alone while the operator is typing", () => {
    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);

    const box = screen.getByRole("textbox", { name: "Find entities" });
    box.focus();
    fireEvent.keyDown(box, { key: "/" });
    expect(document.activeElement).toBe(box);
  });
});

describe("secondary navigation", () => {
  it("keeps the removed inactive strip and archive lane out of the main queue", () => {
    const onLaneChange = vi.fn();
    render(
      <MetaDecisionCenterExact
        onLaneChange={onLaneChange}
        viewModel={VIEW_MODEL}
      />,
    );

    expect(
      document.querySelector("[data-meta-exact-inactive-strip]"),
    ).toBeNull();
    expect(
      document.querySelector('[data-meta-exact-lane="archive"]'),
    ).toBeNull();
    expect(onLaneChange).not.toHaveBeenCalled();
  });

  it("exposes Meta Ads as a normal external link, never as a decision action", () => {
    render(
      <MetaDecisionCenterExact
        adsManagerHref="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1"
        viewModel={VIEW_MODEL}
      />,
    );

    const link = screen.getByRole("link", { name: "Open Meta Ads" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("data-ctl")).toBeNull();
    expect(link.getAttribute("href")).toContain("adsmanager.facebook.com");
  });

  it("draws no Meta Ads link when no safe destination was supplied", () => {
    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);
    expect(screen.queryByRole("link", { name: "Open Meta Ads" })).toBeNull();
  });
});
