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
  it("lists the grants the endpoint actually sends", async () => {
    /**
     * The ledger read `data.shares`, a key `/api/creatives/share` has never
     * sent — it answers `{ grants, capability }`. So the list rendered empty on
     * every account: a proven-empty claim over a payload that had the rows in
     * it all along. Plan §5.1 finding 15.
     */
    serve({
      "/api/creatives/share": {
        grants: [
          {
            token: "tok_live",
            title: "August cutdowns",
            audience: "creator",
            status: "active",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-09-01T00:00:00.000Z",
            revokedAt: null,
            openCount: 3,
            creativeCount: 2,
            firstCreativeName: "Hook A",
            providerAccountId: "act_1",
          },
        ],
        capability: { status: "ready", canReadLedger: true, canWrite: true, missingColumns: [] },
      },
    });

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("August cutdowns");
    });
  });

  /** One served creative, in the shape `/api/meta/creatives` answers with. */
  const SERVED_CREATIVE = {
    id: "crt_1",
    name: "Hook A — 9:16",
    format: "video",
    creative_type: "reel",
    launch_date: "2026-07-02",
    currency: "USD",
    preview: { render_mode: "video", image_url: null, video_url: null, poster_url: null, source: null, is_catalog: false },
    spend: 120,
    purchases: 4,
    purchase_value: 480,
    roas: 4,
    impressions: 5000,
    clicks: 60,
  };

  function ledgerAndCreatives(extra: Record<string, unknown> = {}) {
    return {
      "/api/creatives/share": {
        grants: [],
        capability: { status: "ready", canReadLedger: true, canWrite: true, missingColumns: [] },
      },
      "/api/meta/creatives": { rows: [SERVED_CREATIVE] },
      ...extra,
    };
  }

  it("mints from a ticked selection, with the audience value the server accepts", async () => {
    /**
     * Two defects in one test, because they compounded.
     *
     * The form sent `creatives: []` while the route requires at least one, so
     * the screen disabled its own mint control and pointed the operator at the
     * Creative Studio — the canonical console could not produce a share at all.
     * And the audience it would have sent was `creator`, which is in none of
     * `SHARE_AUDIENCES` (`buyer`, `creative_team`, `external`), so even a
     * populated payload was a 400 before it reached the store.
     */
    serve(ledgerAndCreatives());

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelector('[data-ctl="live:CREATIVE-10 open-create"]')).not.toBeNull();
    });
    await user.click(
      document.querySelector('[data-ctl="live:CREATIVE-10 open-create"]') as HTMLElement,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-share-creative-option="crt_1"]')).not.toBeNull();
    });

    await user.click(
      document.querySelector('[data-share-creative-option="crt_1"] input') as HTMLElement,
    );
    await user.type(screen.getByLabelText("Title"), "August cutdowns");
    await user.type(screen.getByLabelText("Expires at"), "2099-09-01");
    await user.click(document.querySelector("[data-share-create]") as HTMLElement);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      audience: string;
      creatives: unknown[];
      metrics: unknown[];
      selectedRowIds: string[];
      snapshotOnly: boolean;
    };

    expect(body.audience).toBe("creative_team");
    // The two things the route validates and this screen used to fail.
    expect(body.creatives.length).toBeGreaterThan(0);
    expect(body.metrics.length).toBeGreaterThan(0);
    expect(body.selectedRowIds).toEqual(["crt_1"]);
    expect(body.snapshotOnly).toBe(true);
  });

  it("refuses the mint with the gate's own sentence, and still allows withdrawal", async () => {
    serve(ledgerAndCreatives());
    const refusal = "Public share minting is not enabled for this deployment.";

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} shareMintRefusalReason={refusal} />
      </ZeroBasePortalHost>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-ctl="live:CREATIVE-10 open-create"]')).not.toBeNull();
    });
    const create = document.querySelector(
      '[data-ctl="live:CREATIVE-10 open-create"]',
    ) as HTMLElement;
    // Refused with the server's reason, and refusing means the form never opens.
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await userEvent.setup().click(create);
    expect(document.querySelector("[data-share-dialog-backdrop]")).toBeNull();
  });

  it("says the account served nothing rather than offering an empty form", async () => {
    serve({
      "/api/creatives/share": {
        grants: [],
        capability: { status: "ready", canReadLedger: true, canWrite: true, missingColumns: [] },
      },
      "/api/meta/creatives": { rows: [] },
    });

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-ctl="live:CREATIVE-10 open-create"]')).not.toBeNull();
    });
    const create = document.querySelector(
      '[data-ctl="live:CREATIVE-10 open-create"]',
    ) as HTMLElement;
    expect(create.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows an unreadable ledger as unavailable, not as no shares", async () => {
    /**
     * The endpoint answers 200 with `grants: []` and `canReadLedger: false`
     * while the share table's migration is pending. Rendering that as an empty
     * ledger tells the operator they have never shared anything — a claim about
     * their own history, made from a failed read. D8.
     */
    serve({
      "/api/creatives/share": {
        grants: [],
        capability: {
          status: "migration_required",
          canReadLedger: false,
          canWrite: false,
          missingColumns: ["token"],
        },
        message: "Creator share ledger requires the pending database migration.",
      },
    });

    render(
      <ZeroBasePortalHost>
        <CreativeSharesClient {...SCOPE} />
      </ZeroBasePortalHost>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("pending database migration");
    });
  });
});
