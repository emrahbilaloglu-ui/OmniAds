// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  BriefsView,
  LandingPagesView,
  SharesView,
  SourcedListView,
} from "@/components/zero-base/creative/studio-views";
import { ShareMedia } from "@/components/zero-base/creative/share-media";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { toBriefRow, toShareRow, type ServedShare } from "@/lib/zero-base/creative/studio-adapters";

afterEach(cleanup);

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("briefs surface", () => {
  function briefs(canCreate = true) {
    render(
      <ZeroBasePortalHost>
        <BriefsView
          rows={[
            toBriefRow({ id: "b1", title: "Brief one", createdAt: "t", sourceCreativeId: "cr-1", sourceAccountId: "act_1" }),
            toBriefRow({ id: "b2", title: "Brief two", createdAt: "t" }),
          ]}
          canCreate={canCreate}
          createBlockedReason={canCreate ? null : "A brief can only be created from a known creative."}
        />
      </ZeroBasePortalHost>,
    );
  }

  it("offers no delete control anywhere", () => {
    briefs();
    // A brief is lineage; deleting one would orphan what came from it.
    expect(document.body.textContent).not.toMatch(/\bdelete\b/i);
    expect(document.querySelectorAll("[data-brief-delete]").length).toBe(0);
  });

  it("says why briefs cannot be deleted rather than leaving it unexplained", () => {
    briefs();
    expect(document.body.textContent).toMatch(/cannot be deleted/);
  });

  it("discloses a brief with no recorded lineage", () => {
    briefs();
    expect(document.querySelector('[data-brief-lineage-missing="b2"]')).not.toBeNull();
    expect(document.querySelector('[data-brief-lineage="b1"]')!.textContent).toContain("cr-1");
  });

  it("blocks creation with a stated reason when lineage is unavailable", () => {
    briefs(false);
    expect(document.querySelector("[data-brief-create]")).toBeNull();
    expect(document.querySelector("[data-brief-create-blocked]")!.textContent).toMatch(/known creative/);
  });
});

describe("inbox and copies source states", () => {
  it("marks an unsourced row instead of leaving it blank", () => {
    render(
      <SourcedListView
        title="Creative inbox"
        rows={[
          { id: "i1", label: "Item one", detail: null, source: "meta_ad_library" },
          { id: "i2", label: "Item two", detail: null, source: null },
        ]}
        emptyReason="empty"
      />,
    );
    expect(document.querySelector('[data-row-source="i1"]')!.textContent).toBe("meta_ad_library");
    expect(document.querySelector('[data-row-unsourced="i2"]')!.textContent).toMatch(/No source/);
  });

  it("states an empty collection rather than rendering nothing", () => {
    render(<SourcedListView title="Copies" rows={[]} emptyReason="No copy was served for this window." />);
    expect(document.querySelector("[data-sourced-empty]")!.textContent).toMatch(/No copy was served/);
  });
});

describe("landing-page caps", () => {
  it("prints the served caps", () => {
    render(<LandingPagesView rows={[]} served={{ rowCap: 250, pageSize: 100 }} />);
    const node = document.querySelector('[data-landing-cap="served"]')!;
    expect(node.textContent).toMatch(/Up to 250 rows, 100 per page/);
  });

  it("says the backend supplied no cap, with no number from the spec", () => {
    render(<LandingPagesView rows={[]} served={{}} />);
    const node = document.querySelector('[data-landing-cap="not-supplied"]')!;
    expect(node.textContent).toMatch(/Backend cap not supplied/);
    expect(node.textContent).not.toMatch(/250|100/);
  });

  it("carries no obsolete top-20 language", () => {
    render(<LandingPagesView rows={[]} served={{ rowCap: 250, pageSize: 100 }} />);
    expect(document.body.textContent).not.toMatch(/top 20/i);
  });
});

describe("share ledger", () => {
  const base: ServedShare = {
    token: "t1",
    title: "Q3",
    audience: "buyer",
    createdAt: "2026-08-01",
    expiresAt: "2026-08-20",
  };

  function shares(rows = [base], handlers: Partial<React.ComponentProps<typeof SharesView>> = {}) {
    render(
      <ZeroBasePortalHost>
        <SharesView rows={rows.map((share) => toShareRow(share, NOW))} {...handlers} />
      </ZeroBasePortalHost>,
    );
  }

  it("offers rotate and revoke on an active share", () => {
    shares();
    expect(document.querySelector('[data-share-rotate="t1"]')).not.toBeNull();
    expect(document.querySelector('[data-share-revoke="t1"]')).not.toBeNull();
  });

  it("offers neither on a revoked or expired share", () => {
    shares([{ ...base, revokedAt: "2026-08-05" }]);
    expect(document.querySelector('[data-share-rotate="t1"]')).toBeNull();
    expect(document.querySelector("[data-share-actions-none]")!.textContent).toMatch(/already revoked/);
  });

  it("shows the owner which of revoked and expired happened", () => {
    shares([{ ...base, revokedAt: "x" }]);
    expect(document.querySelector('[data-share-status="t1"]')!.textContent).toBe("Revoked");
    cleanup();
    shares([{ ...base, expiresAt: "2026-08-01" }]);
    expect(document.querySelector('[data-share-status="t1"]')!.textContent).toBe("Expired");
  });

  it("calls rotate and revoke with the token", async () => {
    const onRotate = vi.fn();
    const onRevoke = vi.fn();
    shares([base], { onRotate, onRevoke });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-share-rotate="t1"]') as HTMLElement);
    await user.click(document.querySelector('[data-share-revoke="t1"]') as HTMLElement);
    expect(onRotate).toHaveBeenCalledWith("t1");
    expect(onRevoke).toHaveBeenCalledWith("t1");
  });

  it("surfaces a failure verbatim rather than silently doing nothing", () => {
    shares([base], { error: "The share could not be revoked (HTTP 503)." });
    expect(document.querySelector("[data-share-error]")!.textContent).toMatch(/HTTP 503/);
  });
});

describe("public share media", () => {
  it("renders a keyboard-operable video with native controls", () => {
    render(<ShareMedia source={{ kind: "video", url: "/v.mp4", alt: "Ad video" }} />);
    const video = document.querySelector('[data-share-media="video"]') as HTMLVideoElement;
    // Native controls are focusable and keyboard operable; a custom control set
    // would have to reimplement that and would eventually get it wrong.
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("playsinline")).not.toBeNull();
  });

  it("attaches a captions track when one was served, and none when not", () => {
    render(
      <ShareMedia
        source={{ kind: "video", url: "/v.mp4", alt: "v", captionsUrl: "/c.vtt", captionsLabel: "English" }}
      />,
    );
    const track = document.querySelector("[data-share-captions]") as HTMLTrackElement;
    expect(track.getAttribute("kind")).toBe("captions");
    expect(track.getAttribute("label")).toBe("English");
    cleanup();
    render(<ShareMedia source={{ kind: "video", url: "/v.mp4", alt: "v" }} />);
    expect(document.querySelector("[data-share-captions]")).toBeNull();
  });

  it("shows an error state and a retry that re-attempts the load", async () => {
    render(<ShareMedia source={{ kind: "image", url: "/broken.jpg", alt: "Ad" }} />);
    const img = document.querySelector('[data-share-media="image"]')!;
    img.dispatchEvent(new Event("error"));

    await waitFor(() => expect(document.querySelector('[data-share-media="error"]')).not.toBeNull());
    const retry = document.querySelector("[data-share-media-retry]") as HTMLElement;
    expect(retry).not.toBeNull();

    await userEvent.setup().click(retry);
    // A real re-attempt, not just the message disappearing.
    await waitFor(() => expect(document.querySelector('[data-share-media="image"]')).not.toBeNull());
  });

  it("says plainly when a share carried no media", () => {
    render(<ShareMedia source={null} />);
    expect(document.querySelector('[data-share-media="missing"]')!.textContent).toMatch(/No media/);
  });
});
