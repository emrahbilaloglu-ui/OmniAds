// @vitest-environment jsdom

/**
 * The creative studio data boundaries, tested at the call site.
 *
 * Both defects these cover were missing props rather than broken views: the
 * briefs client never supplied `backHref`, so "Back to creatives" pointed at
 * the marketing landing page, and the shares client read the wrong response
 * envelope while exposing a source-less create form.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
  it("reads the real grants envelope and links to an active snapshot", async () => {
    const token = "a".repeat(32);
    serve({
      "/api/creatives/share": {
        grants: [
          {
            token,
            title: "Frozen comparison",
            audience: "creative_team",
            status: "active",
            createdAt: "2026-08-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            revokedAt: null,
            openCount: 0,
            creativeCount: 3,
            firstCreativeName: "Creative one",
            providerAccountId: "act_1",
          },
        ],
      },
    });

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    const open = await screen.findByRole("link", { name: "Open link" });
    expect(open.getAttribute("href")).toBe(`/share/creative/${token}`);
    expect(document.querySelector("[data-share-dialog-backdrop]")).toBeNull();
    expect(document.querySelector("[data-share-create-guidance]")).not.toBeNull();
  });
});
