import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

vi.mock("@/lib/creative-share-store", () => ({
  getCreativeShareSnapshot: vi.fn(),
}));

const shareStore = await import("@/lib/creative-share-store");
const { GET } = await import("@/app/share/creative/[token]/csv/route");

const TOKEN = "d".repeat(32);
const context = { params: Promise.resolve({ token: TOKEN }) };

function payload(overrides: Partial<SharePayload> = {}): SharePayload {
  return {
    token: TOKEN,
    title: "Buyer snapshot",
    dateRange: "2026-08-01 - 2026-08-19",
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    businessId: "secret_business",
    providerAccountId: "secret_account",
    metrics: ["spend", "ctrAll"],
    includeNotes: false,
    audience: "buyer",
    allowCsv: true,
    creatives: [
      {
        id: "secret_creative_id",
        name: "Hero",
        currency: "USD",
        format: "image",
        previewState: "preview",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "unavailable",
          image_url: null,
          video_url: null,
          poster_url: null,
          source: null,
          is_catalog: false,
        },
        launchDate: "2026-08-01",
        tags: [],
        spend: 12.5,
        purchaseValue: 25,
        roas: 2,
        cpa: 6.25,
        ctrAll: 1.2,
        purchases: 2,
      },
    ],
    ...overrides,
  };
}

describe("GET /share/creative/[token]/csv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads a sanitized buyer CSV when the frozen snapshot permits it", async () => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockResolvedValue(payload());

    const response = await GET(
      new Request(`http://localhost/share/creative/${TOKEN}/csv`),
      context,
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain(
      "creative-snapshot.csv",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    // Response.text() decodes and strips the UTF-8 BOM; the first decoded
    // field is still the expected header.
    expect(csv.startsWith("Creative,Format,Created,Spend,CTR")).toBe(true);
    expect(csv).toContain("Hero,image,2026-08-01,12.5,1.2");
    expect(csv).not.toContain("secret_business");
    expect(csv).not.toContain("secret_account");
    expect(csv).not.toContain("secret_creative_id");
  });

  it.each([
    ["creative-team share", payload({ audience: "creative_team", allowCsv: true })],
    ["buyer without permission", payload({ allowCsv: false })],
    ["missing or expired snapshot", null],
  ] as const)("returns the same 404 for %s", async (_label, stored) => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockResolvedValue(stored);

    const response = await GET(
      new Request(`http://localhost/share/creative/${TOKEN}/csv`),
      context,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("rejects malformed tokens before touching the store", async () => {
    const response = await GET(
      new Request("http://localhost/share/creative/not-a-token/csv"),
      { params: Promise.resolve({ token: "not-a-token" }) },
    );

    expect(response.status).toBe(404);
    expect(shareStore.getCreativeShareSnapshot).not.toHaveBeenCalled();
  });
});
