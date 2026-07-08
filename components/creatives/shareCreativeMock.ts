import { SharePayload } from "./shareCreativeTypes";

/**
 * Mock payload used for local development of the public share page.
 * Includes all preview fields used by CreativeRenderSurface fallback logic.
 */
export const MOCK_SHARE_PAYLOAD: SharePayload = {
  token: "mock-token-123",
  title: "Top Performing Creatives — Feb 2026",
  dateRange: "Feb 12 – Mar 5, 2026",
  createdAt: "2026-03-05T10:00:00.000Z",
  expiresAt: "2026-03-12T10:00:00.000Z",

  metrics: ["spend", "purchaseValue", "roas", "cpa", "ctrAll", "purchases"],

  includeNotes: true,
  note:
    "These creatives were selected based on ROAS and purchase volume over the last 14 days.",
  businessName: "Miradora Home",
  clientEmail: "selin@miradora.com",
  currency: "TRY",
  trackingState: "normal",
  clientActions: [
    {
      id: "action_1",
      what: "Paused an underperforming ad set",
      why: "It spent 9,800 TRY over 7 days at 0.6x return vs the 1.8x target. The budget now flows to better-performing sets.",
      date: "2026-03-03",
      outcome: "7 days later: account return improved to 2.1x",
      outcomeTone: "positive",
    },
    {
      id: "action_2",
      what: "Launched a new creative test",
      why: "A UGC video variant entered testing in two ad sets. Tests start paused and are activated deliberately.",
      date: "2026-03-01",
      outcome: "outcome window not closed yet",
      outcomeTone: "neutral",
    },
  ],

  creatives: [
    {
      id: "m-1",
      name: "UGC Reel - Morning routine hook",
      format: "video",
      previewState: "preview",
      isCatalog: false,

      /** preview image sources */
      cardPreviewUrl: "https://picsum.photos/seed/meta1/800/600",
      tableThumbnailUrl: "https://picsum.photos/seed/meta1/320/240",
      cachedThumbnailUrl: null,
      previewUrl: "https://picsum.photos/seed/meta1/800/600",
      imageUrl: "https://picsum.photos/seed/meta1/800/600",
      thumbnailUrl: "https://picsum.photos/seed/meta1/320/240",

      preview: {
        render_mode: "image",
        image_url: "https://picsum.photos/seed/meta1/800/600",
        video_url: null,
        poster_url: "https://picsum.photos/seed/meta1/800/600",
        source: "preview_url",
        is_catalog: false,
      },

      launchDate: "2026-02-21",
      tags: ["winner", "retargeting"],

      spend: 1840,
      purchaseValue: 6980,
      roas: 3.79,
      cpa: 24.86,
      ctrAll: 2.41,
      purchases: 74,
      analysis: {
        creativeId: "m-1",
        actionLabel: "Scale",
        authorityLabel: "Review only",
        confidenceLabel: "High",
        headline: "Scale review: UGC Reel - Morning routine hook",
        summary: "Strong relative winner, but keep the move buyer-reviewed before changing spend.",
        whatToDo: "Send this to the media buyer for a controlled scale review.",
        why: "ROAS and purchase volume are above the selected benchmark while evidence quality is high.",
        evidenceStrength: "strong",
        urgency: "medium",
        amountGuidance: "No safe amount calculated",
        benchmarkLabel: "Account-wide",
        benchmarkReliability: "Strong",
        previewState: "ready",
        businessValidationNote: null,
        nextObservation: ["Watch CPA after the next budget move.", "Keep the same hook and first-frame structure."],
        invalidActions: ["Do not scale from ROAS alone without buyer confirmation."],
        factors: [
          {
            label: "ROAS",
            value: "3.79",
            reason: "Above the selected benchmark for this cohort.",
            impact: "positive",
          },
          {
            label: "Purchases",
            value: "74",
            reason: "Enough purchase volume to justify a buyer review.",
            impact: "positive",
          },
        ],
      },
    },

    {
      id: "m-3",
      name: "Founder story - trust angle",
      format: "video",
      previewState: "preview",
      isCatalog: false,

      cardPreviewUrl: "https://picsum.photos/seed/meta3/800/600",
      tableThumbnailUrl: "https://picsum.photos/seed/meta3/320/240",
      cachedThumbnailUrl: null,
      previewUrl: "https://picsum.photos/seed/meta3/800/600",
      imageUrl: "https://picsum.photos/seed/meta3/800/600",
      thumbnailUrl: "https://picsum.photos/seed/meta3/320/240",

      preview: {
        render_mode: "image",
        image_url: "https://picsum.photos/seed/meta3/800/600",
        video_url: null,
        poster_url: "https://picsum.photos/seed/meta3/800/600",
        source: "preview_url",
        is_catalog: false,
      },

      launchDate: "2026-02-19",
      tags: ["video", "evergreen"],

      spend: 2210,
      purchaseValue: 8320,
      roas: 3.76,
      cpa: 26.95,
      ctrAll: 2.26,
      purchases: 82,
      analysis: {
        creativeId: "m-3",
        actionLabel: "Protect",
        authorityLabel: "Protect",
        confidenceLabel: "Medium",
        headline: "Protect: Founder story - trust angle",
        summary: "Stable performer; keep it live and avoid unnecessary edits.",
        whatToDo: "Leave the creative active and monitor weekly movement.",
        why: "Performance remains strong without an immediate fatigue or replacement signal.",
        evidenceStrength: "medium",
        urgency: "low",
        amountGuidance: "No amount needed",
        benchmarkLabel: "Account-wide",
        benchmarkReliability: "Strong",
        previewState: "ready",
        businessValidationNote: null,
        nextObservation: ["Watch frequency pressure before planning a refresh."],
        invalidActions: ["Do not cut a protected winner because of short-term volatility."],
        factors: [
          {
            label: "ROAS",
            value: "3.76",
            reason: "Still above the selected benchmark.",
            impact: "positive",
          },
        ],
      },
    },

    {
      id: "m-8",
      name: "Bundle offer - creator POV",
      format: "video",
      previewState: "preview",
      isCatalog: false,

      cardPreviewUrl: "https://picsum.photos/seed/meta8/800/600",
      tableThumbnailUrl: "https://picsum.photos/seed/meta8/320/240",
      cachedThumbnailUrl: null,
      previewUrl: "https://picsum.photos/seed/meta8/800/600",
      imageUrl: "https://picsum.photos/seed/meta8/800/600",
      thumbnailUrl: "https://picsum.photos/seed/meta8/320/240",

      preview: {
        render_mode: "image",
        image_url: "https://picsum.photos/seed/meta8/800/600",
        video_url: null,
        poster_url: "https://picsum.photos/seed/meta8/800/600",
        source: "preview_url",
        is_catalog: false,
      },

      launchDate: "2026-03-01",
      tags: ["creator", "bundle"],

      spend: 1090,
      purchaseValue: 4120,
      roas: 3.78,
      cpa: 22.71,
      ctrAll: 2.47,
      purchases: 48,
    },

    {
      id: "m-5",
      name: "Problem-solution demo cut",
      format: "video",
      previewState: "preview",
      isCatalog: false,

      cardPreviewUrl: "https://picsum.photos/seed/meta5/800/600",
      tableThumbnailUrl: "https://picsum.photos/seed/meta5/320/240",
      cachedThumbnailUrl: null,
      previewUrl: "https://picsum.photos/seed/meta5/800/600",
      imageUrl: "https://picsum.photos/seed/meta5/800/600",
      thumbnailUrl: "https://picsum.photos/seed/meta5/320/240",

      preview: {
        render_mode: "image",
        image_url: "https://picsum.photos/seed/meta5/800/600",
        video_url: null,
        poster_url: "https://picsum.photos/seed/meta5/800/600",
        source: "preview_url",
        is_catalog: false,
      },

      launchDate: "2026-02-15",
      tags: ["testing", "demo"],

      spend: 1640,
      purchaseValue: 5180,
      roas: 3.16,
      cpa: 27.8,
      ctrAll: 2.33,
      purchases: 59,
    },
  ],
};

export const MOCK_SHARE_URL = "/share/creative/mock-token-123";
