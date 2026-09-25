import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";
import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { ENTITY_ROLE_DECLARATION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/campaign-context/entity-role";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  applyMetaExecutionGovernanceToCanonicalDecisions,
  buildNativeMetaCanonicalDecisionInventory,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionExecutionGovernanceFacts,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";

/**
 * THE INBOX MUST NOT SHOW A CUT IT CANNOT APPLY AS A READY CUT, OR HIDE IT.
 *
 * Every card here starts where production starts: persisted native snapshot
 * rows -> `buildNativeMetaCanonicalDecisionInventory` ->
 * `applyMetaExecutionGovernanceToCanonicalDecisions` ->
 * `projectCanonicalNativeAdDecisionToBriefing` -> the briefing route's lane
 * split and sort -> this page. Nothing on a card is hand-written.
 *
 * Reviewed defects, pinned:
 *
 *   C1  A Diagnose card has no buyer action, so the projection omits its
 *       Decision Center row and the chip read "—" although the envelope
 *       serves "Diagnose data" (27 of Grandmix's 80 active cards).
 *   C2  An authorized Cut that governance, the kill switch or the 12-hour
 *       window stops — or whose hierarchy could not be confirmed — is filed
 *       in Watching and rendered as a bare "Cut" at the BOTTOM, below every
 *       held Cut.
 *   C4  A held raw Cut and a `test_more` card carrying a held Cut were told
 *       apart only by generic copy, the hold note dumped every blocker label
 *       in alphabetical order, and held Scale shared Cut's wording pattern.
 */

const queryState = vi.hoisted(() => ({ inbox: undefined as unknown }));

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

const NOW = new Date("2026-09-23T12:00:00.000Z");
const ACCOUNT = "act_1";
const JOB_RUN = "20000000-0000-4000-8000-000000000001";
const ACCOUNT_REF = "30000000-0000-4000-8000-000000000001";

const GOVERNANCE_VERIFIED: MetaDecisionExecutionGovernanceFacts = {
  verified: true,
  controlsConfigured: true,
  writeBlocked: false,
  blockReason: null,
};
const GOVERNANCE_UNAVAILABLE: MetaDecisionExecutionGovernanceFacts = {
  verified: false,
  controlsConfigured: false,
  writeBlocked: true,
  blockReason: "control_state_unavailable",
};
const KILL_SWITCHED: MetaDecisionExecutionGovernanceFacts = {
  verified: true,
  controlsConfigured: true,
  writeBlocked: true,
  blockReason: "META_ADS_WRITE_KILL_SWITCH",
};

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
    observedAt: "2026-09-23T04:00:00.000Z",
    fieldScopeHash: "a".repeat(64),
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  });
  const unknown = (field: string) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: null,
    tier: "unknown",
    readiness: "none",
    sourceClass: "none",
    pitClass: null,
    sourceSnapshotId: null,
    observationId: null,
    observedAt: null,
    fieldScopeHash: null,
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
      custom_conversion_id: unknown("custom_conversion_id"),
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
    currentConfigDay: "2026-09-23",
    metricContract: { funnelStage: "meta-funnel-stage.v1" },
  };
}

const badge = (type: string) => ({ type, label: type, severity: "warning" });

/** One persisted native snapshot row, shaped like the live generation read. */
function snapshotRow(
  adId: string,
  overrides: Partial<MetaNativeDecisionSnapshotSourceRow>,
): MetaNativeDecisionSnapshotSourceRow {
  const suffix = adId.slice(-12).padStart(12, "0");
  return {
    snapshot_id: `00000000-0000-4000-8000-${suffix}`,
    evaluation_id: `10000000-0000-4000-8000-${suffix}`,
    job_run_id: JOB_RUN,
    provider_account_ref_id: ACCOUNT_REF,
    provider_account_id: ACCOUNT,
    ad_id: adId,
    creative_id: `cr_${adId}`,
    as_of_date: "2026-09-23",
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: ACCOUNT,
    label: "cut",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: "cut",
    confidence: 50,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: `${adId} served reason.`,
    spend: 150,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: null,
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: "2026-09-23T11:00:00.000Z",
    episode_started_at: "2026-09-23",
    lineage_valid: true,
    creative_name: `Creative ${adId}`,
    campaign_id: "cmp_main",
    campaign_name: "Main",
    adset_id: "as_1",
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
    source_updated_at: "2026-09-23T04:00:00.000Z",
    config_authority_verified: false,
    config_evidence_lineage: null,
    ...overrides,
  } as MetaNativeDecisionSnapshotSourceRow;
}

const CAMPAIGN_CONTEXTS = [
  {
    campaignId: "cmp_main",
    kind: "main",
    source: "system_inferred",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-09-23T01:00:00.000Z",
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  },
  {
    campaignId: "cmp_low",
    kind: "main",
    source: "system_inferred",
    confidenceClass: "low",
    sourceUpdatedAt: "2026-09-23T01:00:00.000Z",
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  },
] as MetaDecisionCampaignContextSourceRow[];

const ADSET_ROLES: MetaDecisionCampaignContextSourceRow[] = [{
  campaignId: "cmp_main",
  kind: "main",
  source: "operator_declared",
  confidenceClass: "high",
  sourceUpdatedAt: "2026-09-23T01:00:00.000Z",
  resolverVersion: null,
  roleEntityType: "adset",
  roleEntityId: "as_1",
  roleBasis: "declared",
  declarationContractVersion: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
}];

/** An authorized, config-verified Cut: the one row that can reach Action now. */
const authorizedCut = (
  overrides: Partial<MetaNativeDecisionSnapshotSourceRow> = {},
) =>
  snapshotRow("100000000004", {
    label: "cut",
    raw_label: "cut",
    pre_authority_label: "cut",
    authorized_action: "cut",
    confidence: 40,
    config_authority_verified: true,
    config_evidence_lineage: verifiedConfigLineage(),
    ...overrides,
  });

/** Live shape: campaign-role hold on a first-generation raw Cut. */
const campaignContextHeldCut = () =>
  snapshotRow("100000000003", {
    campaign_id: "cmp_low",
    label: "keep",
    raw_label: "cut",
    pre_authority_label: "cut",
    authority_blocker: "campaign_context",
    blocked_action_type: "cut",
    confidence: 50,
    badges: [
      badge("lifecycle_unavailable"),
      badge("campaign_context_low_confidence"),
      badge("stop_loss_review"),
      badge("pending_transition"),
    ],
  });

/** A raw Cut the freshness guard holds; the raw label stays `cut`. */
const freshnessHeldCut = () =>
  snapshotRow("100000000008", {
    label: "cut",
    raw_label: "cut",
    pre_authority_label: "cut",
    authority_blocker: "source_freshness",
    blocked_action_type: "cut",
    confidence: 45,
    badges: [badge("stale_evidence")],
  });

/** TheSwaf live shape: the profile gate softens a Cut to `test_more`. */
const profileHeldCutSignal = () =>
  snapshotRow("100000000001", {
    label: "test_more",
    raw_label: "test_more",
    pre_authority_label: "cut",
    authority_blocker: "profile_hard_action_ineligible",
    blocked_action_type: "cut",
    confidence: 60,
    badges: [badge("cut_candidate")],
  });

/** A plain Test more with the highest confidence: first in server order. */
const plainTestMore = () =>
  snapshotRow("100000000007", {
    label: "test_more",
    raw_label: "test_more",
    pre_authority_label: "test_more",
    confidence: 70,
    ratio_to_target: 0.9,
    roas: 1.8,
    badges: [],
  });

/** Grandmix live shape: plain Diagnose with no Decision Center row. */
const liveDiagnose = () =>
  snapshotRow("100000000006", {
    label: "diagnose",
    raw_label: "diagnose",
    pre_authority_label: "test_more",
    confidence: 40,
    campaign_id: "cmp_none",
    spend: 0,
    purchases: 0,
    roas: null,
    recent7d_roas: null,
    currency: "TRY",
    reason: "[Ad metrics unavailable - fail closed] live-shaped.",
    badges: [
      badge("ad_metrics_unavailable"),
      badge("campaign_context_unresolved"),
      badge("unknown_freshness"),
    ],
  });

type Segment = "action-now" | "watching" | "healthy";

/**
 * Run the production chain and hand the page exactly what `fetchCreativeInbox`
 * would: the briefing lanes, sorted as the route sorts them, tagged with the
 * segment each arrived in.
 */
function serve(input: {
  rows: MetaNativeDecisionSnapshotSourceRow[];
  governance: MetaDecisionExecutionGovernanceFacts;
  now?: Date;
}) {
  const inventory = buildNativeMetaCanonicalDecisionInventory({
    businessId: "biz_1",
    providerAccountId: ACCOUNT,
    generation: {
      jobRunId: JOB_RUN,
      asOfDate: "2026-09-23",
      providerAccountRefId: ACCOUNT_REF,
      manifestHash: hashAdDecisionIdentityManifest({
        businessId: "biz_1",
        providerAccountId: ACCOUNT,
        asOfDate: "2026-09-23",
        adIds: input.rows.map((row) => row.ad_id),
      }),
      expectedAdCount: input.rows.length,
    },
    snapshotRows: input.rows,
    campaignContextRows: CAMPAIGN_CONTEXTS,
    adsetRoleRows: ADSET_ROLES,
  });
  expect(inventory.status).toBe("available");
  const governed = applyMetaExecutionGovernanceToCanonicalDecisions({
    decisions: inventory.items,
    governance: input.governance,
    pipeline: { verified: true, executionReady: true },
    now: input.now ?? NOW,
  });
  const projections = governed.map((decision) =>
    projectCanonicalNativeAdDecisionToBriefing({ decision }),
  );
  expect(projections.every(Boolean)).toBe(true);
  const lanes: Record<"action" | "watching" | "healthy", BriefingCreativeCard[]> =
    { action: [], watching: [], healthy: [] };
  for (const projection of projections) {
    lanes[projection!.lane].push(projection!.card);
  }
  // The briefing route's own comparator (`sortCards` in route.ts).
  const serverOrder = (left: BriefingCreativeCard, right: BriefingCreativeCard) =>
    (right.priorityScore?.score ?? 0) - (left.priorityScore?.score ?? 0) ||
    (right.confidence ?? 0) - (left.confidence ?? 0) ||
    (right.spend ?? 0) - (left.spend ?? 0);
  const tag = (cards: BriefingCreativeCard[], segment: Segment) =>
    [...cards]
      .sort(serverOrder)
      .map((card) => ({ ...card, businessId: "biz_1", briefingSegment: segment }));
  queryState.inbox = {
    inbox: [
      ...tag(lanes.action, "action-now"),
      ...tag(lanes.watching, "watching"),
      ...tag(lanes.healthy, "healthy"),
    ],
    source: null,
    canonicalDecisionInventory: { status: "available" },
  };
  const html = renderToStaticMarkup(
    <MetaCreativeInboxPage businessId="biz_1" providerAccountId={ACCOUNT} />,
  );
  const column = (segment: Segment) => {
    const start = html.indexOf(`data-inbox-column="${segment}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = html.indexOf("data-inbox-column=", start + 1);
    return next > 0 ? html.slice(start, next) : html.slice(start);
  };
  const ids = (segment: Segment) =>
    [...column(segment).matchAll(/data-inbox-card="([^"]+)"/g)].map(
      (match) => match[1],
    );
  const article = (id: string) => {
    const start = html.indexOf(`data-inbox-card="${id}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    return html.slice(start, html.indexOf("</article>", start));
  };
  const plain = (fragment: string) =>
    fragment
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  const card = (id: string) => {
    const markup = article(id);
    const spans = [...markup.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)];
    const note = markup.match(/<p[^>]*>[\s\S]*?<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/);
    const fact = (label: string) => {
      const match = markup.match(
        new RegExp(`data-inbox-fact="${label}"[^>]*>([\\s\\S]*?)</span>`),
      );
      return match ? plain(match[1]!) : null;
    };
    return {
      chip: plain(spans[0]?.[1] ?? ""),
      note: plain(note?.[1] ?? ""),
      text: plain(markup),
      fact,
    };
  };
  return { governed, projections, ids, card };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Authorizes the fixture's system-inferred campaign roles exactly as an
  // armed deployment would, so the Cut rows reach their own classification.
  vi.stubEnv(
    "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
    CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  );
  queryState.inbox = undefined;
  vi.mocked(useQuery).mockImplementation(((options: {
    queryKey: readonly unknown[];
  }) =>
    ({
      data:
        options.queryKey[0] === "creative-account-inbox"
          ? queryState.inbox
          : [],
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof useQuery>) as typeof useQuery);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Creative Inbox — served Cut readiness and holds (production chain)", () => {
  it("C1: shows the served Diagnose label when the projection served no Decision Center row", () => {
    const served = serve({
      rows: [liveDiagnose()],
      governance: GOVERNANCE_VERIFIED,
    });
    const projection = served.projections[0]!;
    // The precondition of the defect, from the real projection.
    expect(projection.decisionCenterRow).toBeNull();
    expect(projection.card.canonicalDecision?.classification.buyerAction).toBeNull();

    const card = served.card("100000000006");
    expect(card.chip).toBe("Diagnose data");
    expect(card.fact("Readiness")).toBeNull();
  });

  it.each([
    [
      "governance_unavailable",
      GOVERNANCE_UNAVAILABLE,
      undefined,
      "Automation safeguards unverified",
    ],
    ["kill_switched", KILL_SWITCHED, undefined, "Kill switch on"],
    [
      "stale_decision",
      GOVERNANCE_VERIFIED,
      new Date("2026-09-23T23:30:00.000Z"),
      // The ceiling is the served `decisionFreshness.maxAgeHours`.
      "Decision older than 12 hours",
    ],
    [
      "stale_decision",
      GOVERNANCE_VERIFIED,
      // Served freshness `future`: the server serves the same readiness code,
      // and the copy must not claim the decision is old.
      new Date("2026-09-22T00:00:00.000Z"),
      "Decision time is ahead of the clock",
    ],
  ] as const)(
    "C2: an authorized Cut stopped by %s ranks first in Watching, labelled not ready, with its readiness",
    (readiness, governance, now, readinessCopy) => {
      if (now) vi.setSystemTime(now);
      const served = serve({
        rows: [
          plainTestMore(),
          profileHeldCutSignal(),
          campaignContextHeldCut(),
          freshnessHeldCut(),
          authorizedCut(),
        ],
        governance,
        now,
      });
      const authority = served.projections.find(
        (projection) => projection!.card.id === "100000000004",
      )!.card.canonicalDecision!.sourceAuthority;
      // The real chain produced exactly the case under test.
      expect(authority.actionEligible).toBe(true);
      expect(authority.authorizedAction).toBe("cut");
      expect(authority.executionReadiness).toBe(readiness);

      expect(served.ids("action-now")).toEqual([]);
      expect(served.ids("watching")).toEqual([
        "100000000004", // not-ready Cut
        "100000000003", // held raw Cut (campaign context), server order
        "100000000008", // held raw Cut (freshness), server order
        "100000000001", // test_more carrying a held Cut signal
        "100000000007", // everything else, although first in server order
      ]);
      const card = served.card("100000000004");
      expect(card.chip).toBe("Cut · Not ready to apply");
      expect(card.chip).not.toBe("Cut");
      expect(card.fact("Readiness")).toBe(`Readiness ${readinessCopy}`);
      expect(card.note).toContain("100000000004 served reason.");
    },
  );

  it("C2: a Cut whose current hierarchy could not be confirmed ranks first and says why", () => {
    const served = serve({
      rows: [
        plainTestMore(),
        campaignContextHeldCut(),
        authorizedCut({ adset_status: null }),
      ],
      governance: GOVERNANCE_VERIFIED,
    });
    const canonical = served.projections.find(
      (projection) => projection!.card.id === "100000000004",
    )!.card.canonicalDecision!;
    expect(canonical.classification.buyerAction).toBe("cut");
    expect(canonical.sourceAuthority.actionEligible).toBe(false);
    expect(canonical.sourceAuthority.reviewOnlyReason).toBe(
      "current_hierarchy_status_is_unknown",
    );

    expect(served.ids("action-now")).toEqual([]);
    expect(served.ids("watching")).toEqual([
      "100000000004",
      "100000000003",
      "100000000007",
    ]);
    const card = served.card("100000000004");
    expect(card.chip).toBe("Cut · Not ready to apply");
    expect(card.fact("Readiness")).toBe("Readiness Review only");
    expect(card.note).toBe(
      "100000000004 served reason. Not in Action now because this ad's current status could not be confirmed.",
    );
  });

  it("control: a fresh, verified, authorized Cut stays a plain Cut in Action now", () => {
    const served = serve({
      rows: [plainTestMore(), campaignContextHeldCut(), authorizedCut()],
      governance: GOVERNANCE_VERIFIED,
    });
    expect(served.ids("action-now")).toEqual(["100000000004"]);
    const card = served.card("100000000004");
    expect(card.chip).toBe("Cut");
    expect(card.fact("Readiness")).toBeNull();
    expect(card.text).not.toContain("Not ready");
    expect(served.ids("watching")).toEqual(["100000000003", "100000000007"]);
  });

  it("C4: a campaign-role hold on a raw Cut names campaign context first and is never called economic", () => {
    const served = serve({
      rows: [campaignContextHeldCut()],
      governance: GOVERNANCE_VERIFIED,
    });
    const card = served.card("100000000003");
    expect(card.chip).toBe("Cut · Held");
    // Authority blocker first, then the separate D100 configuration gap. The
    // evidence-detail blocker (`campaign_context_low_confidence`) is not a hold.
    expect(card.note).toBe(
      "100000000003 served reason. Held: Campaign context is still being verified. Campaign configuration evidence is unverified.",
    );
    expect(card.fact("Readiness")).toBe("Readiness Review only");
    expect(card.text.toLowerCase()).not.toContain("economic");
    expect(card.text).not.toContain("Campaign context confidence is too low");
  });

  it("C4: a test_more card carrying a held Cut is a reduction signal ranked below held raw Cuts", () => {
    const served = serve({
      rows: [
        profileHeldCutSignal(),
        freshnessHeldCut(),
        campaignContextHeldCut(),
      ],
      governance: GOVERNANCE_VERIFIED,
    });
    expect(served.ids("watching")).toEqual([
      "100000000003",
      "100000000008",
      "100000000001",
    ]);
    const signal = served.card("100000000001");
    expect(signal.chip).toBe("Test more · Spend reduction signal held");
    expect(signal.note).toBe(
      "100000000001 served reason. Held: More verified evidence is required for this change. Campaign configuration evidence is unverified.",
    );
    const freshness = served.card("100000000008");
    expect(freshness.chip).toBe("Cut · Held");
    expect(freshness.note).toBe(
      "100000000008 served reason. Held: Decision evidence is out of date. Campaign configuration evidence is unverified.",
    );
    for (const id of ["100000000001", "100000000003", "100000000008"]) {
      expect(served.card(id).text.toLowerCase()).not.toContain("economic");
    }
  });

  it("C4: Scale holds and a not-ready Scale keep their own copy and never say Cut", () => {
    const served = serve({
      rows: [
        snapshotRow("100000000009", {
          campaign_id: "cmp_low",
          label: "test_more",
          raw_label: "test_more",
          pre_authority_label: "scale",
          authority_blocker: "campaign_context",
          blocked_action_type: "scale",
          confidence: 50,
          ratio_to_target: 1.6,
          roas: 3.2,
          badges: [badge("campaign_context_low_confidence")],
        }),
        snapshotRow("100000000011", {
          label: "scale",
          raw_label: "scale",
          pre_authority_label: "scale",
          authorized_action: "scale",
          confidence: 70,
          ratio_to_target: 1.6,
          roas: 3.2,
          config_authority_verified: true,
          config_evidence_lineage: verifiedConfigLineage(),
        }),
      ],
      governance: GOVERNANCE_UNAVAILABLE,
    });
    const held = served.card("100000000009");
    expect(held.chip).toBe("Test more · Scale signal held");
    expect(held.note).toBe(
      "100000000009 served reason. Held: Campaign context is still being verified. Campaign configuration evidence is unverified.",
    );
    expect(held.fact("Readiness")).toBe("Readiness Review only");

    const authorized = served.card("100000000011");
    expect(
      served.projections.find(
        (projection) => projection!.card.id === "100000000011",
      )!.card.canonicalDecision!.sourceAuthority.executionReadiness,
    ).toBe("governance_unavailable");
    // The server's own Scale label, with its served readiness beside it.
    expect(authorized.chip).toBe(
      served.projections.find(
        (projection) => projection!.card.id === "100000000011",
      )!.decisionCenterRow!.buyerLabel,
    );
    expect(authorized.fact("Readiness")).toBe(
      "Readiness Automation safeguards unverified",
    );
    for (const card of [held, authorized]) {
      expect(card.text).not.toMatch(/\bcut\b/i);
    }
  });
});
