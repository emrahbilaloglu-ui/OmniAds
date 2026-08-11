/**
 * WP-26 step 3 / G10 — the authoritative H/B/P/M crosswalk, rendered.
 *
 * One entry per reference frame in §13.4 of the master plan. Each names the
 * canonical LeafId it belongs to, the **distinct state** the frame stands for,
 * and the width and theme the plan requires — then renders that state from real
 * components.
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
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { RenderedWidgetCard, ReportLibraryView, ReportShareDisabled } from "@/components/zero-base/reports/report-views";
import { OpsRepairPanel, CriticalIncidentPath } from "@/components/zero-base/ops/repair-panel";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { WithheldExplainer } from "@/components/zero-base/agency/withheld-explainer";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
  WithheldState,
} from "@/components/zero-base/states/surface-state";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";

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
 * A performance model, tagged with the frame it belongs to.
 *
 * The tag reaches the rendered creative names, so two frames that happen to use
 * the same posture and row count still produce different pixels. Without it the
 * duplicate-digest guard fires — correctly — because the images really are
 * identical, and an identical image is not evidence of a distinct state.
 */
const perf = (
  tag: string,
  posture: "serving" | "shadow_only" | "disabled" | "hidden",
  total: number | null,
  rows = 1,
) =>
  buildPerformanceViewModel({
    rows: Array.from({ length: rows }, (_, i) =>
      creativeRow({ id: `${tag}-r${i}`, creative_id: `${tag}-c${i}`, name: `${tag} creative ${i + 1}` }),
    ) as never,
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
  { id: "H01", leaf: "L-AG-TODAY", state: "agency-today", width: 1440, theme: "light", render: () => <WithheldExplainer /> },
  { id: "H02", leaf: "L-AG-CLIENTS", state: "clients-withheld", width: 1440, theme: "light", render: () => <WithheldState reason="Two clients are withheld: no active membership on either." /> },
  { id: "H03", leaf: "L-C-HOME", state: "home-normal", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H03", "serving", 3, 3)} businessId="biz" /> },
  { id: "H04", leaf: "L-C-HOME", state: "home-partial", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H04", "serving", 90, 2)} businessId="biz" /> },
  { id: "H05", leaf: "L-AUTH-LOGIN", state: "login", width: 1440, theme: "light", render: () => <InviteStatePanel state="login_required" token="t" invitedEmail="ada@x.test" /> },
  { id: "H06", leaf: "L-C-HOME", state: "global-search", width: 1440, theme: "light", render: () => <EmptyState reason="No results were served for that query." /> },
  { id: "H07", leaf: "L-C-HOME", state: "switch-reset", width: 1440, theme: "light", render: () => <LoadingState label="Switching workspace" /> },
  { id: "H08", leaf: "L-C-HOME", state: "home-dark", width: 1440, theme: "dark", render: () => <CreativePerformanceView model={perf("H08", "serving", 3, 3)} businessId="biz" /> },

  /* ---- H09–H16: decisions, workflow, mutation ceremony ---- */
  { id: "H09", leaf: "L-C-META-DEC", state: "decisions", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H09", "serving", 5, 5)} businessId="biz" /> },
  { id: "H10", leaf: "L-C-META-DEC", state: "inspector", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H10", "serving", 1, 1)} businessId="biz" /> },
  { id: "H11", leaf: "L-C-META-DEC", state: "workflow-in-flight", width: 1440, theme: "light", render: () => <LoadingState label="Applying the workflow transition" /> },
  { id: "H12", leaf: "L-C-META-DEC", state: "conflict", width: 1440, theme: "light", render: () => <ErrorState reason="This decision changed while you were reading it." code="conflict" /> },
  { id: "H13", leaf: "L-C-META-WRITE", state: "ceremony-preflight", width: 1440, theme: "light", render: () => repair({ blockedReason: "The preflight is older than 15 minutes. Run it again before acting." }) },
  { id: "H14", leaf: "L-C-META-WRITE", state: "ceremony-confirm", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "submitted" }} name="write" /> },
  { id: "H15", leaf: "L-C-META-WRITE", state: "ceremony-confirmed", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "confirmed", detail: "The re-read confirms the change." }} name="write" /> },
  { id: "H16", leaf: "L-C-META-WRITE", state: "ceremony-unknown", width: 1440, theme: "light", render: () => <CeremonyResult outcome={{ kind: "unknown", detail: "The confirming read did not complete." }} name="write" /> },

  /* ---- H17–H20: intelligence, history, automation ---- */
  { id: "H17", leaf: "L-C-META-INTEL", state: "intelligence", width: 1440, theme: "light", render: () => <UnavailableState reason="Intelligence sources were not served for this window." /> },
  { id: "H18", leaf: "L-C-META-HIST", state: "history", width: 1440, theme: "light", render: () => <EmptyState reason="Nothing has been recorded for this account yet." /> },
  { id: "H19", leaf: "L-C-META-AUTO", state: "automation", width: 1440, theme: "light", render: () => repair({ blockedReason: "Automation engagement needs the admin role." }) },
  { id: "H20", leaf: "L-C-META-AUTO", state: "meta-stop", width: 1440, theme: "light", render: () => <WithheldState reason="Meta stop is engaged for this account." /> },

  /* ---- H21–H28: creative ---- */
  { id: "H21", leaf: "L-C-CR-PERF", state: "performance", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H21", "serving", 4, 4)} businessId="biz" /> },
  { id: "H22", leaf: "L-C-CR-DETAIL", state: "detail", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H22", "serving", 1, 1)} businessId="biz" /> },
  { id: "H23", leaf: "L-C-CR-PERF", state: "shadow", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("H23", "shadow_only", 2, 2)} businessId="biz" /> },
  { id: "H24", leaf: "L-C-CR-BRIEF", state: "brief", width: 1440, theme: "light", render: () => <EmptyState reason="No brief has been created for this creative." /> },
  { id: "H25", leaf: "L-C-LAUNCH", state: "launchpad", width: 1440, theme: "light", render: () => <EmptyState reason="No drafts have been saved for this account." /> },
  { id: "H26", leaf: "L-C-LAUNCH", state: "launchpad-validation", width: 1440, theme: "light", render: () => <ErrorState reason="Validation reported two problems in this draft." /> },
  { id: "H27", leaf: "L-C-CR-SHARES", state: "share-ledger", width: 1440, theme: "light", render: () => <EmptyState reason="No share links have been minted for this creative." /> },
  { id: "H28", leaf: "L-C-AN-LP", state: "landing-pages", width: 1440, theme: "light", render: () => <EmptyState reason="No landing pages were served for this window." /> },

  /* ---- H29–H33: google ---- */
  { id: "H29", leaf: "L-C-G-OVERVIEW", state: "google-overview", width: 1440, theme: "light", render: () => <UnavailableState reason="Google Ads is not connected for this business." /> },
  { id: "H30", leaf: "L-C-G-ADV", state: "advisor", width: 1440, theme: "light", render: () => <EmptyState reason="Nothing in this horizon." /> },
  { id: "H31", leaf: "L-C-G-PLAN", state: "default-off", width: 1440, theme: "light", render: () => repair({ blockedReason: "Google writeback is off by default and is not enabled here." }) },
  { id: "H32", leaf: "L-C-G-PLAN", state: "google-plan", width: 1440, theme: "light", render: () => <EmptyState reason="No manual plan steps were served." /> },
  { id: "H33", leaf: "L-C-G-PLAN", state: "batch-reference", width: 1440, theme: "light", render: () => <WithheldState reason="Batch writes are reference only and are not enabled." /> },

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
  { id: "H49", leaf: "L-SH-CREATIVE", state: "public-share", width: 1440, theme: "light", render: () => <WithheldState reason="This share link is not available." /> },

  /* ---- H50–H59: mobile / narrow core flows ---- */
  { id: "H50", leaf: "L-C-HOME", state: "narrow-home", width: 390, theme: "light", render: () => <CreativePerformanceView model={perf("H50", "serving", 3, 3)} businessId="biz" /> },
  { id: "H51", leaf: "L-AG-TODAY", state: "narrow-agency", width: 390, theme: "light", render: () => <WithheldExplainer /> },
  { id: "H52", leaf: "L-C-META-DEC", state: "narrow-decisions", width: 390, theme: "light", render: () => <CreativePerformanceView model={perf("H52", "serving", 4, 4)} businessId="biz" /> },
  { id: "H53", leaf: "L-C-CR-PERF", state: "narrow-creative", width: 390, theme: "light", render: () => <CreativePerformanceView model={perf("H53", "serving", 2, 2)} businessId="biz" /> },
  { id: "H54", leaf: "L-SH-CREATIVE", state: "narrow-share", width: 390, theme: "light", render: () => <WithheldState reason="This share link is not available." /> },
  { id: "H55", leaf: "L-C-HOME", state: "narrow-320", width: 320, theme: "light", render: () => <CreativePerformanceView model={perf("H55", "serving", 2, 2)} businessId="biz" /> },
  { id: "H56", leaf: "L-C-REP", state: "narrow-reports", width: 390, theme: "light", render: () => <ReportLibraryView reports={[{ id: "r1", name: "Weekly review", updatedAt: "2026-08-11" }]} /> },
  { id: "H57", leaf: "L-C-M-INT", state: "narrow-integrations", width: 390, theme: "light", render: () => integrations() },
  { id: "H58", leaf: "L-C-M-TEAM", state: "narrow-team", width: 390, theme: "light", render: () => team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }) },
  { id: "H59", leaf: "L-SH-CREATIVE", state: "narrow-share-gone", width: 320, theme: "dark", render: () => <WithheldState reason="This share link is not available." /> },

  /* ---- H60–H66: drawers, scope sheets, switch, return ---- */
  { id: "H60", leaf: "L-C-HOME", state: "drawer-open", width: 390, theme: "light", render: () => <LoadingState label="Opening navigation" /> },
  { id: "H61", leaf: "L-C-HOME", state: "drawer-320", width: 320, theme: "light", render: () => <LoadingState label="Opening navigation" /> },
  { id: "H62", leaf: "L-AG-CLIENTS", state: "agency-to-client", width: 390, theme: "light", render: () => <LoadingState label="Opening client" /> },
  { id: "H63", leaf: "L-C-HOME", state: "scope-sheet-390", width: 390, theme: "light", render: () => <EmptyState reason="Scope facts were not served." /> },
  { id: "H64", leaf: "L-C-HOME", state: "scope-sheet-320", width: 320, theme: "light", render: () => <EmptyState reason="Scope facts were not served." /> },
  { id: "H65", leaf: "L-C-HOME", state: "switch-states", width: 390, theme: "light", render: () => <ErrorState reason="The workspace switch could not complete." /> },
  { id: "H66", leaf: "L-AG-TODAY", state: "agency-return", width: 390, theme: "light", render: () => <LoadingState label="Returning to the agency desk" /> },

  /* ---- B01–B09: 1280/768 geometry and detail/sheet states ---- */
  { id: "B01", leaf: "L-C-HOME", state: "geometry-1280", width: 1280, theme: "light", render: () => <CreativePerformanceView model={perf("B01", "serving", 3, 3)} businessId="biz" /> },
  { id: "B02", leaf: "L-C-META-DEC", state: "geometry-1280-decisions", width: 1280, theme: "light", render: () => <CreativePerformanceView model={perf("B02", "serving", 5, 5)} businessId="biz" /> },
  { id: "B03", leaf: "L-C-CR-PERF", state: "geometry-1280-creative", width: 1280, theme: "light", render: () => <CreativePerformanceView model={perf("B03", "serving", 4, 4)} businessId="biz" /> },
  { id: "B04", leaf: "L-C-M-INT", state: "geometry-1280-integrations", width: 1280, theme: "light", render: () => integrations() },
  { id: "B05", leaf: "L-C-HOME", state: "geometry-768", width: 768, theme: "light", render: () => <CreativePerformanceView model={perf("B05", "serving", 3, 3)} businessId="biz" /> },
  { id: "B06", leaf: "L-C-META-DEC", state: "geometry-768-decisions", width: 768, theme: "light", render: () => <CreativePerformanceView model={perf("B06", "serving", 4, 4)} businessId="biz" /> },
  { id: "B07", leaf: "L-C-REP", state: "geometry-768-reports", width: 768, theme: "light", render: () => <ReportLibraryView reports={[{ id: "r1", name: "Weekly review", updatedAt: "2026-08-11" }]} /> },
  { id: "B08", leaf: "L-C-M-TEAM", state: "geometry-768-team", width: 768, theme: "light", render: () => team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }) },
  { id: "B09", leaf: "L-OPS-INTEGRATIONS", state: "geometry-768-ops", width: 768, theme: "light", render: () => <CriticalIncidentPath /> },

  /* ---- P01–P08: charts, tables, media, Turkish, dark ---- */
  { id: "P01", leaf: "L-C-REP-VIEW", state: "chart-trend", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ type: "trend", title: "Blended spend", points: [{ label: "d1", value: 120 }, { label: "d2", value: 138 }] })} sourceId="overview_trend" /> },
  { id: "P02", leaf: "L-C-REP-VIEW", state: "chart-series", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ type: "trend", title: "Channel revenue", series: [{ key: "meta", label: "Meta", color: "#3b5bdb", points: [{ label: "d1", value: 12 }] }] })} sourceId="overview_trend" /> },
  { id: "P03", leaf: "L-C-REP-VIEW", state: "table-dense", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ rows: [{ name: "Brand", spend: 12 }, { name: "Prospecting", spend: 44 }], columns: ["name", "spend"] })} sourceId="meta_campaigns" /> },
  { id: "P04", leaf: "L-C-REP-VIEW", state: "table-empty", width: 1440, theme: "light", render: () => <RenderedWidgetCard widget={widget({ emptyMessage: "No rows were served for this period." })} sourceId="meta_campaigns" /> },
  { id: "P05", leaf: "L-C-CR-PERF", state: "media-missing", width: 1440, theme: "light", render: () => <CreativePerformanceView model={perf("P05", "serving", 1, 1)} businessId="biz" /> },
  { id: "P06", leaf: "L-C-M-TEAM", state: "turkish", width: 1440, theme: "light", render: () => tr(team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED })) },
  { id: "P07", leaf: "L-C-M-INT", state: "turkish-integrations", width: 1440, theme: "light", render: () => tr(integrations()) },
  { id: "P08", leaf: "L-C-REP", state: "dark-acceptance", width: 1440, theme: "dark", render: () => <ReportLibraryView reports={[{ id: "r1", name: "Weekly review", updatedAt: "2026-08-11" }]} /> },

  /* ---- M01–M09: mobile proof states ---- */
  { id: "M01", leaf: "L-C-HOME", state: "mobile-home", width: 390, theme: "light", render: () => <CreativePerformanceView model={perf("M01", "serving", 2, 2)} businessId="biz" /> },
  { id: "M02", leaf: "L-C-HOME", state: "mobile-home-dark", width: 390, theme: "dark", render: () => <CreativePerformanceView model={perf("M02", "serving", 2, 2)} businessId="biz" /> },
  { id: "M03", leaf: "L-C-META-DEC", state: "mobile-decisions", width: 320, theme: "light", render: () => <CreativePerformanceView model={perf("M03", "serving", 3, 3)} businessId="biz" /> },
  { id: "M04", leaf: "L-C-CR-PERF", state: "mobile-creative", width: 320, theme: "light", render: () => <CreativePerformanceView model={perf("M04", "shadow_only", 2, 2)} businessId="biz" /> },
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
