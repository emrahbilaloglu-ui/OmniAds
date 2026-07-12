import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

const sql = vi.fn();

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
  createCreativeShareSnapshot,
  getCreativeShareSnapshot,
  listCreativeShareSnapshots,
  revokeCreativeShareSnapshot,
  rotateCreativeShareSnapshot,
  sanitizeCreativeSharePayloadForRead,
  sanitizeCreativeSharePayloadForStorage,
} = await import("@/lib/creative-share-store");

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
  note: "Internal note with financial context.",
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
      expect(snapshot.includeNotes).toBe(false);
      expect(snapshot.allowCsv).toBe(false);
      expect(snapshot.filters).toEqual([]);
      expect(snapshot.selectedRowIds).toBeUndefined();
      expect(snapshot.groupBy).toBeUndefined();
      expect(snapshot.businessId).toBeUndefined();
      expect(snapshot.clientEmail).toBeUndefined();
      expect(snapshot.currency).toBeUndefined();
      expect(snapshot.clientActions).toBeUndefined();
      expect(snapshot.note).toBeUndefined();
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

  it("checks revocation on reads and again while recording an open", async () => {
    sql
      .mockResolvedValueOnce([
        {
          payload: {
            ...basePayload,
            audience: "buyer",
            token: "share_token",
            createdAt: "2026-05-18T09:30:00.000Z",
            frozenAt: "2026-05-18T09:30:00.000Z",
            openCount: 2,
          },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([{ token: "share_token" }]);

    const payload = await getCreativeShareSnapshot("share_token", { recordOpen: true });

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
            token: "share_token",
            createdAt: "2026-05-18T09:30:00.000Z",
          },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      getCreativeShareSnapshot("share_token", { recordOpen: true }),
    ).resolves.toBeNull();
  });

  it("revokes only within the authenticated business scope and records the actor", async () => {
    sql.mockResolvedValueOnce([{ token: "share_token" }]);

    await expect(revokeCreativeShareSnapshot({
      token: "share_token",
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
            token: "share_old",
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
      token: "share_old",
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
    expect(rotatedJson).not.toContain('"token":"share_old"');
  });
});
