// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CreativeStudioPage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { GET } from "@/app/api/creatives/briefing/route";
import type { CreativesBriefingResponse } from "@/components/creatives/briefing/types";
import { requireBusinessAccess } from "@/lib/access";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { getDb } from "@/lib/db";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { groupRows } from "@/lib/meta/creatives-row-mappers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import {
  buildCreativeUsageMap,
  buildFallbackAdRawRow,
  hydrateWarehouseCreativeMetrics,
} from "@/lib/meta/creatives-warehouse";
import {
  buildMetaDecisionPipelineHealthFromCanonicalInventory,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
import type {
  MetaNativeDecisionGenerationSourceRow,
  MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import type { MetaAdDailyRow } from "@/lib/meta/warehouse-types";
import { readTriageState } from "@/lib/triage-events";

/**
 * D3 — ONE FAILED NATIVE RUN USED TO BLANK EVERY STATUS CELL IN CREATIVE STUDIO.
 *
 * When the latest native decision run fails, the briefing now serves the last
 * successful generation of the same epoch as `canonicalDecisionInventory.status
 * = "degraded"` (D102), every decision stripped of execution authority. The
 * Studio read anything but `available` as unavailable: the Status column
 * disappeared and the page said recommendations were unavailable, although the
 * server had served them.
 *
 * Nothing here is hand-written on the served side. The page's own briefing
 * `queryFn` is answered by the REAL `GET /api/creatives/briefing`, which runs
 * the REAL canonical inventory reader over mocked generation/snapshot rows,
 * the REAL governance and the REAL projection. The table rows come from the
 * warehouse chain: ad-days -> buildFallbackAdRawRow / hydrate ->
 * groupRows("creative") -> buildMetaCreativeApiRow.
 *
 * The retained generation is for 2026-09-22; the failed run is for 2026-09-23.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  creatives: undefined as unknown,
  briefing: undefined as unknown,
  sharedLinks: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1", businesses: [] }),
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));
vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: "2026-08-24",
      customEnd: "2026-09-22",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));
vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// The briefing route's I/O, mocked exactly as its own route test mocks it.
vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(async () => false),
}));
vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => ["act_1"]),
}));
vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  readEffectiveMetaWriteGovernance: vi.fn(),
}));
vi.mock("@/lib/meta/decision-pipeline-health", () => ({
  readMetaDecisionPipelineOperationalHealth: vi.fn(),
  buildMetaDecisionPipelineHealthFromCanonicalInventory: vi.fn(),
}));
vi.mock("@/lib/triage-events", () => ({ readTriageState: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => {
  const getDb = vi.fn();
  return {
    ...(await importOriginal<typeof import("@/lib/db")>()),
    getDb,
    getDbWithTimeout: vi.fn(() => getDb()),
  };
});

const NOW = new Date("2026-09-23T12:00:00.000Z");
const RETAINED_AS_OF = "2026-09-22";
const FAILED_AS_OF = "2026-09-23";
const RETAINED_RUN_ID = "20000000-0000-4000-8000-000000000922";
const FAILED_RUN_ID = "20000000-0000-4000-8000-000000000923";
const ACCOUNT_REF = "30000000-0000-4000-8000-000000000001";
const CUT_AD = "120000000000001901";
const KEEP_AD = "120000000000001902";
const AD_IDS = [CUT_AD, KEEP_AD];
const CUT_NAME = "Retained cut";
const KEEP_NAME = "Retained keep";

/** A config receipt lineage the read model validates (D099/D100). */
function verifiedConfigLineage() {
  const receipt = (field: string) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier: "provider_receipt_point_in_day",
    readiness: "review_only",
    sourceClass: "modern",
    pitClass: "as_of_known",
    sourceSnapshotId: "11111111-1111-4111-8111-111111111111",
    observationId: "33333333-3333-4333-8333-333333333333",
    observedAt: "2026-09-22T04:00:00.000Z",
    fieldScopeHash: "a".repeat(64),
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  });
  return {
    contractVersion: "engine-v3-canonical-ad-evaluation.v12",
    refs: {
      objective: receipt("objective"),
      optimization_goal: receipt("optimization_goal"),
      custom_event_type: receipt("custom_event_type"),
      custom_conversion_id: {
        ...receipt("custom_conversion_id"),
        normalizationVersion: null,
        tier: "unknown",
        readiness: "none",
        sourceClass: "none",
        pitClass: null,
        sourceSnapshotId: null,
        observationId: null,
        observedAt: null,
        fieldScopeHash: null,
      },
    },
    refRefusals: {},
    lineageSupplied: true,
    receiptManifest: {
      manifestVersion: "meta-config-receipt-window-manifest.v1",
      refContractVersion: "meta-config-field-evidence-ref.v1",
      hash: "c".repeat(64),
      economicDayCount: 3,
      nullObservationIdCount: 0,
      incoherentDayCount: 0,
    },
    currentConfigDay: RETAINED_AS_OF,
    metricContract: {
      funnelStage: "meta-funnel-stage.v1",
      windowRule: "meta-metric-window.complete-or-null.v1",
      adDayLinkClick: "meta-ad-day-link-click.v1",
    },
  };
}

function creativeIdFor(adId: string) {
  return `creative_${adId.slice(-4)}`;
}

/** One persisted native snapshot row of the retained generation. */
function snapshotRow(
  adId: string,
  overrides: Partial<MetaNativeDecisionSnapshotSourceRow>,
): MetaNativeDecisionSnapshotSourceRow {
  return {
    snapshot_id: `00000000-0000-4000-8000-${adId.slice(-12)}`,
    evaluation_id: `10000000-0000-4000-8000-${adId.slice(-12)}`,
    job_run_id: RETAINED_RUN_ID,
    provider_account_ref_id: ACCOUNT_REF,
    provider_account_id: "act_1",
    ad_id: adId,
    creative_id: creativeIdFor(adId),
    as_of_date: RETAINED_AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "act_1",
    label: "cut",
    pre_authority_label: "cut",
    authority_blocker: null,
    raw_label: "cut",
    confidence: 88,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: `${adId} is below the account target.`,
    spend: 120,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: "cut",
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: "2026-09-23T03:00:00.000Z",
    episode_started_at: RETAINED_AS_OF,
    lineage_valid: true,
    creative_name: `Creative ${adId.slice(-4)}`,
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_name: `Ad ${adId}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: null,
    media_source_present: true,
    media_available: false,
    media_source: "meta_creative_media",
    source_updated_at: "2026-09-23T02:00:00.000Z",
    config_authority_verified: true,
    config_evidence_lineage: verifiedConfigLineage(),
    ...overrides,
  } as MetaNativeDecisionSnapshotSourceRow;
}

/** The retained generation: an AUTHORIZED Cut and a Keep. */
const RETAINED_ROWS = [
  snapshotRow(CUT_AD, {}),
  snapshotRow(KEEP_AD, {
    label: "keep",
    pre_authority_label: "keep",
    raw_label: "keep",
    authorized_action: null,
    confidence: 72,
    ratio_to_target: 1.3,
    roas: 2.6,
    recent7d_roas: 2.5,
    reason: `${KEEP_AD} holds the account target.`,
  }),
];

const manifestHash = hashAdDecisionIdentityManifest({
  businessId: "biz_1",
  providerAccountId: "act_1",
  asOfDate: RETAINED_AS_OF,
  adIds: AD_IDS,
});

/** A complete successful generation receipt for the retained run. */
function successfulRun(
  overrides: Partial<MetaNativeDecisionGenerationSourceRow> = {},
): MetaNativeDecisionGenerationSourceRow {
  return {
    selection: "latest",
    job_status: "success",
    job_run_id: RETAINED_RUN_ID,
    as_of_date: RETAINED_AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    provider_account_ref_id: ACCOUNT_REF,
    provider_account_id: "act_1",
    expected_ad_count: AD_IDS.length,
    expected_manifest_hash: manifestHash,
    hydrated_ad_count: AD_IDS.length,
    hydrated_manifest_hash: manifestHash,
    authoritative_for_prune: true,
    ...overrides,
  } as MetaNativeDecisionGenerationSourceRow;
}

/** A failed run writes no receipt: every receipt column is NULL. */
function failedRun(): MetaNativeDecisionGenerationSourceRow {
  return {
    selection: "latest",
    job_status: "failed",
    job_run_id: FAILED_RUN_ID,
    as_of_date: FAILED_AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    provider_account_ref_id: null,
    provider_account_id: null,
    expected_ad_count: null,
    expected_manifest_hash: null,
    hydrated_ad_count: null,
    hydrated_manifest_hash: null,
    authoritative_for_prune: null,
  } as MetaNativeDecisionGenerationSourceRow;
}

function mockNativeDb(
  generationRows: MetaNativeDecisionGenerationSourceRow[],
  options: { adsetRoleDeclared?: boolean } = {},
) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("WITH candidate_runs AS")) return generationRows;
    if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
      return RETAINED_ROWS;
    }
    if (sql.includes("to_regclass('meta_entity_role_declarations')")) {
      return [{ table_name: "meta_entity_role_declarations" }];
    }
    if (sql.includes("FROM meta_entity_role_declarations")) {
      return options.adsetRoleDeclared === false ||
          params?.[2] !== "adset" ||
          params?.[6] !== RETAINED_RUN_ID
        ? []
        : [{
            id: "40000000-0000-4000-8000-000000000001",
            business_id: "biz_1",
            provider_account_id: "act_1",
            entity_type: "adset",
            entity_id: "adset_1",
            parent_campaign_id: "cmp_1",
            event: "declare",
            declared_role: "main",
            effective_from: "2026-09-21",
            declared_at: "2026-09-21T09:00:00.000Z",
            declared_by: "user_1",
            reason: "Test fixture: ad set role known before retained run",
            contract_version: "meta-entity-role-declaration.v1",
          }];
    }
    if (sql.includes("FROM engine_v3_campaign_context_daily")) {
      return [
        {
          campaign_id: "cmp_1",
          inferred_kind: "main",
          confidence_class: "high",
          confidence_score: 0.92,
          signal_scores_json: null,
          evidence_json: null,
          conflict_reasons_json: null,
          context_updated_at: "2026-09-21T10:00:00.000Z",
          context_as_of_date: "2026-09-21",
          resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
          kind_source: "system_inferred",
        },
      ];
    }
    return [];
  });
  vi.mocked(getDb).mockReturnValue({ query } as never);
}

function adDay(adId: string, name: string): MetaAdDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    date: RETAINED_AS_OF,
    campaignId: "cmp_1",
    adsetId: "adset_1",
    adId,
    adNameCurrent: name,
    adNameHistorical: null,
    adStatus: "ACTIVE",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 120,
    impressions: 1000,
    clicks: 50,
    reach: 800,
    frequency: null,
    conversions: 1,
    revenue: 120,
    roas: 1,
    cpa: null,
    ctr: null,
    cpc: null,
    linkClicks: 40,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    viewContent: null,
    leads: null,
    postEngagement: null,
    thruplayActions: null,
    videoViews3s: null,
    payloadJson: { creative_id: creativeIdFor(adId) },
  } as MetaAdDailyRow;
}

/** The Assets rows, through the warehouse chain at creative grain. */
function assetApiRows(): MetaCreativeApiRow[] {
  const raw = [adDay(CUT_AD, CUT_NAME), adDay(KEEP_AD, KEEP_NAME)].map(
    (factRow) =>
      hydrateWarehouseCreativeMetrics({
        row: buildFallbackAdRawRow({
          factRow,
          projectionJson: null,
          creativeId: creativeIdFor(factRow.adId),
        }),
        factRow,
      }),
  );
  return groupRows(raw, "creative", buildCreativeUsageMap(raw)).map((row) =>
    buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    }),
  );
}

function renderStudio() {
  return render(
    <CreativeStudioPage businessId="biz_1" providerAccountId="act_1" />,
  );
}

/**
 * The page's own briefing read, answered by the real route, then the page
 * rendered from what that read returned.
 */
async function readThroughStudio(
  generationRows: MetaNativeDecisionGenerationSourceRow[],
  tamper?: (payload: CreativesBriefingResponse) => void,
  options?: { adsetRoleDeclared?: boolean },
) {
  mockNativeDb(generationRows, options);
  queryState.creatives = {
    status: "ok",
    rows: assetApiRows(),
    warehouse_observed_at: null,
  };
  queryState.briefing = undefined;
  const first = renderStudio();
  const briefingCall = vi
    .mocked(useQuery)
    .mock.calls.map(
      ([options]) =>
        options as {
          queryKey?: readonly unknown[];
          queryFn?: () => Promise<unknown>;
        },
    )
    .find(
      (options) => options.queryKey?.[0] === "meta-creative-studio-briefing",
    );
  expect(briefingCall?.queryFn).toBeTypeOf("function");
  first.unmount();
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const response = await GET(
        new NextRequest(new URL(String(input), "http://localhost")),
      );
      const body = (await response.json()) as CreativesBriefingResponse;
      tamper?.(body);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => body,
      };
    }),
  );
  let served: CreativesBriefingResponse;
  try {
    served = (await briefingCall!.queryFn!()) as CreativesBriefingResponse;
  } finally {
    vi.unstubAllGlobals();
  }
  queryState.briefing = served;
  renderStudio();
  return { served, requested };
}

function headers(): string[] {
  return Array.from(document.querySelectorAll("thead th")).map(
    (cell) => cell.textContent?.replace(/[▲▼↑↓]/g, "").trim() ?? "",
  );
}

/** Each rendered row's Status cell, by rendered creative name. */
function statusByName(): Record<string, { label: string; text: string }> {
  const statusIndex = headers().indexOf("Status");
  expect(statusIndex, 'no "Status" column is on screen').toBeGreaterThan(-1);
  const result: Record<string, { label: string; text: string }> = {};
  for (const row of Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  )) {
    const name =
      row.querySelector("td:nth-child(2) span span")?.textContent?.trim() ?? "";
    const cell = Array.from(row.querySelectorAll("td"))[
      statusIndex
    ]?.querySelector("[data-creative-classification]");
    result[name] = {
      label: cell?.getAttribute("data-creative-classification") ?? "",
      text: cell?.textContent?.trim() ?? "",
    };
  }
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // The campaign role must be trusted, or the retained Cut would already be
  // review-only for an unrelated reason and prove nothing.
  vi.stubEnv(
    "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
    CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  );
  vi.stubEnv("DECISION_CENTER_DEFAULT_DISABLED", "");
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@adsecute.com" } },
    membership: {
      id: "membership_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "guest",
      status: "active",
      joinedAt: "2026-05-07T00:00:00.000Z",
    },
  } as never);
  vi.mocked(resolveEngineV3Flags).mockResolvedValue({
    businessId: "biz_1",
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
  } as never);
  vi.mocked(readTriageState).mockResolvedValue({ rows: [], deferredCount: 0 });
  vi.mocked(readEffectiveMetaWriteGovernance).mockResolvedValue({
    verified: true,
    controlsConfigured: true,
    writeBlocked: false,
    blockReason: null,
    killSwitchEngaged: false,
    killSwitchReason: null,
  } as never);
  vi.mocked(readMetaDecisionPipelineOperationalHealth).mockResolvedValue(
    {} as never,
  );
  vi.mocked(
    buildMetaDecisionPipelineHealthFromCanonicalInventory,
  ).mockReturnValue({ overall: "healthy", executionReady: true } as never);
  vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
    status: "ok",
    rows: [],
    media_mode: "metadata",
    media_hydrated: false,
  } as never);
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
  queryState.accounts = [
    { id: "act_1", name: "Main", timezone: "UTC", currency: "USD" },
  ];
  queryState.creatives = undefined;
  queryState.briefing = undefined;
  queryState.sharedLinks = undefined;
  window.localStorage.clear();
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockImplementation(((options: {
    queryKey?: readonly unknown[];
  }) => {
    const key = options.queryKey?.[0];
    const data =
      key === "meta-provider-accounts"
        ? queryState.accounts
        : key === "meta-creative-studio"
          ? queryState.creatives
          : key === "creative-share-links"
            ? queryState.sharedLinks
            : queryState.briefing;
    return {
      data,
      error: null,
      fetchStatus: "idle",
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      status: data ? "success" : "pending",
    } as unknown as ReturnType<typeof useQuery>;
  }) as typeof useQuery);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Creative Studio — retained generation after a failed latest run (D3/D102)", () => {
  it("CONTROL: the same generation as the latest success is current and named as of its own day", async () => {
    const { served } = await readThroughStudio([successfulRun()]);

    expect(served.source?.canonicalDecisionInventory?.status).toBe("available");
    const note = document.querySelector("[data-creative-decision-as-of]");
    expect(note?.textContent).toBe(
      "Recommendations as of 2026-09-22. Performance figures cover the selected date range (2026-08-24–2026-09-22). A recommendation may use a different period. When this row represents one Ad, its decision period appears under the status.",
    );
    expect(
      document.querySelector("[data-creative-decision-availability]"),
    ).toBeNull();
    expect(statusByName()[CUT_NAME]?.label).toBe("Cut");
    expect(statusByName()[KEEP_NAME]?.label).toBe("Protect");
  });

  it("does not use a Main campaign as the ad set's own role authority", async () => {
    await readThroughStudio(
      [successfulRun()],
      undefined,
      { adsetRoleDeclared: false },
    );

    expect(statusByName()[CUT_NAME]?.label).toBe("Diagnose data");
  });

  it("keeps the served decisions in the Status column under a read-only note naming both runs", async () => {
    const { served, requested } = await readThroughStudio([
      failedRun(),
      successfulRun({ selection: "last_success" }),
    ]);

    // The real route served the retained generation, degraded and stripped.
    expect(served.source?.canonicalDecisionInventory).toMatchObject({
      status: "degraded",
      unavailableReason: "native_latest_job_failed",
      generation: { jobRunId: RETAINED_RUN_ID, asOfDate: RETAINED_AS_OF },
      degradation: {
        servedGeneration: {
          jobRunId: RETAINED_RUN_ID,
          asOfDate: RETAINED_AS_OF,
        },
        latestTerminalRun: {
          jobRunId: FAILED_RUN_ID,
          status: "failed",
          asOfDate: FAILED_AS_OF,
        },
      },
    });
    expect(served.actionNow).toEqual([]);
    const url = new URL(requested[0]!, "http://x");
    expect(url.searchParams.has("asOf")).toBe(false);

    // The decisions are real and stay on screen.
    expect(headers()).toContain("Status");
    const status = statusByName();
    expect(status[CUT_NAME]?.label).toBe("Cut");
    expect(status[KEEP_NAME]?.label).toBe("Protect");

    // One note, both days, read-only; the retained day is never "as of".
    const notes = document.querySelectorAll(
      '[data-creative-decision-availability="degraded"]',
    );
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.getAttribute("data-creative-decision-retained-as-of")).toBe(
      RETAINED_AS_OF,
    );
    expect(note.getAttribute("data-creative-decision-failed-run-as-of")).toBe(
      FAILED_AS_OF,
    );
    expect(note.textContent).toBe(
      "The latest recommendation run (as of 2026-09-23) failed. These " +
        "recommendations are from the last successful run (as of " +
        "2026-09-22), read-only, and cannot be applied until a current run " +
        "succeeds. Performance figures cover the selected date range.",
    );
    expect(document.querySelector("[data-creative-decision-as-of]")).toBeNull();
    expect(document.body.textContent).not.toContain("Recommendations as of");
    expect(
      document.querySelector(
        '[data-creative-decision-availability="unavailable"]',
      ),
    ).toBeNull();
  });

  it("still reports a failed latest run with no retained generation as unavailable", async () => {
    const { served } = await readThroughStudio([failedRun()]);

    expect(served.source?.canonicalDecisionInventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
    expect(
      document.querySelector(
        '[data-creative-decision-availability="unavailable"]',
      )?.textContent,
    ).toBe(
      "Recommendations are temporarily unavailable. Creative performance is still shown below.",
    );
    expect(headers()).not.toContain("Status");
    expect(
      document.querySelector(
        '[data-creative-decision-availability="degraded"]',
      ),
    ).toBeNull();
    expect(document.querySelector("[data-creative-decision-as-of]")).toBeNull();
  });

  it("reads a degraded response that cannot name its runs as unavailable, not as current", async () => {
    await readThroughStudio(
      [failedRun(), successfulRun({ selection: "last_success" })],
      (payload) => {
        delete payload.source!.canonicalDecisionInventory!.degradation;
      },
    );

    expect(
      document.querySelector(
        '[data-creative-decision-availability="unavailable"]',
      ),
    ).not.toBeNull();
    expect(headers()).not.toContain("Status");
    expect(
      document.querySelector(
        '[data-creative-decision-availability="degraded"]',
      ),
    ).toBeNull();
    expect(document.querySelector("[data-creative-decision-as-of]")).toBeNull();
  });
});
