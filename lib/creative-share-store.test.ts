import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

const sql = vi.fn();
const TOKEN = "a".repeat(32);
const OLD_TOKEN = "b".repeat(32);

vi.mock("@/lib/media-cache/media-service", () => ({
  MediaCacheService: {
    resolveUrls: vi.fn(async () => new Map()),
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-05-18T00:00:00.000Z",
  }),
}));

const {
  appendCreativeShareMessage,
  createCreativeShareSnapshot,
  getCreativeShareSnapshot,
  listCreativeShareSnapshots,
  revokeCreativeShareSnapshot,
  rotateCreativeShareSnapshot,
  sanitizeCreativeSharePayloadForRead,
  sanitizeCreativeSharePayloadForStorage,
} = await import("@/lib/creative-share-store");
const mediaCache = await import("@/lib/media-cache/media-service");

const basePayload = {
  title: "Asset Library view",
  dateRange: "Last 14d",
  expiresAt: "2099-01-01T00:00:00.000Z",
  businessId: "biz_1",
  businessName: "Example Brand",
  clientEmail: "client@example.com",
  currency: "USD",
  groupBy: "campaign",
  filters: ["Campaign: Q2", "Label: Mixed"],
  selectedRowIds: ["campaign_123"],
  totalRows: 4,
  metrics: [
    "spend",
    "purchaseValue",
    "roas",
    "cpa",
    "cpcLink",
    "cpm",
    "ctrAll",
    "linkCtr",
    "purchases",
    "impressions",
    "thumbstop",
    "video100",
    "hookScore",
  ],
  includeNotes: true,
  note: "Check the drop-off around the third quarter.",
  audience: "external",
  presetId: "external_public",
  presetLabel: "External party",
  includeCampaignNames: true,
  includeDecisionLanguage: true,
  allowCsv: true,
  snapshotOnly: true,
  clientActions: [
    {
      id: "action_1",
      what: "Paused an underperforming ad set ",
      why: " It spent above target for 7 days.",
      date: "2026-05-17",
      outcome: "Return improved",
      outcomeTone: "positive",
    },
  ],
  creatives: [
    {
      id: "creative_1",
      name: "Creative one",
      currency: "USD",
      format: "video",
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
      launchDate: "2026-05-01",
      tags: ["winner", "retargeting"],
      spend: 100,
      purchaseValue: 300,
      roas: 3,
      cpa: 50,
      cpcLink: 2,
      cpm: 10,
      ctrAll: 1.4,
      linkCtr: 1.1,
      purchases: 2,
      impressions: 10_000,
      clicks: 140,
      linkClicks: 110,
      addToCart: 12,
      initiateCheckout: 6,
      leads: 4,
      messages: 3,
      thumbstop: 36,
      clickToAddToCart: 8.5,
      clickToPurchase: 1.4,
      video25: 64,
      video50: 52,
      video75: 40,
      video100: 31,
      atcToPurchaseRatio: 16.7,
      hookScore: 82,
      ctaScore: 72,
      offerScore: 65,
      clickScore: 54,
      watchScore: 88,
      creativeScoreGap: { label: "Offer gap", severity: "watch" },
      analysis: {
        creativeId: "creative_1",
        actionLabel: "Cut",
        authorityLabel: "Engine",
        confidenceLabel: "High",
        headline: "Cut this creative",
        summary: "Decision language should not leak.",
        whatToDo: "Pause it.",
        why: "Below benchmark.",
        evidenceStrength: "strong",
        urgency: "high",
        amountGuidance: null,
        benchmarkLabel: null,
        benchmarkReliability: null,
        previewState: "ready",
        businessValidationNote: null,
        nextObservation: [],
        invalidActions: [],
        factors: [],
      },
    },
  ],
} satisfies Omit<SharePayload, "token" | "createdAt">;

const forbiddenCreatorFields = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "purchases",
  "impressions",
  "clicks",
  "linkClicks",
  "addToCart",
  "initiateCheckout",
  "leads",
  "messages",
  "clickToAddToCart",
  "clickToPurchase",
  "atcToPurchaseRatio",
  "hookScore",
  "ctaScore",
  "offerScore",
  "clickScore",
  "watchScore",
  "creativeScoreGap",
  "analysis",
  "reach",
  "frequency",
  "costPerResult",
] as const;

describe("creative share store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaCache.MediaCacheService.resolveUrls).mockResolvedValue(
      new Map(),
    );
  });

  it.each(["external", "creative_team"] as const)(
    "projects %s payloads to the closed creator-safe metric set before storage",
    (audience) => {
      const snapshot = sanitizeCreativeSharePayloadForStorage(
        { ...basePayload, audience },
        new Date("2026-05-18T09:30:00.000Z"),
      );

      expect(snapshot.audience).toBe(audience);
      expect(snapshot.metrics).toEqual(["ctrAll", "linkCtr", "thumbstop", "video100"]);
      expect(snapshot.includeCampaignNames).toBe(false);
      expect(snapshot.includeDecisionLanguage).toBe(false);
      // A sender's note is a communication channel, not a financial or
      // internal-identity field — it travels for every audience, same as the
      // live notes thread. Everything genuinely sensitive below still strips.
      expect(snapshot.includeNotes).toBe(true);
      expect(snapshot.note).toBe("Check the drop-off around the third quarter.");
      expect(snapshot.allowCsv).toBe(false);
      expect(snapshot.filters).toEqual([]);
      expect(snapshot.selectedRowIds).toBeUndefined();
      expect(snapshot.groupBy).toBeUndefined();
      expect(snapshot.businessId).toBeUndefined();
      expect(snapshot.clientEmail).toBeUndefined();
      expect(snapshot.currency).toBeUndefined();
      expect(snapshot.clientActions).toBeUndefined();
      expect(snapshot.creatives[0]?.tags).toEqual([]);
      for (const field of forbiddenCreatorFields) {
        expect(snapshot.creatives[0]).not.toHaveProperty(field);
      }
      expect(snapshot.createdAt).toBe("2026-05-18T09:30:00.000Z");
      expect(snapshot.frozenAt).toBe("2026-05-18T09:30:00.000Z");
      expect(snapshot.openCount).toBe(0);
    },
  );

  it("re-projects legacy external JSON through an allowlist at read", () => {
    const payload = {
      ...basePayload,
      token: "share_token",
      createdAt: "2026-05-18T09:30:00.000Z",
      creatives: basePayload.creatives.map((creative) => ({
        ...creative,
        reach: 8_000,
        frequency: 1.25,
        costPerResult: 50,
        unknownAbsoluteCounter: 999,
      })),
    } as SharePayload;

    const sanitized = sanitizeCreativeSharePayloadForRead(payload);

    expect(sanitized?.audience).toBe("external");
    const serialized = JSON.stringify(sanitized);
    for (const field of [...forbiddenCreatorFields, "unknownAbsoluteCounter"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).toContain('"ctrAll"');
    expect(serialized).toContain('"video100"');
  });

  it("keeps buyer financials and plain client actions for explicit and legacy-missing audiences", () => {
    for (const audience of ["buyer", undefined] as const) {
      const snapshot = sanitizeCreativeSharePayloadForStorage(
        {
          ...basePayload,
          audience,
          includeDecisionLanguage: true,
          includeCampaignNames: true,
        },
        new Date("2026-05-18T09:30:00.000Z"),
      );

      expect(snapshot.audience).toBe("buyer");
      expect(snapshot.clientActions).toEqual([
        {
          id: "action_1",
          what: "Paused an underperforming ad set",
          why: "It spent above target for 7 days.",
          date: "2026-05-17",
          outcome: "Return improved",
          outcomeTone: "positive",
        },
      ]);
      expect(snapshot.creatives[0]?.spend).toBe(100);
      expect(snapshot.creatives[0]?.analysis?.actionLabel).toBe("Cut");
    }
  });

  it("fails closed for an explicitly malformed legacy audience", () => {
    const malformed = {
      ...basePayload,
      token: "share_token",
      createdAt: "2026-05-18T09:30:00.000Z",
      audience: "client",
    } as unknown as SharePayload;

    expect(sanitizeCreativeSharePayloadForRead(malformed)).toBeNull();
    expect(() => sanitizeCreativeSharePayloadForStorage(malformed)).toThrow(
      "invalid_creative_share_audience",
    );
  });

  it("stores server-provided business and user attribution on mint", async () => {
    sql.mockResolvedValueOnce([]);

    const result = await createCreativeShareSnapshot(basePayload, {
      businessId: "trusted_business",
      providerAccountId: "act_1",
      createdBy: "trusted_user",
    });

    const query = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(query).toContain("business_id");
    expect(query).toContain("provider_account_id");
    expect(query).toContain("created_by");
    expect(sql.mock.calls[0]).toContain("trusted_business");
    expect(sql.mock.calls[0]).toContain("act_1");
    expect(sql.mock.calls[0]).toContain("trusted_user");
    const storedJson = String(sql.mock.calls[0]?.[2] ?? "");
    expect(storedJson).not.toContain('"spend"');
    expect(result.payload.businessId).toBeUndefined();
  });

  it("freezes an available internal media-cache URL into the snapshot", async () => {
    vi.mocked(mediaCache.MediaCacheService.resolveUrls).mockResolvedValue(
      new Map([
        [
          "creative_1",
          {
            source: "cache" as const,
            url: "/api/media/cache/frozen-poster.jpg",
          },
        ],
      ]),
    );
    sql.mockResolvedValueOnce([]);

    const sourceVideo = "https://meta.example/expiring-video.mp4";
    const result = await createCreativeShareSnapshot(
      {
        ...basePayload,
        audience: "buyer",
        creatives: [
          {
            ...basePayload.creatives[0]!,
            thumbnailUrl: "https://meta.example/expiring-poster.jpg",
            preview: {
              ...basePayload.creatives[0]!.preview,
              render_mode: "video",
              video_url: sourceVideo,
              poster_url: "https://meta.example/expiring-poster.jpg",
            },
          },
        ],
      },
      {
        businessId: "trusted_business",
        providerAccountId: "act_1",
        createdBy: "trusted_user",
      },
    );

    expect(mediaCache.MediaCacheService.resolveUrls).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          creative_id: "creative_1",
          thumbnail_url: "https://meta.example/expiring-poster.jpg",
        }),
      ],
      "trusted_business",
    );
    expect(result.payload.creatives[0]?.cachedThumbnailUrl).toBe(
      "/api/media/cache/frozen-poster.jpg",
    );
    expect(result.payload.creatives[0]?.preview.poster_url).toBe(
      "/api/media/cache/frozen-poster.jpg",
    );
    // The existing cache stores still images/posters. It must not pretend it
    // has frozen a video binary that it never downloaded.
    expect(result.payload.creatives[0]?.preview.video_url).toBe(sourceVideo);
  });

  it("checks revocation on reads and again while recording an open", async () => {
    sql
      .mockResolvedValueOnce([
        {
          payload: {
            ...basePayload,
            audience: "buyer",
            token: TOKEN,
            createdAt: "2026-05-18T09:30:00.000Z",
            frozenAt: "2026-05-18T09:30:00.000Z",
            openCount: 2,
          },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([{ token: TOKEN, open_count: 3 }]);

    const payload = await getCreativeShareSnapshot(TOKEN, { recordOpen: true });

    expect(payload?.openCount).toBe(3);
    const selectQuery = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    const updateQuery = String(sql.mock.calls[1]?.[0]?.join(" ") ?? "");
    expect(selectQuery).toContain("revoked_at IS NULL");
    expect(updateQuery).toContain("revoked_at IS NULL");
    expect(updateQuery).toContain("expires_at > NOW()");
  });

  it("returns null when a share is revoked between select and open-count update", async () => {
    sql
      .mockResolvedValueOnce([
        {
          payload: {
            ...basePayload,
            audience: "buyer",
            token: TOKEN,
            createdAt: "2026-05-18T09:30:00.000Z",
          },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      getCreativeShareSnapshot(TOKEN, { recordOpen: true }),
    ).resolves.toBeNull();
  });

  it("revokes only within the authenticated business scope and records the actor", async () => {
    sql.mockResolvedValueOnce([{ token: TOKEN }]);

    await expect(revokeCreativeShareSnapshot({
      token: TOKEN,
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    })).resolves.toBe(true);

    const query = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(query).toContain("SET revoked_at = NOW(), revoked_by");
    expect(query).toContain("business_id::text");
    expect(query).toContain("payload->>'businessId'");
    expect(sql.mock.calls[0]).toContain("trusted_business");
    expect(sql.mock.calls[0]).toContain("trusted_user");
  });

  it("lists only the requested business and provider account as truthful ledger summaries", async () => {
    sql.mockResolvedValueOnce([
      {
        token: "share_active",
        payload: {
          ...basePayload,
          token: "share_active",
          title: "Creator handoff",
          audience: "creative_team",
          createdAt: "2026-07-10T09:00:00.000Z",
          openCount: 3,
        },
        provider_account_id: "act_iwa",
        expires_at: "2099-01-01T00:00:00.000Z",
        revoked_at: null,
        created_at: "2026-07-10T09:00:00.000Z",
      },
    ]);

    const entries = await listCreativeShareSnapshots({
      businessId: "trusted_business",
      providerAccountId: "act_iwa",
    });

    expect(entries).toEqual([
      expect.objectContaining({
        token: "share_active",
        status: "active",
        audience: "creative_team",
        openCount: 3,
        creativeCount: 1,
        firstCreativeName: "Creative one",
        providerAccountId: "act_iwa",
      }),
    ]);
    const query = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(query).toContain("business_id::text");
    expect(query).toContain("provider_account_id");
    expect(sql.mock.calls[0]).toContain("trusted_business");
    expect(sql.mock.calls[0]).toContain("act_iwa");
  });

  it("rotates an active token in one transaction while preserving the frozen payload", async () => {
    sql
      .mockResolvedValueOnce([
        {
          payload: {
            ...basePayload,
            token: OLD_TOKEN,
            createdAt: "2026-07-10T09:00:00.000Z",
            frozenAt: "2026-07-10T09:00:00.000Z",
          },
          expires_at: "2099-01-01T00:00:00.000Z",
          business_id: "trusted_business",
          provider_account_id: "act_iwa",
          created_by: "trusted_user",
        },
      ])
      .mockResolvedValueOnce([]);

    const rotated = await rotateCreativeShareSnapshot({
      token: OLD_TOKEN,
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    });

    expect(rotated?.token).toMatch(/^[a-f0-9]{32}$/);
    expect(rotated?.url).toBe(`/share/creative/${rotated?.token}`);
    const updateQuery = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    const insertQuery = String(sql.mock.calls[1]?.[0]?.join(" ") ?? "");
    expect(updateQuery).toContain("expires_at > NOW()");
    expect(updateQuery).toContain("business_id::text");
    expect(insertQuery).toContain("INSERT INTO creative_share_snapshots");
    const rotatedJson = String(sql.mock.calls[1]?.[2] ?? "");
    expect(rotatedJson).toContain('"frozenAt":"2026-07-10T09:00:00.000Z"');
    expect(rotatedJson).toContain('"openCount":0');
    expect(rotatedJson).not.toContain(`"token":"${OLD_TOKEN}"`);
  });

  it("merges the live messages column onto a read, separately from the frozen payload", async () => {
    sql.mockResolvedValueOnce([
      {
        payload: { ...basePayload, audience: "buyer", token: TOKEN, createdAt: "2026-05-18T09:30:00.000Z" },
        expires_at: "2099-01-01T00:00:00.000Z",
        messages: [
          { id: "m1", who: "viewer", name: "Client", text: "Which hook wins?", postedAt: "2026-08-14T09:00:00.000Z" },
        ],
      },
    ]);

    const payload = await getCreativeShareSnapshot(TOKEN);

    expect(payload?.messages).toEqual([
      { id: "m1", who: "viewer", name: "Client", text: "Which hook wins?", postedAt: "2026-08-14T09:00:00.000Z" },
    ]);
    const selectQuery = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(selectQuery).toContain("messages");
  });

  it("posts a message in one atomic append, serialized by the row lock", async () => {
    sql.mockResolvedValueOnce([
      {
        messages: [
          { id: "m1", who: "viewer", name: "Client", text: "Which hook wins?", postedAt: "2026-08-14T09:00:00.000Z" },
        ],
      },
    ]);

    const result = await appendCreativeShareMessage({ token: TOKEN, text: "Which hook wins?" });

    expect(result).toEqual({
      ok: true,
      messages: [
        { id: "m1", who: "viewer", name: "Client", text: "Which hook wins?", postedAt: "2026-08-14T09:00:00.000Z" },
      ],
    });
    expect(sql.mock.calls).toHaveLength(1);
    const query = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(query).toContain("messages = messages ||");
    expect(query).toContain("jsonb_array_length(messages) <");
    expect(query).toContain("revoked_at IS NULL");
    expect(query).toContain("expires_at > NOW()");
  });

  it("refuses text over the length bound before any query runs", async () => {
    const result = await appendCreativeShareMessage({ token: TOKEN, text: "x".repeat(601) });
    expect(result).toEqual({ ok: false, reason: "invalid_text" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("refuses whitespace-only text before any query runs", async () => {
    const result = await appendCreativeShareMessage({ token: TOKEN, text: "   " });
    expect(result).toEqual({ ok: false, reason: "invalid_text" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("distinguishes a dead token from a full thread, both refused the same append", async () => {
    // First call: the UPDATE finds no matching row (0 returned). Second call:
    // the diagnostic SELECT this function makes to say WHY, truthfully.
    sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null, message_count: 200 },
      ]);

    const result = await appendCreativeShareMessage({ token: TOKEN, text: "hello" });

    expect(result).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("says not_found rather than limit_reached for an expired token", async () => {
    sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { expires_at: "2020-01-01T00:00:00.000Z", revoked_at: null, message_count: 3 },
      ]);

    const result = await appendCreativeShareMessage({ token: TOKEN, text: "hello" });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
