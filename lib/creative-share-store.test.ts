import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-05-18T00:00:00.000Z",
  }),
}));

const { getCreativeShareSnapshot, sanitizeCreativeSharePayloadForStorage } = await import(
  "@/lib/creative-share-store"
);

const basePayload = {
  title: "Asset Library view",
  dateRange: "Last 14d",
  expiresAt: "2099-01-01T00:00:00.000Z",
  businessId: "biz_1",
  groupBy: "campaign",
  filters: ["Campaign: Q2", "Label: Mixed"],
  selectedRowIds: ["campaign_123"],
  totalRows: 4,
  metrics: ["spend", "hookScore"],
  includeNotes: false,
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
      tags: [],
      spend: 100,
      purchaseValue: 300,
      roas: 3,
      cpa: 50,
      ctrAll: 1.4,
      purchases: 2,
      hookScore: 82,
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

describe("creative share store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks external share payloads before storage", () => {
    const snapshot = sanitizeCreativeSharePayloadForStorage(
      basePayload,
      new Date("2026-05-18T09:30:00.000Z"),
    );

    expect(snapshot.audience).toBe("external");
    expect(snapshot.includeCampaignNames).toBe(false);
    expect(snapshot.includeDecisionLanguage).toBe(false);
    expect(snapshot.filters).toEqual([]);
    expect(snapshot.selectedRowIds).toBeUndefined();
    expect(snapshot.groupBy).toBeUndefined();
    expect(snapshot.clientActions).toBeUndefined();
    expect(snapshot.creatives[0]?.analysis).toBeNull();
    expect(snapshot.createdAt).toBe("2026-05-18T09:30:00.000Z");
    expect(snapshot.frozenAt).toBe("2026-05-18T09:30:00.000Z");
    expect(snapshot.openCount).toBe(0);
  });

  it("keeps only plain client actions for buyer shares", () => {
    const snapshot = sanitizeCreativeSharePayloadForStorage(
      {
        ...basePayload,
        audience: "buyer",
        includeDecisionLanguage: true,
        includeCampaignNames: true,
      },
      new Date("2026-05-18T09:30:00.000Z"),
    );

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
    expect(snapshot.creatives[0]?.analysis?.actionLabel).toBe("Cut");
  });

  it("records public opens in the stored payload", async () => {
    sql
      .mockResolvedValueOnce([
        {
          payload: {
            ...basePayload,
            token: "share_token",
            createdAt: "2026-05-18T09:30:00.000Z",
            frozenAt: "2026-05-18T09:30:00.000Z",
            openCount: 2,
          },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    const payload = await getCreativeShareSnapshot("share_token", { recordOpen: true });

    expect(payload?.openCount).toBe(3);
    expect(String(sql.mock.calls[1]?.[0]?.join(" ") ?? "")).toContain("UPDATE creative_share_snapshots");
  });
});
