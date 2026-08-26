// @vitest-environment jsdom
/**
 * The three queue-level controls the design names and the surface had none of.
 *
 * `live:INV-18 share-view` — the contract is "copies URL carrying
 * account/lane/level/window params; recipient with permission reproduces
 * view", announced through `role="status"`, with a manual-copy fallback when
 * the clipboard is denied. Every one of those parameters is already in the URL
 * because every control that sets them writes there, so the control is a COPY
 * and not a link: there is nowhere to navigate that is not where the operator
 * already is.
 *
 * `live:META-DEC-17 search` — "click or / key". The box existed; the key did
 * not, and the marker did not.
 *
 * `live:META-DEC-13 open` — "opens advisory inactive-assets strip detail
 * (read-only)". The Archive lane IS that detail: every row in it is an inactive
 * campaign, ad set or withheld Ad decision and none carries an action. What was
 * missing was the strip that says how many there are and opens it.
 */
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

describe("copying a link to this view", () => {
  beforeEach(() => {
    window.history.replaceState(
      {},
      "",
      "/c/biz/meta/decisions?providerAccountId=act_1&area=monitor&segment=needs_resolution&levels=campaign&window=28d",
    );
  });

  it("copies the current URL and announces that it did", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);
    fireEvent.click(
      document.querySelector('[data-ctl="live:INV-18 share-view"]')!,
    );
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-meta-exact-share-copied]"),
      ).toBeTruthy(),
    );

    // The URL, verbatim — every scoping parameter the contract names is in it
    // because every control that sets one writes it there.
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("providerAccountId=act_1");
    expect(copied).toContain("segment=needs_resolution");
    expect(copied).toContain("levels=campaign");
    expect(copied).toContain("window=28d");
    // Announced, not merely changed: the operator's hands are on the keyboard.
    expect(
      document.querySelector("[data-meta-exact-share-copied]")?.getAttribute("role"),
    ).toBe("status");
  });

  it("falls back to a selectable field when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);
    fireEvent.click(
      document.querySelector('[data-ctl="live:INV-18 share-view"]')!,
    );

    const manual = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>(
        "[data-meta-exact-share-manual]",
      );
      expect(node).toBeTruthy();
      return node!;
    });
    // A denied clipboard costs a keystroke, never the link itself.
    expect(manual.value).toContain("/c/biz/meta/decisions");
    expect(manual.readOnly).toBe(true);
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
    // `/` is a character in a search term, an entity name and a reason code.
    expect(document.activeElement).toBe(box);
  });
});

describe("the inactive-assets strip", () => {
  it("states the count and opens the lane that holds the detail", () => {
    const onLaneChange = vi.fn();
    render(
      <MetaDecisionCenterExact
        onLaneChange={onLaneChange}
        viewModel={VIEW_MODEL}
      />,
    );

    const strip = document.querySelector("[data-meta-exact-inactive-strip]");
    expect(strip?.textContent).toContain("Inactive assets 12");
    // Advisory, and said so: none of these rows carries an action.
    expect(strip?.textContent).toContain("advisory only");

    fireEvent.click(document.querySelector('[data-ctl="live:META-DEC-13 open"]')!);
    expect(onLaneChange).toHaveBeenCalledWith("archive");
  });

  it("draws the Ads Manager link as a way out, never as an action", () => {
    render(
      <MetaDecisionCenterExact
        adsManagerHref="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1"
        viewModel={VIEW_MODEL}
      />,
    );

    const link = document.querySelector("[data-meta-exact-ads-manager-link]");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.textContent).toContain("Nothing here is executed");
    /*
     * No `data-ctl`. The design's contract has no key for an Ads Manager link;
     * `live:META-DEC-13 open` is the inactive-assets strip, and stamping this
     * control with it would name it as something it is not.
     */
    expect(link?.getAttribute("data-ctl")).toBeNull();
  });

  it("draws no link at all for an account id Meta's URL cannot take", () => {
    render(<MetaDecisionCenterExact viewModel={VIEW_MODEL} />);
    expect(
      document.querySelector("[data-meta-exact-ads-manager-link]"),
    ).toBeNull();
  });
});
