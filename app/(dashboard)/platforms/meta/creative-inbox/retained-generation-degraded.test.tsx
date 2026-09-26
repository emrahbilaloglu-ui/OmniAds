import { useQuery } from "@tanstack/react-query";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";
import { GET } from "@/app/api/creatives/briefing/route";
import type { CreativesBriefingResponse } from "@/components/creatives/briefing/types";
import { requireBusinessAccess } from "@/lib/access";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { ENTITY_ROLE_DECLARATION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/campaign-context/entity-role";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { getDb } from "@/lib/db";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  buildMetaDecisionPipelineHealthFromCanonicalInventory,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
import type {
  MetaNativeDecisionGenerationSourceRow,
  MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { readTriageState } from "@/lib/triage-events";

/**
 * D3 — ONE FAILED NATIVE RUN USED TO EMPTY THE WHOLE INBOX.
 *
 * When the latest native decision run fails, the briefing now serves the last
 * successful generation of the same epoch as `canonicalDecisionInventory.status
 * = "degraded"` (D102), every decision stripped of execution authority. The
 * Inbox's fetch accepted only `available`/`unavailable`, so that response
 * threw "Creative decision inventory could not be verified." and the board
 * showed an error over decisions the server had served.
 *
 * Nothing on these cards is hand-written. Each case runs the page's own
 * `fetchCreativeInbox` against the REAL `GET /api/creatives/briefing`, which
 * runs the REAL canonical inventory reader over mocked generation/snapshot
 * rows, the REAL request-time governance and the REAL briefing projection.
 * Only I/O is mocked: access, flags, the DB rows, the creative metric rows,
 * triage, write governance and operational health — the last two reported
 * fully ready, the worst case for a retained Cut.
 *
 * The retained generation is for 2026-09-22 and was computed at 03:00 on the
 * 23rd; the failed run is for 2026-09-23. At noon on the 23rd the retained
 * Cut is nine hours old, so freshness is not what keeps it out of Action now.
 */

const queryState = vi.hoisted(() => ({
  inbox: undefined as unknown,
  inboxError: null as Error | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/meta/creative-inbox",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
    }) => unknown,
  ) => selector({ selectedBusinessId: null, workspaceResolved: true }),
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));
vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
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
    creative_id: `creative_${adId.slice(-4)}`,
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

function mockNativeDb(generationRows: MetaNativeDecisionGenerationSourceRow[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("to_regclass('meta_entity_role_declarations')")) {
      return [{ table_name: "meta_entity_role_declarations" }];
    }
    if (sql.includes("FROM meta_entity_role_declarations")) {
      return [{
        id: "50000000-0000-4000-8000-000000000001",
        business_id: "biz_1",
        provider_account_id: "act_1",
        entity_type: "adset",
        entity_id: "adset_1",
        parent_campaign_id: "cmp_1",
        event: "declare",
        declared_role: "main",
        effective_from: RETAINED_AS_OF,
        declared_at: "2026-09-22T01:00:00.000Z",
        declared_by: "fixture_operator",
        reason: "Known before retained generation",
        contract_version: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
      }];
    }
    if (sql.includes("WITH candidate_runs AS")) return generationRows;
    if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
      return RETAINED_ROWS;
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

/** The `queryFn` the page handed react-query for the briefing read. */
function capturedInboxQueryFn() {
  const call = vi
    .mocked(useQuery)
    .mock.calls.find(
      (args) =>
        (args[0] as { queryKey?: readonly unknown[] }).queryKey?.[0] ===
        "creative-account-inbox",
    );
  return (call?.[0] as { queryFn?: () => Promise<unknown> } | undefined)
    ?.queryFn;
}

function plain(fragment: string) {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
  );
}

/**
 * The page's own briefing read, served by the real route, then the page
 * rendered from what that read returned — or from the error it threw.
 */
async function readThroughInbox(
  generationRows: MetaNativeDecisionGenerationSourceRow[],
  tamper?: (payload: CreativesBriefingResponse) => void,
) {
  mockNativeDb(generationRows);
  queryState.inbox = undefined;
  queryState.inboxError = null;
  renderPage();
  const queryFn = capturedInboxQueryFn();
  expect(queryFn).toBeTypeOf("function");
  const requested: string[] = [];
  let served: CreativesBriefingResponse | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const response = await GET(
        new NextRequest(new URL(String(input), "http://localhost")),
      );
      served = (await response.json()) as CreativesBriefingResponse;
      tamper?.(served);
      const body = served;
      return {
        ok: response.ok,
        status: response.status,
        json: async () => body,
      };
    }),
  );
  let result: unknown;
  let error: Error | null = null;
  try {
    result = await queryFn!();
  } catch (caught) {
    error = caught as Error;
  } finally {
    vi.unstubAllGlobals();
  }
  queryState.inbox = result;
  queryState.inboxError = error;
  const html = renderPage();
  const column = (segment: "action-now" | "watching" | "healthy") => {
    const start = html.indexOf(`data-inbox-column="${segment}"`);
    if (start < 0) return null;
    const next = html.indexOf("data-inbox-column=", start + 1);
    return next > 0 ? html.slice(start, next) : html.slice(start);
  };
  const ids = (segment: "action-now" | "watching" | "healthy") =>
    [...(column(segment) ?? "").matchAll(/data-inbox-card="([^"]+)"/g)].map(
      (match) => match[1],
    );
  const card = (id: string) => {
    const start = html.indexOf(`data-inbox-card="${id}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    const markup = html.slice(start, html.indexOf("</article>", start));
    const chip = markup.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    const fact = (label: string) => {
      const match = markup.match(
        new RegExp(`data-inbox-fact="${label}"[^>]*>([\\s\\S]*?)</span>`),
      );
      return match ? plain(match[1]!) : null;
    };
    return { chip: plain(chip?.[1] ?? ""), text: plain(markup), fact };
  };
  const banners = [
    ...html.matchAll(
      /<p[^>]*data-inbox-decision-availability="degraded"[^>]*>([\s\S]*?)<\/p>/g,
    ),
  ];
  return {
    html,
    served: served as CreativesBriefingResponse | null,
    result: result as
      { canonicalDecisionInventory?: { status?: string } | null } | undefined,
    error,
    requested,
    column,
    ids,
    card,
    banners,
  };
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
  // Write governance and operations both report ready: nothing but the
  // failed run can keep the retained Cut out of Action now.
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
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockImplementation(((options: {
    queryKey: readonly unknown[];
  }) => {
    const inbox = options.queryKey[0] === "creative-account-inbox";
    const data = inbox ? queryState.inbox : [];
    const error = inbox ? queryState.inboxError : null;
    return {
      data,
      error,
      isError: Boolean(error),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      status: error ? "error" : data ? "success" : "pending",
    } as unknown as ReturnType<typeof useQuery>;
  }) as typeof useQuery);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Creative Inbox — retained generation after a failed latest run (D3/D102)", () => {
  it("CONTROL: the same generation as the latest success is current, with its authorized Cut in Action now", async () => {
    const read = await readThroughInbox([successfulRun()]);

    expect(read.error).toBeNull();
    expect(read.served?.source?.canonicalDecisionInventory?.status).toBe(
      "available",
    );
    expect(read.html).toContain('data-inbox-state="ready"');
    expect(read.ids("action-now")).toEqual([CUT_AD]);
    expect(read.card(CUT_AD).chip).toBe("Cut");
    expect(read.banners).toHaveLength(0);
  });

  it("shows the served cards under one banner naming both runs, with nothing in Action now", async () => {
    const read = await readThroughInbox([
      failedRun(),
      successfulRun({ selection: "last_success" }),
    ]);

    // The real route served the retained generation, degraded and stripped.
    const inventory = read.served?.source?.canonicalDecisionInventory;
    expect(inventory).toMatchObject({
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
    expect(read.served?.actionNow).toEqual([]);
    // A current read: the page states no decision day, so the route may serve
    // the retained generation.
    expect(read.requested).toHaveLength(1);
    expect(
      new URL(read.requested[0]!, "http://x").searchParams.has("asOf"),
    ).toBe(false);

    // The fetch accepted it instead of throwing.
    expect(read.error).toBeNull();
    expect(read.result?.canonicalDecisionInventory?.status).toBe("degraded");
    expect(read.html).toContain('data-inbox-state="ready"');
    expect(read.html).not.toContain(
      "Creative data is temporarily unavailable.",
    );

    // One banner, both days, read-only.
    expect(read.banners).toHaveLength(1);
    const banner = read.banners[0]![0]!;
    expect(banner).toContain(`data-inbox-retained-as-of="${RETAINED_AS_OF}"`);
    expect(banner).toContain(`data-inbox-failed-run-as-of="${FAILED_AS_OF}"`);
    expect(plain(read.banners[0]![1]!)).toBe(
      "The latest decision run (as of 2026-09-23) failed. These decisions are " +
        "from the last successful run (as of 2026-09-22), read-only, and " +
        "cannot be applied until a current run succeeds.",
    );
    // The banner sits above the board, not inside a card.
    expect(read.html.indexOf("data-inbox-decision-availability")).toBeLessThan(
      read.html.indexOf("data-inbox-column="),
    );

    // Every served card is on the board, in the section it was served in;
    // Action now is empty.
    expect(read.ids("action-now")).toEqual([]);
    expect(read.ids("watching")).toEqual([CUT_AD]);
    expect(read.ids("healthy")).toEqual([KEEP_AD]);
    expect(read.card(KEEP_AD).chip).toBe("Protect");
    // The retained Cut is not presented as a ready Cut.
    const cut = read.card(CUT_AD);
    expect(cut.chip).toBe("Cut · Not ready to apply");
    expect(cut.fact("Readiness")).toBe("Readiness Review only");
    expect(cut.text).toContain(
      "Not in Action now because the latest decision run failed; this is the last completed run.",
    );
  });

  it("still reports a failed latest run with no retained generation as unavailable", async () => {
    const read = await readThroughInbox([failedRun()]);

    expect(read.served?.source?.canonicalDecisionInventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
    expect(read.error).toBeNull();
    expect(read.html).toContain('data-inbox-state="error"');
    expect(read.html).toContain("Creative data is temporarily unavailable.");
    expect(read.column("watching")).toBeNull();
    expect(read.banners).toHaveLength(0);
  });

  it("drops cached retained cards when the refetch fails, rather than showing them without the banner", async () => {
    const read = await readThroughInbox([
      failedRun(),
      successfulRun({ selection: "last_success" }),
    ]);
    expect(read.error).toBeNull();
    // The query keeps the verified degraded data from the last good fetch and
    // reports the refetch's error beside it.
    queryState.inbox = read.result;
    queryState.inboxError = new Error("Creative inbox could not load.");

    const html = renderPage();

    expect(html).toContain('data-inbox-state="error"');
    expect(html).not.toContain("data-inbox-decision-availability");
    expect(html).not.toContain(`data-inbox-card="${CUT_AD}"`);
    expect(html).not.toContain(`data-inbox-card="${KEEP_AD}"`);
  });

  it("draws no retained board whose held data places a card in Action now", async () => {
    const read = await readThroughInbox([
      failedRun(),
      successfulRun({ selection: "last_success" }),
    ]);
    expect(read.error).toBeNull();
    // What the page holds, with the retained Cut moved into Action now: data
    // that did not come through the fetch's own check.
    const held = read.result as unknown as {
      inbox: Array<{ id: string; briefingSegment: string }>;
    };
    queryState.inbox = {
      ...held,
      inbox: held.inbox.map((card) =>
        card.id === CUT_AD ? { ...card, briefingSegment: "action-now" } : card,
      ),
    };

    const html = renderPage();

    expect(html).toContain('data-inbox-state="error"');
    expect(html).not.toContain("data-inbox-decision-availability");
    expect(html).not.toContain(`data-inbox-card="${CUT_AD}"`);
  });

  it.each([
    [
      "offers an Action now card",
      (payload: CreativesBriefingResponse) => {
        payload.actionNow = [payload.watching![0]!];
      },
    ],
    [
      "does not name its runs",
      (payload: CreativesBriefingResponse) => {
        delete payload.source!.canonicalDecisionInventory!.degradation;
      },
    ],
    [
      "names a served run that is not its generation",
      (payload: CreativesBriefingResponse) => {
        payload.source!.canonicalDecisionInventory!.degradation!.servedGeneration.jobRunId =
          FAILED_RUN_ID;
      },
    ],
    [
      "names a latest run that did not fail",
      (payload: CreativesBriefingResponse) => {
        payload.source!.canonicalDecisionInventory!.degradation!.latestTerminalRun.status =
          "success";
      },
    ],
  ])(
    "refuses a degraded response that %s instead of drawing it",
    async (_name, tamper) => {
      const read = await readThroughInbox(
        [failedRun(), successfulRun({ selection: "last_success" })],
        tamper,
      );

      expect(read.error?.message).toBe(
        "Creative decision inventory could not be verified.",
      );
      expect(read.html).toContain('data-inbox-state="error"');
      expect(read.banners).toHaveLength(0);
      expect(read.html).not.toContain(`data-inbox-card="${CUT_AD}"`);
    },
  );
});
