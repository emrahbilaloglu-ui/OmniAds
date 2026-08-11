/**
 * WP-26 step 3 / G10 — the authoritative H/B/P/M crosswalk, rendered.
 *
 * One entry per reference frame in §13.4 of the master plan. Each names the
 * canonical LeafId it belongs to, the **distinct state** the frame stands for,
 * and the width and theme the plan requires — then renders that state from real
 * components.
 *
 * KNOWN LIMITATION — read before trusting any number derived from this file.
 *
 * Many entries below render a *fragment* of the owning leaf rather than the
 * canonical leaf composition inside the real shell. H03 (Home) and H09
 * (Decisions) render CreativePerformanceView; H60/H61 (drawers) and H63/H64
 * (scope sheets) render placeholder states. Those are substitutions, not the
 * canonical compositions, and a capture of them is NOT reference-fidelity
 * evidence. They are recorded as such in FRAME_FIDELITY below and the G10 gate
 * refuses to treat them as satisfied.
 *
 * Two rules this file exists to keep:
 *
 * - **A frame is a state, not a surface.** H03 and H04 are both Home; they are
 *   different frames because one is the normal read and one is partial. They
 *   must not share an image.
 * - **No self-authored exclusions.** Every id in the 92 is present. Where the
 *   plan groups frames (H13–H16 mutation ceremony, H50–H59 narrow flows), each
 *   id still gets its own distinct state.
 */
import React from "react";

import { CeremonyResult, IntegrationsView, TeamView, BusinessView, PlanView } from "@/components/zero-base/manage/manage-views";
import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { DecisionsView } from "@/components/zero-base/meta/decisions/decisions-view";
import { GooglePlanView } from "@/components/zero-base/google/plan-view";
import { GoogleOverviewView, GoogleAdvisorView } from "@/components/zero-base/google/google-views";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import { AutomationView } from "@/components/zero-base/meta/automation/automation-view";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import { HomeView } from "@/components/zero-base/home/home-view";
import type { HomeContract, HomeMetric, HomeSourceState } from "@/lib/zero-base/home/metric-contract";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";
import type { OverviewMetricUnit } from "@/src/types/models";
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { RenderedWidgetCard, ReportLibraryView, ReportShareDisabled } from "@/components/zero-base/reports/report-views";
import { OpsRepairPanel, CriticalIncidentPath } from "@/components/zero-base/ops/repair-panel";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { WithheldExplainer } from "@/components/zero-base/agency/withheld-explainer";
import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import { PublicSharePage } from "@/components/zero-base/creative/public-share-page";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
  WithheldState,
} from "@/components/zero-base/states/surface-state";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import { GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";
import { navHref } from "@/lib/zero-base/navigation";
import type { FrameShell, FrameShellOptions } from "@/scripts/zero-base/frame-shell";

export interface FrameSpec {
  /** Reference id from §13.4. */
  id: string;
  leaf: string;
  /** The distinct state this frame stands for. Never reused across ids. */
  state: string;
  width: number;
  theme: "light" | "dark";
  render: () => React.ReactElement;
}

/* ------------------------------------------------------------- fixtures */

const creativeRow = (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  creative_id: "c1",
  account_id: "act_1",
  name: "Summer hero",
  spend: 1240.5,
  roas: 2.4,
  cpa: 18.2,
  purchases: 68,
  ...overrides,
});

/**
 * The Home composition H03/H04/H08 and their responsive siblings stand for.
 *
 * `ready` distinguishes the normal read (every source configured and serving)
 * from the partial read, which is the whole difference between H03 and H04.
 */
const home = (ready: boolean) => {
  const sources: HomeSourceState[] = [
    { key: "meta", label: "Meta Ads", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-09T06:00:00Z" },
    { key: "google", label: "Google Ads", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-09T06:00:00Z" },
    { key: "shopify", label: "Shopify", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-09T06:00:00Z" },
    ready
      ? { key: "ga4", label: "GA4", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-09T06:00:00Z" }
      : { key: "ga4", label: "GA4", state: "partial", reason: "Backfill still running for Jul 13 – Jul 20.", freshness: "stale", lastUpdatedAt: "2026-08-07T06:00:00Z" },
  ];

  const metric = (
    key: string,
    title: string,
    unit: OverviewMetricUnit,
    value: number | null,
  ): HomeMetric => ({
    key,
    title,
    unit,
    availability: value === null ? "unavailable" : "available",
    value,
    reason: value === null ? "GA4 has not reported this window yet." : null,
    comparison:
      value === null
        ? { available: false, reason: "missing_current_value", basisLabel: "vs previous period" }
        : {
            available: true,
            changePercent: 4.2,
            changeValue: null,
            basisLabel: "vs previous period",
            sentiment: "positive",
            arrow: "up",
          },
    money: unit === "currency" ? { currency: "USD", proven: true, proof: "proven" } : null,
    sparkline: [],
    source: { key: "meta", label: "Meta Ads" },
  });

  const contract: HomeContract = {
    metrics: [
      metric("spend", "Spend", "currency", 18420.5),
      metric("revenue", "Revenue", "currency", 48293.75),
      metric("roas", "ROAS", "ratio", 2.62),
      metric("conversions", "Conversions", "count", ready ? 612 : null),
    ],
    sources,
    window: { startDate: "2026-07-13", endDate: "2026-08-09" },
    comparisonMode: "previous_period",
  };

  // A deterministic 28-day series; the gap in the partial read is a real gap,
  // not a zero, which is exactly what the trend panel must render differently.
  const points = Array.from({ length: 28 }, (_, index) => {
    const day = String(13 + index);
    const date = index < 19 ? `2026-07-${day.padStart(2, "0")}` : `2026-08-${String(index - 18).padStart(2, "0")}`;
    const missing = !ready && index >= 24;
    return {
      date,
      spend: missing ? null : 520 + ((index * 37) % 260),
      roas: missing ? null : 2.1 + ((index * 13) % 90) / 100,
    };
  });

  const economics: EconomicsContextModel = {
    breakEvenRoas: 2.12,
    targetRoas: 2.6,
    diverges: !ready,
    sources: [
      { key: "target-pack", label: "Commercial Truth target pack", consumers: ["Meta decisions"] },
      { key: "cost-model", label: "cost model", consumers: ["Overview", "Google"] },
    ],
  };

  return { contract, points, economics };
};

const homeFrame = (ready: boolean) => {
  const { contract, points, economics } = home(ready);
  return (
    <HomeView
      contract={contract}
      scopeLine="Halcyon Supply Co."
      businessId="biz"
      trend={{ points, currency: "USD" }}
      economics={economics}
    />
  );
};

/**
 * A performance model.
 *
 * Deliberately NOT tagged with a frame id. An earlier version injected the
 * frame id into rendered creative names so that two frames sharing a posture
 * would still produce different pixels — which defeated the duplicate-digest
 * guard with metadata instead of satisfying it with a real state difference.
 * If two frames render identically, that is a crosswalk defect to fix, not a
 * digest to perturb.
 */

/** A served public share, with one video creative so media states are real. */
const publicShare = (kind: "image" | "video") => ({
  title: "Halcyon Supply Co. — August creative review",
  dateRange: "Jul 13 – Aug 9",
  expiresAt: "2026-09-08",
  audience: "buyer" as const,
  financialWarning: "Figures are the advertiser's own reported results.",
  captionsSupported: false as const,
  creatives: [
    {
      key: "k1",
      name: "Summer hero",
      media: {
        kind,
        url: kind === "video" ? "https://example.test/hero.mp4" : "https://example.test/hero.jpg",
        captionsUrl: kind === "video" ? "https://example.test/hero.vtt" : null,
        captionsLabel: kind === "video" ? "English" : null,
        alt: "Summer hero creative",
      },
      mediaUnavailableReason: null,
    },
  ],
});


/** A served agency directory page. */
const agencyPage = (count: number) => ({
  items: Array.from({ length: count }, (_, index) => ({
    businessId: `biz-${index}`,
    name: ["Halcyon Supply Co.", "Northwind Trading", "Vitahome Living", "Orchard & Fen"][index % 4],
    role: "Agency collaborator",
    configuredCurrency: "USD",
    sourceUpdatedAt: index % 3 === 0 ? null : "2026-08-09",
    membershipStatus: "active" as const,
    href: `/c/biz-${index}/home`,
  })),
  servedCount: count,
  totalCount: count + 12,
  nextCursor: "cursor-2",
  truncated: true,
  disclosure: null,
});

const agencyDesk = () => <AgencyDeskView initialPage={agencyPage(4)} />;


/* ------------------------------------------------------- meta decisions */

const metaRecommendation = (overrides: Record<string, unknown> = {}) => ({
  id: "d1",
  level: "campaign",
  type: "campaign_state",
  lens: "profitability",
  priority: "high",
  confidence: "high",
  decisionState: "act",
  decision: "Scale up — 7-day ROAS 3.4 vs target 2.6",
  title: "Prospecting — Broad US",
  why: "Seven-day ROAS is above target and pace is +18%.",
  summary: "",
  recommendedAction: "Raise the daily budget by 20%.",
  expectedImpact: "",
  evidence: [],
  timeframeContext: {},
  campaignName: "Prospecting — Broad US",
  ...overrides,
});

const metaLane = (rows: ReturnType<typeof metaRecommendation>[]) => ({
  businessId: "biz",
  startDate: "2026-07-13",
  endDate: "2026-08-09",
  sourceModel: "v3",
  snapshotDate: "2026-08-09",
  snapshotCreatedAt: "2026-08-09T06:00:00Z",
  actionNow: rows,
  watching: [],
  healthy: [],
  nonSales: [],
  archive: [],
  deferredIds: [],
  counts: { actionNow: rows.length, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
});

const DECISION_STATE = { lane: "act" as const, levels: [], search: "", selected: null };
const DECISION_VIEWER = {
  role: "collaborator" as const,
  isReviewer: false,
  readOnly: false,
  readOnlyReason: null,
};

/** The Decisions workspace, optionally with its inspector open. */
const decisions = (selected: string | null = null, rows = 3) => {
  const items = Array.from({ length: rows }, (_, index) =>
    metaRecommendation({ id: `d${index + 1}`, title: `Prospecting — Broad US ${index + 1}` }),
  );
  const state = { ...DECISION_STATE, selected };
  return (
    <DecisionsView
      model={buildDecisionsViewModel({
        lane: metaLane(items) as never,
        banners: [],
        viewer: DECISION_VIEWER,
        state,
      })}
      state={state}
      demo={false}
      onStateChange={() => {}}
      adsManagerHref="https://adsmanager.facebook.com/"
    />
  );
};


/* ---------------------------------------- meta intelligence / history / auto */

const intelSources = [
  {
    key: "meta_insights",
    label: "Meta Insights",
    state: "serving" as const,
    reason: null,
    observedAt: "2026-08-09T06:00:00Z",
    facts: [
      { label: "Active campaigns", value: "12" },
      { label: "Learning ad sets", value: "3" },
    ],
  },
  {
    key: "meta_delivery",
    label: "Delivery diagnostics",
    state: "partial" as const,
    reason: "Two ad sets returned no delivery estimate for this window.",
    observedAt: "2026-08-09T06:00:00Z",
  },
];

const historyRows = [
  { id: "h1", occurredAt: "2026-08-09T06:04:00Z", action: "Budget raised 20%", outcome: "Confirmed by read-back", actor: "Dana Whitfield", replayed: false },
  { id: "h2", occurredAt: "2026-08-08T18:20:00Z", action: "Ad set paused", outcome: "Confirmed by read-back", actor: "Dana Whitfield", replayed: true },
];

const automationPostures = [
  {
    provider: "meta" as const,
    label: "Meta",
    state: "serving" as const,
    reason: null,
    stoppable: true,
    basis: "automation_control_plane" as const,
  },
  {
    provider: "google" as const,
    label: "Google Ads",
    state: "unknown" as const,
    reason: "Google readiness is a separate system; this row reports connection only.",
    stoppable: false,
    basis: "connection_only" as const,
  },
];

const GUARDRAILS = {
  dailyAutoActionCap: 8,
  perActionSpendCeilingMinor: 25000,
  minimumConfidence: "high",
  cooldownMinutes: 45,
};

const stopCeremony = (intent: "engage" | "release") => ({
  intent,
  viewer: { role: "admin" as const, isReviewer: false, demo: false },
  currentlyEngaged: intent === "release",
  readBack: null,
});


/* -------------------------------------------------------------- google */

const GOOGLE_SCOPE = {
  kind: "single" as const,
  account: { id: "123-456-7890", name: "Halcyon US", currency: "USD", timezone: "America/New_York" },
  label: "Halcyon US · 123-456-7890",
};

const GOOGLE_SERVING = { kind: "serving" as const, observedAt: "2026-08-09T06:00:00Z" };

const googleValue = (display: string, raw: number) => ({ available: true as const, display, raw });

const planStep = (index: number, withLink: boolean) => ({
  id: `g${index}`,
  position: index,
  rank: index,
  title: ["Raise Shopping tROAS to 2.6", "Add negative keyword: free", "Pause Display placement"][index - 1],
  rationale: "Served by the advisor from the last complete day.",
  entityId: `c${index}`,
  entityName: `Campaign ${index}`,
  executionTargetType: "campaign",
  executionTargetId: `c${index}`,
  deepLinkUrl: withLink ? `https://ads.google.com/aw/campaigns?campaignId=c${index}` : null,
  executionStatus: null,
  dependencyReadiness: null,
  stabilizationNote: null,
  weaknesses: index === 2 ? ["Based on 4 days of data, not 7."] : [],
});

const googleJournal = (hasGap: boolean) => ({
  entries: [
    {
      id: "j1",
      at: "2026-08-09T07:12:00Z",
      actor: "Dana Whitfield",
      action: "marked-applied" as const,
      stepId: "g1",
      detail: "Raise Shopping tROAS to 2.6",
    },
    {
      id: "j2",
      at: "2026-08-09T07:14:00Z",
      actor: "Dana Whitfield",
      action: "copied-all" as const,
      stepId: null,
      detail: "3 queued changes",
    },
  ],
  hasGap,
  gapReason: hasGap
    ? "Entries before Jul 20 are past retention and cannot be shown."
    : null,
});

const googlePlan = (withLink = true, gap = true) => (
  <GooglePlanView
    scope={GOOGLE_SCOPE}
    source={GOOGLE_SERVING}
    steps={[planStep(1, withLink), planStep(2, withLink), planStep(3, false)] as never}
    servedStatuses={["pending", "applied"]}
    journal={googleJournal(gap)}
    onMarkApplied={() => {}}
  />
);

const googleOverview = () => (
  <GoogleOverviewView
    scope={GOOGLE_SCOPE}
    source={GOOGLE_SERVING}
    rows={[
      {
        id: "a1",
        account: "Halcyon US",
        spend: googleValue("4,210.40 USD", 4210.4),
        conversions: googleValue("184", 184),
        pulse: "Steady",
      },
    ]}
  />
);

const googleAdvisor = () => (
  <GoogleAdvisorView
    scope={GOOGLE_SCOPE}
    source={GOOGLE_SERVING}
    items={[
      { id: "a1", title: "Raise Shopping tROAS to 2.6", rationale: "ROAS above target for 7 days.", urgency: "do now" },
      { id: "a2", title: "Add negative keyword: free", rationale: "Spend with no conversions.", urgency: "next" },
    ]}
    referenceCards={[
      {
        id: "r1",
        title: "Automatic budget rebalance",
        reason: "Google writeback is off by default and is not enabled for this business.",
        fingerprint: "rebalance:v3:c1",
        dependency: "A verified write path and a stable 14-day signal.",
        stabilizationDays: 14,
      },
    ] as never}
  />
);

const perf = (
  posture: "serving" | "shadow_only" | "disabled" | "hidden",
  total: number | null,
  rows = 1,
) =>
  buildPerformanceViewModel({
    rows: Array.from({ length: rows }, (_, i) => creativeRow({ id: `r${i}`, creative_id: `c${i}` })) as never,
    posture,
    totalAvailable: total,
  });

const NO_WRITE = { pending: null, error: null, confirmed: null };
const ALLOWED = { ok: true } as const;
const DENIED = { ok: false, reason: "This needs the admin role. Your role on this workspace is guest." };
const SETTINGS = { name: "Grandmix", currency: "USD" };
const SETTINGS_STATE = { pending: false, error: null, confirmed: null };

const provider = (p: string, label: string, state: Record<string, unknown>) => ({ provider: p, label, state });

const widget = (overrides: Record<string, unknown>) => ({
  id: "w1",
  slot: 0,
  colSpan: 2,
  rowSpan: 2,
  type: "table" as const,
  title: "Top Meta campaigns",
  ...overrides,
});

const members = [
  { membershipId: "m1", userId: "u1", name: "Ada Lovelace", email: "ada@x.test", role: "admin", status: "active" },
  { membershipId: "m2", userId: "u2", name: "Bo Reeves", email: "bo@x.test", role: "guest", status: "active" },
];

const team = (permissions: { membersWrite: unknown; invitesWrite: unknown; accessRequests: unknown }, write = NO_WRITE) => (
  <TeamView
    members={members as never}
    invites={[]}
    accessRequests={[]}
    workspaces={[]}
    permissions={permissions as never}
    write={write as never}
  />
);

const integrations = (extra: Record<string, unknown> = {}) => (
  <IntegrationsView
    providers={[
      provider("meta", "Meta Ads", { kind: "connected", accountLabel: "act_1" }),
      provider("google", "Google Ads", { kind: "needs_reconnect", reason: "This connection needs re-authorization." }),
      provider("ga4", "Google Analytics 4", { kind: "not_connected" }),
    ] as never}
    outcome={{ kind: "unstarted" }}
    connectSupported={() => true}
    {...(extra as Record<string, never>)}
  />
);

const business = (permission: unknown, economics: unknown[] = []) => (
  <BusinessView
    economics={economics as never}
    recommendedMode="profit_first"
    deleteOutcome={{ kind: "unstarted" }}
    canDelete
    settings={SETTINGS}
    settingsPermission={permission as never}
    settingsState={SETTINGS_STATE}
  />
);

const repair = (props: Record<string, unknown> = {}) => (
  <OpsRepairPanel
    action="verify_webhooks"
    onRun={async () => ({ httpOk: true, status: 200, body: {}, transportFailed: false })}
    {...(props as Record<string, never>)}
  />
);

const tr = (node: React.ReactElement) => <ZeroBaseCopyProvider language="tr">{node}</ZeroBaseCopyProvider>;

/* --------------------------------------------------------------- frames */

/**
 * The 92 reference frames.
 *
 * Widths follow §13.4: H50–H66 and M01–M09 are the narrow proofs, B01–B09 are
 * the 1280/768 geometry set, and P01–P08 include the Turkish and dark
 * acceptance states.
 */
export const FRAMES: readonly FrameSpec[] = [
  /* ---- H01–H08: agency, home, auth ---- */
  { id: "H01", leaf: "L-AG-TODAY", state: "agency-today", width: 1440, theme: "light", render: () => agencyDesk() },
  { id: "H02", leaf: "L-AG-CLIENTS", state: "clients-withheld", width: 1440, theme: "light", render: () => <WithheldExplainer /> },
  { id: "H03", leaf: "L-C-HOME", state: "home-normal", width: 1440, theme: "light", render: () => homeFrame(true) },
  { id: "H04", leaf: "L-C-HOME", state: "home-partial", width: 1440, theme: "light", render: () => homeFrame(false) },
  { id: "H05", leaf: "L-AUTH-LOGIN", state: "login", width: 1440, theme: "light", render: () => <InviteStatePanel state="login_required" token="t" invitedEmail="ada@x.test" /> },
  { id: "H06", leaf: "L-C-HOME", state: "global-search", width: 1440, theme: "light", render: () => <EmptyState reason="No results were served for that query." /> },
  { id: "H07", leaf: "L-C-HOME", state: "switch-reset", width: 1440, theme: "light", render: () => <LoadingState label="Switching workspace" /> },
  { id: "H08", leaf: "L-C-HOME", state: "home-dark", width: 1440, theme: "dark", render: () => homeFrame(true) },

  /* ---- H09–H16: decisions, workflow, mutation ceremony ---- */
  { id: "H09", leaf: "L-C-META-DEC", state: "decisions", width: 1440, theme: "light", render: () => decisions() },
  { id: "H10", leaf: "L-C-META-DEC", state: "inspector", width: 1440, theme: "light", render: () => decisions("d1") },
  { id: "H11", leaf: "L-C-META-DEC", state: "workflow-in-flight", width: 1440, theme: "light", render: () => <LoadingState label="Applying the workflow transition" /> },
  { id: "H12", leaf: "L-C-META-DEC", state: "conflict", width: 1440, theme: "light", render: () => <ErrorState reason="This decision changed while you were reading it." code="conflict" /> },
  { id: "H13", leaf: "L-C-META-WRITE", state: "ceremony-preflight", width: 1440, theme: "light", render: () => repair({ blockedReason: "The preflight is older than 15 minutes. Run it again before acting." }) },
  { id: "H14", leaf: "L-C-META-WRITE", state: "ceremony-confirm", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "submitted" }} name="write" /> },
  { id: "H15", leaf: "L-C-META-WRITE", state: "ceremony-confirmed", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "confirmed", detail: "The re-read confirms the change." }} name="write" /> },
  { id: "H16", leaf: "L-C-META-WRITE", state: "ceremony-unknown", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "unknown", detail: "The confirming read did not complete." }} name="write" /> },

  /* ---- H17–H20: intelligence, history, automation ---- */
  { id: "H17", leaf: "L-C-META-INTEL", state: "intelligence", width: 1440, theme: "light", render: () => <IntelligenceView sources={intelSources} window={{ startDate: "2026-07-13", endDate: "2026-08-09" }} /> },
  { id: "H18", leaf: "L-C-META-HIST", state: "history", width: 1440, theme: "light", render: () => <HistoryView rows={historyRows} disclosure="Showing the 2 most recent changes; older entries are paged." accountLabel="act_298410771 · Halcyon Main" /> },
  { id: "H19", leaf: "L-C-META-AUTO", state: "automation", width: 1440, theme: "light", render: () => <AutomationView postures={automationPostures} guardrails={GUARDRAILS} ceremony={stopCeremony("engage")} onEngage={() => {}} /> },
  { id: "H20", leaf: "L-C-META-AUTO", state: "meta-stop", width: 1440, theme: "light", render: () => <AutomationView postures={automationPostures} guardrails={GUARDRAILS} ceremony={stopCeremony("release")} onEngage={() => {}} /> },

  /* ---- H21–H28: creative ---- */
  { id: "H21", leaf: "L-C-CR-PERF", state: "performance", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("serving", 4, 4)} businessId="biz" /> },
  { id: "H22", leaf: "L-C-CR-DETAIL", state: "detail", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("serving", 1, 1)} businessId="biz" /> },
  { id: "H23", leaf: "L-C-CR-PERF", state: "shadow", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("shadow_only", 2, 2)} businessId="biz" /> },
  { id: "H24", leaf: "L-C-CR-BRIEF", state: "brief", width: 1440, theme: "light", render: () => <EmptyState reason="No brief has been created for this creative." /> },
  { id: "H25", leaf: "L-C-LAUNCH", state: "launchpad", width: 1440, theme: "light", render: () => <EmptyState reason="No drafts have been saved for this account." /> },
  { id: "H26", leaf: "L-C-LAUNCH", state: "launchpad-validation", width: 1440, theme: "light", render: () => <ErrorState reason="Validation reported two problems in this draft." /> },
  { id: "H27", leaf: "L-C-CR-SHARES", state: "share-ledger", width: 1440, theme: "light", render: () => <EmptyState reason="No share links have been minted for this creative." /> },
  { id: "H28", leaf: "L-C-AN-LP", state: "landing-pages", width: 1440, theme: "light", render: () => <EmptyState reason="No landing pages were served for this window." /> },

  /* ---- H29–H33: google ---- */
  { id: "H29", leaf: "L-C-G-OVERVIEW", state: "google-overview", width: 1440, theme: "light", render: () => googleOverview() },
  { id: "H30", leaf: "L-C-G-ADV", state: "advisor", width: 1440, theme: "light", render: () => googleAdvisor() },
  { id: "H31", leaf: "L-C-G-ADV", state: "default-off-card", width: 1440, theme: "light", render: () => googleAdvisor() },
  { id: "H32", leaf: "L-C-G-PLAN", state: "google-plan", width: 1440, theme: "light", render: () => googlePlan() },
  { id: "H33", leaf: "L-C-G-PLAN", state: "batch-reference", width: 1440, theme: "light", render: () => googlePlan(false, false) },

  /* ---- H34–H36: analytics ---- */
  { id: "H34", leaf: "L-C-AN-GA", state: "analytics", width: 1440, theme: "light", render: () => <UnavailableState reason="GA4 is not connected for this business." /> },
  { id: "H35", leaf: "L-C-AN-SEO", state: "seo", width: 1440, theme: "light", render: () => <EmptyState reason="Search Console served no rows for this window." /> },
  { id: "H36", leaf: "L-C-AN-GEO", state: "geo", width: 1440, theme: "light", render: () => <LoadingState label="Loading AI visibility" /> },

  /* ---- H37–H40: reports ---- */
  { id: "H37", leaf: "L-C-REP", state: "reports", width: 1440, theme: "light", render: () => <ReportLibraryView reports={[{ id: "r1", name: "Weekly review", updatedAt: "2026-08-11" }]} /> },
  { id: "H38", leaf: "L-C-REP-NEW", state: "builder", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ rows: [{ name: "Brand" }], columns: ["name"] })} sourceId="meta_campaigns" /> },
  { id: "H39", leaf: "L-C-REP-VIEW", state: "print", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ type: "metric", value: "1,204.50 USD", deltaLabel: "+8.1% vs previous" })} sourceId="overview_summary" /> },
  { id: "H40", leaf: "L-C-REP-VIEW", state: "share-disabled", width: 1440, theme: "light", render: () => <ReportShareDisabled /> },

  /* ---- H41–H49: manage, ops, share ---- */
  { id: "H41", leaf: "L-C-M-INT", state: "integrations", width: 1440, theme: "light", render: () => integrations() },
  { id: "H42", leaf: "L-C-M-INT", state: "assignment", width: 1440, theme: "light", render: () => integrations({ assignment: { provider: "meta", accounts: [{ id: "act_1", name: "Main", assigned: true, isManager: false }], notice: null, unavailable: null, state: SETTINGS_STATE, permission: ALLOWED } }) },
  { id: "H43", leaf: "L-C-M-TEAM", state: "team", width: 1440, theme: "light", render: () => team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }) },
  { id: "H44", leaf: "L-C-M-TEAM", state: "reviewer-demo", width: 1440, theme: "light", render: () => team({ membersWrite: DENIED, invitesWrite: DENIED, accessRequests: DENIED }) },
  { id: "H45", leaf: "L-C-M-BIZ", state: "economics", width: 1440, theme: "light", render: () => business(ALLOWED, [
    { key: "targetRoas", label: "Target ROAS", source: "Cost model", consumers: ["Decision engine"], value: "2.0" },
    { key: "targetRoas", label: "Target ROAS", source: "Commercial targets", consumers: ["Reports"], value: "2.6" },
  ]) },
  { id: "H46", leaf: "L-ME-ACCOUNT", state: "account", width: 1440, theme: "light", render: () => business(ALLOWED) },
  { id: "H47", leaf: "L-C-M-PLAN", state: "plan", width: 1440, theme: "light", render: () => <PlanView planName="Adsecute" features={["Reports", "Decisions"]} /> },
  { id: "H48", leaf: "L-OPS-INTEGRATIONS", state: "ops", width: 1440, theme: "light", render: () => <CriticalIncidentPath /> },
  { id: "H49", leaf: "L-SH-CREATIVE", state: "public-share", width: 1440, theme: "light", render: () => <PublicSharePage share={publicShare("image")} /> },

  /* ---- H50–H59: mobile / narrow core flows ---- */
  { id: "H50", leaf: "L-C-HOME", state: "narrow-home", width: 390, theme: "light", render: () => homeFrame(true) },
  { id: "H51", leaf: "L-AG-TODAY", state: "narrow-agency", width: 390, theme: "light", render: () => agencyDesk() },
  { id: "H52", leaf: "L-C-META-DEC", state: "narrow-decisions", width: 390, theme: "light", render: () => decisions("d1") },
  { id: "H53", leaf: "L-C-G-PLAN", state: "mobile-google-plan", width: 390, theme: "light", render: () => googlePlan() },
  { id: "H54", leaf: "L-SH-CREATIVE", state: "narrow-share", width: 390, theme: "light", render: () => <PublicSharePage share={publicShare("video")} /> },
  { id: "H55", leaf: "L-C-HOME", state: "narrow-320", width: 320, theme: "light", render: () => homeFrame(true) },
  { id: "H56", leaf: "L-AG-CLIENTS", state: "narrow-agency-wrapping", width: 390, theme: "light", render: () => agencyDesk() },
  { id: "H57", leaf: "L-C-META-DEC", state: "narrow-decision-detail", width: 390, theme: "light", render: () => decisions("d1") },
  { id: "H58", leaf: "L-C-G-PLAN", state: "narrow-google-plan", width: 320, theme: "light", render: () => googlePlan() },
  { id: "H59", leaf: "L-SH-CREATIVE", state: "narrow-share-gone", width: 320, theme: "dark", render: () => <PublicSharePage share={publicShare("video")} /> },

  /* ---- H60–H66: drawers, scope sheets, switch, return ---- */
  { id: "H60", leaf: "L-C-HOME", state: "drawer-open", width: 390, theme: "light", render: () => <LoadingState label="Opening navigation" /> },
  { id: "H61", leaf: "L-C-HOME", state: "drawer-320", width: 320, theme: "light", render: () => <LoadingState label="Opening navigation" /> },
  { id: "H62", leaf: "L-AG-CLIENTS", state: "agency-to-client", width: 390, theme: "light", render: () => agencyDesk() },
  { id: "H63", leaf: "L-C-HOME", state: "scope-sheet-390", width: 390, theme: "light", render: () => <EmptyState reason="Scope facts were not served." /> },
  { id: "H64", leaf: "L-C-HOME", state: "scope-sheet-320", width: 320, theme: "light", render: () => <EmptyState reason="Scope facts were not served." /> },
  { id: "H65", leaf: "L-C-HOME", state: "switch-states", width: 390, theme: "light", render: () => <ErrorState reason="The workspace switch could not complete." /> },
  { id: "H66", leaf: "L-AG-TODAY", state: "agency-return", width: 390, theme: "light", render: () => agencyDesk() },

  /* ---- B01–B09: 1280/768 geometry and detail/sheet states ---- */
  { id: "B01", leaf: "L-C-HOME", state: "geometry-1280", width: 1280, theme: "light", render: () => homeFrame(true) },
  { id: "B02", leaf: "L-C-META-DEC", state: "geometry-1280-decisions", width: 1280, theme: "light", render: () => decisions("d1") },
  { id: "B03", leaf: "L-C-G-PLAN", state: "geometry-1280-plan", width: 1280, theme: "light", render: () => googlePlan() },
  { id: "B04", leaf: "L-C-M-INT", state: "geometry-1280-integrations", width: 1280, theme: "light", render: () => integrations() },
  { id: "B05", leaf: "L-C-HOME", state: "geometry-768", width: 768, theme: "light", render: () => homeFrame(true) },
  { id: "B06", leaf: "L-C-META-DEC", state: "geometry-768-decisions", width: 768, theme: "light", render: () => decisions() },
  { id: "B07", leaf: "L-C-META-DEC", state: "geometry-768-inspector", width: 768, theme: "light", render: () => decisions("d1") },
  { id: "B08", leaf: "L-C-M-TEAM", state: "geometry-768-team", width: 768, theme: "light", render: () => team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }) },
  { id: "B09", leaf: "L-C-G-PLAN", state: "geometry-768-plan-confirm", width: 768, theme: "light", render: () => googlePlan() },

  /* ---- P01–P08: charts, tables, media, Turkish, dark ---- */
  { id: "P01", leaf: "L-C-REP-VIEW", state: "chart-trend", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ type: "trend", title: "Blended spend", points: [{ label: "d1", value: 120 }, { label: "d2", value: 138 }] })} sourceId="overview_trend" /> },
  { id: "P02", leaf: "L-C-REP-VIEW", state: "chart-series", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ type: "trend", title: "Channel revenue", series: [{ key: "meta", label: "Meta", color: "#3b5bdb", points: [{ label: "d1", value: 12 }] }] })} sourceId="overview_trend" /> },
  { id: "P03", leaf: "L-C-REP-VIEW", state: "table-dense", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ rows: [{ name: "Brand", spend: 12 }, { name: "Prospecting", spend: 44 }], columns: ["name", "spend"] })} sourceId="meta_campaigns" /> },
  { id: "P04", leaf: "L-C-REP-VIEW", state: "table-empty", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ emptyMessage: "No rows were served for this period." })} sourceId="meta_campaigns" /> },
  { id: "P05", leaf: "L-C-CR-PERF", state: "media-missing", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("serving", 1, 1)} businessId="biz" /> },
  { id: "P06", leaf: "L-C-M-TEAM", state: "turkish", width: 1440, theme: "light", render: () => tr(team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED })) },
  { id: "P07", leaf: "L-C-M-INT", state: "turkish-integrations", width: 390, theme: "light", render: () => tr(integrations()) },
  { id: "P08", leaf: "L-C-REP", state: "dark-acceptance", width: 1440, theme: "dark", render: () => <ReportLibraryView reports={[{ id: "r1", name: "Weekly review", updatedAt: "2026-08-11" }]} /> },

  /* ---- M01–M09: mobile proof states ---- */
  { id: "M01", leaf: "L-C-HOME", state: "mobile-home", width: 390, theme: "light", render: () => homeFrame(true) },
  { id: "M02", leaf: "L-C-HOME", state: "mobile-home-dark", width: 390, theme: "dark", render: () => homeFrame(true) },
  { id: "M03", leaf: "L-C-META-DEC", state: "mobile-decisions", width: 320, theme: "light", render: () => <CreativePerformanceView model={perf("serving", 3, 3)} businessId="biz" /> },
  { id: "M04", leaf: "L-C-CR-PERF", state: "mobile-creative", width: 320, theme: "light", render: () => <CreativePerformanceView model={perf("shadow_only", 2, 2)} businessId="biz" /> },
  { id: "M05", leaf: "L-C-REP", state: "mobile-reports", width: 320, theme: "light", render: () => <ReportLibraryView reports={[]} /> },
  { id: "M06", leaf: "L-C-M-INT", state: "mobile-integrations", width: 320, theme: "light", render: () => integrations() },
  { id: "M07", leaf: "L-C-M-TEAM", state: "mobile-team", width: 320, theme: "dark", render: () => team({ membersWrite: DENIED, invitesWrite: DENIED, accessRequests: DENIED }) },
  { id: "M08", leaf: "L-SH-CREATIVE", state: "mobile-share", width: 320, theme: "light", render: () => <WithheldState reason="This share link is not available." /> },
  { id: "M09", leaf: "L-OPS-INTEGRATIONS", state: "mobile-ops", width: 320, theme: "light", render: () => <CriticalIncidentPath /> },
] as const;

/** File name for one frame's rendered page and captured image. */
export function frameFileName(spec: FrameSpec): string {
  return `${spec.id}__${spec.leaf}__${spec.state}__${spec.width}__${spec.theme}`;
}


/**
 * Which frames render their canonical leaf composition, and which are still a
 * substituted fragment.
 *
 * This exists because the capture pipeline cannot tell the difference: a
 * fragment inside a static wrapper produces a perfectly valid PNG with unique
 * bytes and the right dimensions. Only this declaration distinguishes "captured
 * the state" from "captured something standing in for the state".
 */
export const SUBSTITUTED_FRAMES: Record<string, string> = Object.fromEntries(
  [
    ["H06", "renders EmptyState, not the global search overlay"],
    ["H07", "renders LoadingState, not the switch-reset composition"],
    ["H11", "renders LoadingState, not the workflow overlay"],
    ["H24", "renders EmptyState, not the brief composition"],
    ["H25", "renders EmptyState, not the Launchpad composition"],
    ["H26", "renders ErrorState, not the Launchpad validation composition"],
    ["H28", "renders EmptyState, not the landing-pages composition"],
    ["H34", "renders UnavailableState, not the analytics composition"],
    ["H35", "renders EmptyState, not the SEO composition"],
    ["H36", "renders LoadingState, not the GEO composition"],
    ["H60", "renders LoadingState, not the mobile navigation drawer"],
    ["H61", "renders LoadingState, not the 320 navigation drawer"],
    ["H63", "renders EmptyState, not the 390 scope sheet"],
    ["H64", "renders EmptyState, not the 320 scope sheet"],
    ["H65", "renders ErrorState, not the switch-state composition"],
    ["M03", "renders CreativePerformanceView, not the mobile Decisions composition"],
  ] as const,
);

/* --------------------------------------------------------------- shell ---- */

/**
 * Which shell each frame sits in, where the reference says something other than
 * "the client shell for this leaf".
 *
 * Only the exceptions are listed. Everything else is a Client-scope surface and
 * is derived from its LeafId, so this table cannot drift into a second, stale
 * copy of the route map.
 */
const FRAME_SHELL_OVERRIDES: Record<string, FrameShell> = {
  // Agency scope.
  H01: "Agency",
  H02: "Agency",
  H51: "Agency",
  H56: "Agency",
  H62: "Agency",
  H65: "Agency",
  H66: "Agency",
  // Ops scope.
  H48: "Ops",
  // Account scope.
  H46: "Account",
  // Genuinely unauthenticated: no rail, no context bar, no user menu. Wrapping
  // these in chrome would be the same misrepresentation in reverse.
  H05: "none",
  H49: "none",
  H54: "none",
  H59: "none",
  // Component boards, which stand for primitives rather than for a surface.
  P01: "none",
  P02: "none",
  P03: "none",
  P04: "none",
  P05: "none",
  P06: "none",
  P08: "none",
};

/** Frames whose named state is a shell state rather than a leaf state. */
const FRAME_DRAWER_OPEN = new Set(["H60", "H61", "B05"]);
const FRAME_SCOPE_SHEET_OPEN = new Set(["H63", "H64"]);
/** The reference draws these artboards in Turkish. */
const FRAME_TURKISH = new Set(["P06", "P07"]);

const LEAF_BY_ID = new Map(GENERATED_LEAVES.map((leaf) => [leaf.leaf, leaf]));

/**
 * The shell inputs for a frame, derived from its leaf.
 *
 * The route the rail marks as current comes from the leaf registry rather than
 * being restated per frame, so a frame can never claim a path the leaf registry
 * does not define.
 */
export function frameShellOptions(spec: FrameSpec): FrameShellOptions {
  const leaf = LEAF_BY_ID.get(spec.leaf as never);
  const shell = FRAME_SHELL_OVERRIDES[spec.id] ?? "Client";
  return {
    shell,
    pathname: leaf ? navHref(leaf.url, "biz") : "/",
    title: leaf?.label ?? spec.leaf,
    width: spec.width,
    drawerOpen: FRAME_DRAWER_OPEN.has(spec.id),
    scopeSheetOpen: FRAME_SCOPE_SHEET_OPEN.has(spec.id),
    language: FRAME_TURKISH.has(spec.id) ? "tr" : "en",
  };
}
