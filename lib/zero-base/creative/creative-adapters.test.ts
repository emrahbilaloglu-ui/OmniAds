import { describe, expect, it } from "vitest";

import {
  ENGINE_POSTURES,
  creativeActionCount,
  postureView,
  resolveEnginePosture,
} from "@/lib/zero-base/creative/engine-posture";
import {
  buildPerformanceViewModel,
  creativeDetailHref,
  decisionsHrefForCreative,
  hasUsableIdentity,
  mediaStateFor,
  toMetric,
  type ServedCreativeRow,
} from "@/lib/zero-base/creative/performance-adapter";
import {
  buildEvidence,
  buildHistory,
  decisionBand,
  resolveDetail,
} from "@/lib/zero-base/creative/detail-adapter";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

function row(overrides: Partial<ServedCreativeRow> = {}): ServedCreativeRow {
  return {
    id: "r1",
    creative_id: "cr-1",
    real_ad_id: "ad-1",
    account_id: "act_1",
    account_name: "Main",
    campaign_id: "camp-1",
    campaign_name: "Prospecting",
    adset_id: "adset-1",
    adset_name: "Broad",
    name: "Creative One",
    currency: "USD",
    launch_date: "2026-07-01",
    spend: 1234.5,
    roas: 3.4,
    cpa: 12.25,
    purchases: 42,
    impressions: 900,
    preview_status: "ready",
    preview_origin: "snapshot",
    cached_thumbnail_url: "https://cdn.example/x.jpg",
    ...overrides,
  };
}

function canonicalDecision(input: {
  adId: string;
  creativeId?: string;
  buyerLabel?: string;
}): MetaCanonicalDecision {
  return {
    providerAccountId: "act_1",
    parentChain: {
      ad: { id: input.adId, name: input.adId },
      creative: { id: input.creativeId ?? "cr-1", name: "Creative One" },
    },
    classification: {
      buyerAction: "scale",
      buyerLabel: input.buyerLabel ?? "Scale",
      decisionState: "act",
    },
    metrics: { effectiveTargetRoas: 3.2 },
  } as unknown as MetaCanonicalDecision;
}

function osDecision(input: {
  adId: string;
  creativeId?: string;
  label?: string;
}): MetaOsAdDecision {
  return {
    providerAccountId: "act_1",
    adId: input.adId,
    creativeId: input.creativeId ?? "cr-1",
    action: { code: "review", label: input.label ?? "Review served evidence" },
    lane: "monitor",
    metrics: { effectiveTargetRoas: 3.2 },
  } as unknown as MetaOsAdDecision;
}

/* ------------------------------------------------------- the five postures */

describe("all five Engine V3 postures", () => {
  it("names exactly five", () => {
    expect([...ENGINE_POSTURES]).toEqual([
      "unavailable",
      "disabled",
      "shadow_only",
      "hidden",
      "serving",
    ]);
  });

  it("resolves each one from what the server served", () => {
    const flags = (o: Partial<{ enabled: boolean; surfaceVisible: boolean; shadowOnly: boolean }>) => ({
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
      ...o,
    });
    expect(resolveEnginePosture({ status: "unavailable", flags: null })).toBe("unavailable");
    expect(resolveEnginePosture({ status: "serving", flags: null })).toBe("unavailable");
    expect(resolveEnginePosture({ status: "disabled", flags: flags({}) })).toBe("disabled");
    expect(resolveEnginePosture({ status: "serving", flags: flags({ enabled: false }) })).toBe("disabled");
    expect(resolveEnginePosture({ status: "serving", flags: flags({ shadowOnly: true }) })).toBe("shadow_only");
    expect(resolveEnginePosture({ status: "serving", flags: flags({ surfaceVisible: false }) })).toBe("hidden");
    expect(resolveEnginePosture({ status: "serving", flags: flags({}) })).toBe("serving");
  });

  it("treats a visible shadow decision as shadow, not serving", () => {
    // The most dangerous of the five confusions: a shadow decision that happens
    // to be visible is still one nobody stands behind.
    expect(
      resolveEnginePosture({
        status: "serving",
        flags: { enabled: true, surfaceVisible: true, shadowOnly: true },
      }),
    ).toBe("shadow_only");
  });

  it("explains every posture and marks only serving as authority", () => {
    for (const posture of ENGINE_POSTURES) {
      const view = postureView(posture);
      expect(view.explanation.length, posture).toBeGreaterThan(20);
      expect(view.decisionsAreAuthority, posture).toBe(posture === "serving");
    }
  });
});

describe("shadow and held actions offer zero affordances", () => {
  it("offers none in any posture except serving", () => {
    for (const posture of ENGINE_POSTURES) {
      const count = creativeActionCount({ posture, held: false, viewerCanAct: true });
      expect(count, posture).toBe(posture === "serving" ? 1 : 0);
    }
  });

  it("offers none for a held decision even while serving", () => {
    expect(creativeActionCount({ posture: "serving", held: true, viewerCanAct: true })).toBe(0);
  });

  it("offers none to a viewer who cannot act", () => {
    expect(creativeActionCount({ posture: "serving", held: false, viewerCanAct: false })).toBe(0);
  });
});

/* --------------------------------------------------------------- metrics */

describe("a missing metric is never a zero", () => {
  it("reports absence with a reason", () => {
    for (const absent of [null, undefined, Number.NaN, Infinity]) {
      const metric = toMetric(absent as number | null, String);
      expect(metric.available).toBe(false);
      expect(!metric.available && metric.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps a real zero as a measurement", () => {
    const metric = toMetric(0, (v) => v.toFixed(2));
    expect(metric.available).toBe(true);
    expect(metric.available && metric.raw).toBe(0);
  });

  it("never silently substitutes a currency", () => {
    const model = buildPerformanceViewModel({
      rows: [row({ currency: null })],
      posture: "serving",
      defaultCurrency: null,
    });
    const spend = model.rows[0].spend;
    expect(spend.available && spend.display).toContain("currency not served");
    expect(spend.available && spend.display).not.toContain("$");
  });

  it("formats money in the account's own currency", () => {
    const model = buildPerformanceViewModel({ rows: [row({ currency: "try" })], posture: "serving" });
    expect(model.rows[0].spend.available && model.rows[0].spend.display).toContain("TRY");
  });
});

describe("canonical creative decisions keep Ad identity intact", () => {
  it("uses a one-to-one creative fallback when the warehouse Ad id is synthetic", () => {
    const model = buildPerformanceViewModel({
      rows: [row({ real_ad_id: "creative_cr-1" })],
      canonicalDecisions: [canonicalDecision({ adId: "real-ad-7" })],
      posture: "serving",
    });

    expect(model.rows[0].adId).toBe("real-ad-7");
    expect(model.rows[0].decision?.kind).toBe("single");
    expect(model.rows[0].decision?.buyerLabel).toBe("Scale");
  });

  it("does not pick an arbitrary Ad when one creative maps to several", () => {
    const model = buildPerformanceViewModel({
      rows: [row({ real_ad_id: "creative_cr-1" })],
      canonicalDecisions: [
        canonicalDecision({ adId: "real-ad-7", buyerLabel: "Scale" }),
        canonicalDecision({ adId: "real-ad-8", buyerLabel: "Refresh" }),
      ],
      posture: "serving",
    });

    expect(model.rows[0].adId).toBeNull();
    expect(model.rows[0].decision?.kind).toBe("multiple");
    expect(model.rows[0].decision?.items.map((item) => item.adId)).toEqual([
      "real-ad-7",
      "real-ad-8",
    ]);
  });

  it("prefers an exact real-Ad match even when the creative has several Ads", () => {
    const model = buildPerformanceViewModel({
      rows: [row({ real_ad_id: "real-ad-8" })],
      canonicalDecisions: [
        canonicalDecision({ adId: "real-ad-7", buyerLabel: "Scale" }),
        canonicalDecision({ adId: "real-ad-8", buyerLabel: "Refresh" }),
      ],
      posture: "serving",
    });

    expect(model.rows[0].adId).toBe("real-ad-8");
    expect(model.rows[0].decision?.kind).toBe("single");
    expect(model.rows[0].decision?.buyerLabel).toBe("Refresh");
  });

  it("keeps the server OS decision visible as review-only fallback when native inventory is unavailable", () => {
    const model = buildPerformanceViewModel({
      rows: [row({ real_ad_id: "creative_cr-1" })],
      canonicalDecisions: [],
      servedOsDecisions: [osDecision({ adId: "real-ad-9" })],
      posture: "shadow_only",
    });

    expect(model.rows[0].adId).toBe("real-ad-9");
    expect(model.rows[0].decision?.buyerLabel).toBe("Review served evidence");
    expect(model.rows[0].decision?.decisionState).toBe("monitor");
  });
});

/* ------------------------------------------------ legacy null-identity filter */

describe("the legacy null filter is preserved and disclosed", () => {
  it("drops rows with no creative identity", () => {
    expect(hasUsableIdentity(row())).toBe(true);
    expect(hasUsableIdentity(row({ creative_id: "" }))).toBe(false);
    expect(hasUsableIdentity(row({ account_id: "  " }))).toBe(false);
  });

  it("counts the exclusion instead of hiding it", () => {
    const model = buildPerformanceViewModel({
      rows: [row(), row({ id: "r2", creative_id: "" }), row({ id: "r3", account_id: "" })],
      posture: "serving",
    });
    expect(model.rows).toHaveLength(1);
    expect(model.disclosure.excludedForMissingIdentity).toBe(2);
    expect(model.disclosure.text).toMatch(/2 rows omitted because no creative identity/);
  });
});

/* ------------------------------------------------------------ cap disclosure */

describe("caps are disclosed, never implied", () => {
  it("states the cap when the server served a larger total", () => {
    const model = buildPerformanceViewModel({ rows: [row()], totalAvailable: 120, posture: "serving" });
    expect(model.disclosure.capped).toBe(true);
    expect(model.disclosure.text).toMatch(/Showing 1 of 120/);
  });

  it("says the backend supplied no total rather than claiming all", () => {
    const model = buildPerformanceViewModel({ rows: [row()], posture: "serving" });
    expect(model.disclosure.text).toMatch(/did not supply a total/);
    expect(model.disclosure.text).not.toMatch(/\ball\b/);
  });

  it("says all only when the total confirms it", () => {
    const model = buildPerformanceViewModel({ rows: [row()], totalAvailable: 1, posture: "serving" });
    expect(model.disclosure.capped).toBe(false);
    expect(model.disclosure.text).toMatch(/all 1 creatives/);
  });
});

/* ---------------------------------------------------------------- media */

describe("missing media is named, not blank", () => {
  it("reports a missing preview with a reason", () => {
    const state = mediaStateFor(row({ preview_status: "missing", cached_thumbnail_url: null, thumbnail_url: null }));
    expect(state.kind).toBe("missing");
    expect(state.kind === "missing" && state.reason).toMatch(/No preview/);
  });

  it("treats an empty url as missing even when the status says ready", () => {
    expect(mediaStateFor(row({ cached_thumbnail_url: "", thumbnail_url: "" })).kind).toBe("missing");
  });

  it("prefers the cached url and keeps its origin", () => {
    const state = mediaStateFor(row());
    expect(state.kind === "ready" && state.url).toBe("https://cdn.example/x.jpg");
    expect(state.kind === "ready" && state.origin).toBe("snapshot");
  });
});

/* ------------------------------------------------------------------ links */

describe("the Decisions link retains every identifier", () => {
  it("carries account, creative and the ad-keyed row", () => {
    const href = decisionsHrefForCreative({
      businessId: "biz-1",
      row: { creativeId: "cr-1", adId: "ad-1", accountId: "act_1" },
    });
    const url = new URL(href, "https://x");
    expect(url.pathname).toBe("/app/meta/decisions");
    expect(url.searchParams.get("providerAccountId")).toBe("act_1");
    expect(url.searchParams.get("creativeId")).toBe("cr-1");
    // The decision universe is keyed by ad; without it the link is a search.
    expect(url.searchParams.get("row")).toBe("ad:ad-1");
  });

  it("omits the row key rather than inventing one when no ad id was served", () => {
    const href = decisionsHrefForCreative({
      businessId: "biz-1",
      row: { creativeId: "cr-1", adId: null, accountId: "act_1" },
    });
    expect(new URL(href, "https://x").searchParams.get("row")).toBeNull();
  });

  it("scopes the detail link to the account the row belongs to", () => {
    const href = creativeDetailHref({ businessId: "biz-1", creativeId: "cr-1", accountId: "act_2" });
    const url = new URL(href, "https://x");
    expect(url.pathname).toBe("/app/creative/cr-1");
    expect(url.searchParams.get("providerAccountId")).toBe("act_2");
  });

  it("escapes identifiers rather than concatenating them raw", () => {
    const href = creativeDetailHref({ businessId: "biz/1", creativeId: "cr 1", accountId: "act_1" });
    expect(href).not.toContain("biz%2F1");
    expect(href).toContain("cr%201");
  });
});

/* ----------------------------------------------- detail belongs to the URL */

describe("a deep-linked detail belongs to the URL business and account", () => {
  const rows = [row(), row({ id: "r2", creative_id: "cr-1", account_id: "act_other" })];

  it("resolves the row in the URL's account", () => {
    const result = resolveDetail({ creativeId: "cr-1", accountId: "act_1", rows });
    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.row.account_id).toBe("act_1");
  });

  it("refuses a creative that belongs to another account", () => {
    const result = resolveDetail({ creativeId: "cr-1", accountId: "act_third", rows });
    // Rendering it would put another account's creative inside this workspace.
    expect(result.kind).toBe("not_in_scope");
    expect(result.kind === "not_in_scope" && result.reason).toMatch(/different ad account/);
  });

  it("distinguishes not-in-scope from not-found", () => {
    const missing = resolveDetail({ creativeId: "cr-none", accountId: "act_1", rows });
    expect(missing.kind).toBe("not_found");
  });
});

/* --------------------------------------------------------- band and evidence */

describe("the decision band comes from the served posture, never from a metric", () => {
  it("offers no band unless the engine is serving", () => {
    for (const posture of ENGINE_POSTURES) {
      const band = decisionBand({
        posture,
        postureExplanation: "because",
        servedLabel: "scale",
        servedDetail: null,
      });
      expect(band.kind, posture).toBe(posture === "serving" ? "band" : "none");
    }
  });

  it("offers no band when the engine served no label for this creative", () => {
    const band = decisionBand({
      posture: "serving",
      postureExplanation: "x",
      servedLabel: null,
      servedDetail: null,
    });
    expect(band.kind).toBe("none");
    expect(band.kind === "none" && band.reason).toMatch(/served no decision/);
  });

  it("passes the served label through without reformatting it", () => {
    const band = decisionBand({
      posture: "serving",
      postureExplanation: "x",
      servedLabel: "Scale up — 7-day ROAS 3.4",
      servedDetail: "detail",
    });
    expect(band.kind === "band" && band.label).toBe("Scale up — 7-day ROAS 3.4");
  });

  it("omits evidence fields the server did not send", () => {
    const items = buildEvidence(row({ campaign_name: null, adset_name: "  " }));
    const labels = items.map((item) => item.label);
    expect(labels).not.toContain("Campaign");
    expect(labels).not.toContain("Ad set");
    expect(labels).toContain("Creative id");
    for (const item of items) expect(item.source.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- history */

describe("history keeps replay and actor provenance", () => {
  const built = buildHistory([
    { id: "h1", occurredAt: "t1", label: "Decided scale", detail: null, actor: "ada@example.com" },
    { id: "h2", occurredAt: "t2", label: "Decided cut", detail: null, replayedAt: "t3", engineVersion: "v3" },
  ]);

  it("marks a replayed entry and raises the banner", () => {
    expect(built.rows[1].replayed).toBe(true);
    expect(built.anyReplayed).toBe(true);
  });

  it("does not raise the banner when nothing was replayed", () => {
    expect(buildHistory([{ id: "h1", occurredAt: "t", label: "x", detail: null }]).anyReplayed).toBe(false);
  });

  it("says the actor was not recorded rather than attributing it to the system", () => {
    expect(built.rows[1].actor).toBe("Actor not recorded");
    expect(built.rows[1].actor).not.toMatch(/system/i);
  });
});

/* ------------------------------------------------------------ route scope */

describe("URL scope", () => {
  it("reads the account and window from the URL", () => {
    const scope = scopeFromSearchParams(
      { providerAccountId: "act_9", start: "2026-01-01", end: "2026-01-31" },
      { start: "x", end: "y" },
    );
    expect(scope).toEqual({ providerAccountId: "act_9", start: "2026-01-01", end: "2026-01-31" });
  });

  it("falls back rather than passing a malformed date to a read model", () => {
    const scope = scopeFromSearchParams({ start: "yesterday" }, { start: "2026-07-15", end: "2026-08-11" });
    expect(scope.start).toBe("2026-07-15");
  });

  it("defaults to a 28-day window", () => {
    const window = defaultCreativeWindow(new Date("2026-08-11T00:00:00Z"));
    expect(window).toEqual({ start: "2026-07-15", end: "2026-08-11" });
  });
});
