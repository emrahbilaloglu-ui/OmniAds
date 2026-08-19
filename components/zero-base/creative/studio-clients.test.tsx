// @vitest-environment jsdom

/**
 * The creative studio data boundaries, tested at the call site.
 *
 * Both defects these cover were missing props rather than broken views: the
 * briefs client never supplied `backHref`, so "Back to creatives" pointed at
 * the marketing landing page, and the shares client never supplied a way out of
 * the create dialog it opens with.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  CreativeBriefsClient,
  CreativeSharesClient,
} from "@/components/zero-base/creative/studio-clients";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";

const SCOPE = {
  businessId: "biz_1",
  providerAccountId: "act_1",
  start: "2026-07-01",
  end: "2026-07-28",
};

const fetchMock = vi.fn();

function serve(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.startsWith(path));
    if (!match) throw new Error(`unmocked fetch: ${url}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => routes[match],
    } as Response);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreativeBriefsClient", () => {
  it("sends 'Back to creatives' to the scoped creatives route, not the landing page", async () => {
    serve({
      "/api/meta/creative-briefs": {
        briefs: [
          {
            id: "b1",
            title: "Brief one",
            createdAt: "2026-07-02",
            sourceCreativeId: "cr-1",
            sourceAccountId: "act_1",
          },
        ],
      },
    });

    render(
      <ZeroBasePortalHost>
        <CreativeBriefsClient {...SCOPE} creativeId="cr-1" />
      </ZeroBasePortalHost>,
    );

    const link = await screen.findByRole("link", { name: "Back to creatives" });
    expect(link.getAttribute("href")).toBe(
      "/c/biz_1/creative/performance?start=2026-07-01&end=2026-07-28&providerAccountId=act_1",
    );
    // The old fallback was the marketing landing page.
    expect(link.getAttribute("href")).not.toBe("/");
  });

  it("routes the same way from the empty-briefs table", async () => {
    // The view has two back links — one beside a brief, one under the empty
    // table. Both used the same "/" fallback.
    serve({ "/api/meta/creative-briefs": { briefs: [] } });

    render(
      <ZeroBasePortalHost>
        <CreativeBriefsClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    const link = await screen.findByRole("link", { name: "Back to creatives" });
    expect(link.getAttribute("href")).toBe(
      "/c/biz_1/creative/performance?start=2026-07-01&end=2026-07-28&providerAccountId=act_1",
    );
  });
});

describe("CreativeSharesClient", () => {
  it("offers a way out of the create dialog it opens with", async () => {
    serve({ "/api/creatives/share": { shares: [] } });

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-share-dialog-backdrop]")).not.toBeNull(),
    );
    const cancel = document.querySelector("[data-share-cancel]") as HTMLElement;
    expect(cancel, "the create dialog has a dismiss control").not.toBeNull();

    await userEvent.setup().click(cancel);
    expect(document.querySelector("[data-share-dialog-backdrop]")).toBeNull();
  });
});
