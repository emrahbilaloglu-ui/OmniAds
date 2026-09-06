"use client";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  Cloud,
  Megaphone,
  PlusCircle,
  Settings2,
  Shield,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { useAppStore } from "@/store/app-store";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  fetchCreativeDecisionEngineV3,
  fetchMetaCreatives,
  mapApiRowToUiRow,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import {
  amountFromMinorUnits,
  amountToMinorUnits,
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
  type MetaAddToExistingPayload,
  type MetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  LaunchpadCreativeSelection,
  buildLaunchpadSelectionSummary,
} from "@/components/launchpad/LaunchpadCreativeSelection";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import {
  LaunchpadCampaignBasics,
  type LaunchpadCampaignBasicsState,
} from "@/components/launchpad/LaunchpadCampaignBasics";
import {
  LaunchpadBudget,
  type LaunchpadBudgetState,
} from "@/components/launchpad/LaunchpadBudget";
import {
  LaunchpadAdSets,
  makeDefaultLaunchpadAdSet,
  type LaunchpadAdSetState,
} from "@/components/launchpad/LaunchpadAdSets";
import {
  LaunchpadAddToExistingTarget,
  makeDefaultAddToExistingTargetState,
  defaultCreativeAddName,
  getSelectedExistingCampaigns,
  getSelectedExistingTargets,
  type LaunchpadAddToExistingState,
} from "@/components/launchpad/LaunchpadAddToExistingTarget";
import { LaunchpadReview } from "@/components/launchpad/LaunchpadReview";
import { LAUNCHPAD_CANDIDATE_WINDOW_DAYS } from "@/lib/launchpad/candidate-window";
import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";
import {
  LaunchpadProgress,
  type LaunchpadProgressResult,
} from "@/components/launchpad/LaunchpadProgress";
import { LaunchpadManageExistingReview } from "@/components/launchpad/LaunchpadManageExistingReview";
import { LaunchpadActivationPanel } from "@/components/launchpad/LaunchpadActivationPanel";
import { normalizeCurrencyCode } from "@/components/creatives/money";
import {
  DEFAULT_ATTRIBUTION_PRESET_ID,
  findMatchingAttributionPreset,
  getAttributionPresetById,
  type MetaAttributionSpecItem,
} from "@/lib/launchpad/attribution-presets";
import {
  applyRecentAdActionsToRows,
  resolveLaunchpadAdActionId,
  type LaunchpadRecentAdAction,
} from "@/lib/launchpad/recent-ad-actions";
import { cn } from "@/lib/utils";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type {
  MetaLaunchIntent,
  MetaLaunchIntentCapability,
} from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchStoreCapability } from "@/lib/launchpad/meta-store-capability";
import type { MetaLaunchpadManualAuthority } from "@/lib/launchpad/meta-manual-authority";
import {
  LAUNCHPAD_HANDOFF_PREFILL_NONE,
  type LaunchpadHandoffPrefill,
  type LaunchpadHandoffPrefillEnvelope,
} from "@/lib/meta/launchpad-handoff-contract";
import {
  LAUNCHPAD_VIEWER_NOT_ESTABLISHED,
  type LaunchpadViewerEnvelope,
} from "./viewer-envelope";
import { LaunchIntentReceiptRows } from "./LaunchIntentReceiptRows";
import styles from "./page.module.css";
import {
  resolveMetaSurfaceReadState,
  type MetaSurfaceSource,
} from "@/lib/meta/surface-read-state";
import type { MetaFailureCode } from "@/lib/meta/read-state-contract";
import { publishMetaSurfaceState } from "@/components/meta/meta-surface-state-live";

type LaunchpadMode = "new_campaign" | "add_to_existing" | "manage_existing";
type WizardStep =
  | "source"
  | "scope"
  | "creatives"
  | "basics"
  | "adsets"
  | "review"
  | "progress";
type MetaBriefingLaunchMode = "rebuild" | "duplicate" | "apply_bid";

interface LaunchpadLegacyHandoff {
  source: "decision" | "brief";
  requestedMode: MetaBriefingLaunchMode | null;
  creativeIds: string[];
  campaignIds: string[];
  adsetIds: string[];
  sourceDecisionId: string | null;
  sourceDecisionSnapshotId: string | null;
  creativeBriefId: string | null;
}

interface LaunchTemplate {
  id: string;
  providerAccountId: string;
  name: string;
  description: string | null;
  source: "manual" | "auto_recent";
  payload: MetaLaunchPayload;
  updatedAt?: string;
}
interface LaunchDraft {
  id: string;
  providerAccountId: string;
  name: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
  status: "draft" | "queued" | "launched" | "failed";
  updatedAt: string;
  lastError?: Record<string, unknown> | null;
}

type LaunchStartRole = "rebuild" | "duplicate" | "manual";

/** The design's three fixed launch-start roles. */
const LAUNCH_START_CARDS: Array<{
  role: LaunchStartRole;
  mode: LaunchpadMode;
  chip: string;
  cta: string;
  /**
   * Static copy from the design, not a served value.
   *
   * These two lines rendered as a bare em dash because the card as a whole was
   * treated as data-bound. Only the title carries a served name; the sentence
   * under it says what the mode does and needs nothing from the server, so a
   * dash there stated a missing fact that was never missing.
   */
  description: string;
}> = [
  {
    role: "rebuild",
    mode: "new_campaign",
    chip: "Rebuild",
    cta: "Continue draft",
    description:
      "Routed from Decisions with evidence attached. Fresh structure, fatigued creative excluded.",
  },
  {
    role: "duplicate",
    mode: "add_to_existing",
    chip: "Duplicate",
    cta: "Continue draft",
    description:
      "Clone the winning structure into a new market with its own budget and target pack.",
  },
  {
    role: "manual",
    mode: "new_campaign",
    chip: "Manual",
    cta: "New blank draft",
    description:
      "Blank campaign draft. Validation and the PAUSED boundary apply the same way.",
  },
];

const LAUNCH_STEPS: Array<{
  id: Exclude<WizardStep, "progress">;
  label: string;
}> = [
  { id: "source", label: "Source & mode" },
  { id: "scope", label: "Account & scope" },
  { id: "creatives", label: "Creative selection" },
  { id: "basics", label: "Campaign & budget" },
  { id: "adsets", label: "Ad sets & targeting" },
  { id: "review", label: "Review" },
];

function launchpadModeFromQuery(value: string | null): LaunchpadMode {
  return value === "add_to_existing" || value === "manage_existing"
    ? value
    : "new_campaign";
}

function launchpadStepFromQuery(value: string | null): WizardStep {
  const steps: WizardStep[] = [
    "source",
    "scope",
    "creatives",
    "basics",
    "adsets",
    "review",
    "progress",
  ];
  return steps.includes(value as WizardStep) ? (value as WizardStep) : "source";
}

function launchpadModeLabel(mode: LaunchpadMode) {
  if (mode === "add_to_existing") return "Add to existing";
  if (mode === "manage_existing") return "Manage existing ads";
  return "New campaign";
}

function isoDateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}


function defaultCampaignName() {
  return `Meta Sales Launch ${todayIso()}`;
}

function countriesFromInput(value: string) {
  return value
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
}

function parseLaunchpadLegacyHandoff(
  query: string,
): LaunchpadLegacyHandoff | null {
  const params = new URLSearchParams(query);
  const sourceDecisionId = params.get("sourceDecisionId")?.trim() || null;
  const sourceDecisionSnapshotId =
    params.get("sourceDecisionSnapshotId")?.trim() || null;
  const creativeBriefId = params.get("creativeBriefId")?.trim() || null;
  const source =
    creativeBriefId || params.get("fromBriefing") === "true"
      ? "brief"
      : sourceDecisionId ||
          sourceDecisionSnapshotId ||
          params.get("fromMetaBriefing") === "true"
        ? "decision"
        : null;
  if (!source) return null;
  const parseIds = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((id) => decodeURIComponent(id.trim()))
      .filter(Boolean);
  const rawMode = params.get("mode");
  const requestedMode =
    rawMode === "rebuild" || rawMode === "duplicate" || rawMode === "apply_bid"
      ? rawMode
      : null;
  return {
    source,
    requestedMode,
    creativeIds: parseIds("creativeIds"),
    campaignIds: parseIds("campaignIds"),
    adsetIds: parseIds("adsetIds"),
    sourceDecisionId,
    sourceDecisionSnapshotId,
    creativeBriefId,
  };
}

function hasCompleteLaunchpadLineageIdentifiers(
  handoff: LaunchpadLegacyHandoff | null,
): boolean {
  if (!handoff) return false;
  if (handoff.source === "brief") return Boolean(handoff.creativeBriefId);
  return Boolean(handoff.sourceDecisionId && handoff.sourceDecisionSnapshotId);
}

/**
 * URL lineage identifiers are not execution authority. The current handoff
 * contract does not forward server-owned decisionState, authorizedAction and
 * actionEligible fields, so non-manual handoffs must remain fail-closed.
 */
function hasServerAuthorizedLaunchpadHandoff(
  _handoff: LaunchpadLegacyHandoff | null,
): boolean {
  return false;
}

function attributionSpecFromState(adSet: LaunchpadAdSetState) {
  return adSet.attributionSpec.map((item) => ({
    eventType: item.event_type,
    windowDays: item.window_days,
  }));
}

function stateFromPayloadAdSet(
  adSet: MetaLaunchPayload["adSets"][number],
  index: number,
): LaunchpadAdSetState {
  const attributionSpec: MetaAttributionSpecItem[] = adSet.attributionSpec.map(
    (item) => ({
      event_type: item.eventType,
      window_days: item.windowDays,
    }),
  );
  const preset = findMatchingAttributionPreset(attributionSpec);
  return {
    clientId: adSet.clientId || `template-adset-${index + 1}`,
    name: adSet.name,
    optimizationGoal: adSet.optimizationGoal,
    pixelId: adSet.pixelId,
    customEventType: adSet.customEventType,
    countries: adSet.targeting.countries.join(", "),
    ageMin: String(adSet.targeting.ageMin),
    ageMax: String(adSet.targeting.ageMax),
    advantageAudience: adSet.targeting.advantageAudience,
    advantagePlacements: adSet.targeting.advantagePlacements,
    publisherPlatforms: adSet.targeting.publisherPlatforms ?? [],
    facebookPositions: adSet.targeting.facebookPositions ?? [],
    instagramPositions: adSet.targeting.instagramPositions ?? [],
    attributionPresetId: preset?.id ?? "custom",
    attributionSpec:
      attributionSpec.length > 0
        ? attributionSpec
        : (getAttributionPresetById(DEFAULT_ATTRIBUTION_PRESET_ID)
            ?.attributionSpec ?? [
            { event_type: "CLICK_THROUGH", window_days: 7 },
          ]),
    budgetAmount: adSet.budget?.amountMinor
      ? amountFromMinorUnits(adSet.budget.amountMinor)
      : "",
    bidStrategy: adSet.budget?.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
    bidAmount: adSet.budget?.bidAmountMinor
      ? amountFromMinorUnits(adSet.budget.bidAmountMinor)
      : "",
  };
}

/**
 * One library read, with the difference between "the server said none" and
 * "the server did not say" preserved.
 *
 * This used to return `null` for every non-OK response, and a null payload
 * read out as `[]`. So a 403 became an empty library — and 403 is the ordinary
 * answer here, not an edge case: the read goes through
 * `requireLaunchpadBusinessAccess`, which is hardcoded to
 * `minRole: "collaborator"` (app/api/launchpad/meta/route-utils.ts line 49).
 * There is no guest-read contract for drafts, templates or intents.
 * A guest therefore got a page that said, in the same em dashes a real empty
 * account shows, that this workspace has no drafts and no receipts. That is a
 * refusal rendered as a measurement.
 */
type LaunchpadRead =
  | { ok: true; payload: unknown }
  | { ok: false; httpStatus: number | null };

async function readLaunchpadJson(url: string): Promise<LaunchpadRead> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, httpStatus: response.status };
    const payload = (await response.json().catch(() => null)) as unknown;
    // A body that will not parse is an unread response, not an empty one.
    if (payload === null) return { ok: false, httpStatus: null };
    return { ok: true, payload };
  } catch {
    return { ok: false, httpStatus: null };
  }
}

export const LAUNCHPAD_LIBRARY_REFUSED_MESSAGE =
  "Saved drafts, templates and receipts are not readable for this viewer, so none are listed here.";

export const LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE =
  "Saved drafts, templates and receipts could not be read, so none are listed here.";

/**
 * The store exists in the product and not yet in this database.
 *
 * Distinct from both sentences above: nothing was refused and nothing failed —
 * a pending migration means the table cannot be read at all, and an operator
 * told "could not be read" would go looking for an outage. §9.1's own words
 * for `schema_not_ready` are "It is unavailable, not empty."
 */
export const LAUNCHPAD_LIBRARY_MIGRATION_MESSAGE =
  "Saved drafts, templates and receipts are not readable until a pending database migration is applied. They are unavailable here, not empty.";

function launchpadReadPayload(read: LaunchpadRead): unknown {
  return read.ok ? read.payload : null;
}

function launchStoreCapabilityFromPayload(
  payload: unknown,
): MetaLaunchStoreCapability | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const capability = (payload as { capability?: unknown }).capability;
  if (
    !capability ||
    typeof capability !== "object" ||
    Array.isArray(capability)
  )
    return null;
  const candidate = capability as Partial<MetaLaunchStoreCapability>;
  if (
    (candidate.status !== "ready" &&
      candidate.status !== "migration_required") ||
    typeof candidate.canRead !== "boolean" ||
    typeof candidate.canWrite !== "boolean" ||
    !Array.isArray(candidate.missingColumns)
  ) {
    return null;
  }
  return {
    status: candidate.status,
    canRead: candidate.canRead,
    canWrite: candidate.canWrite,
    missingColumns: candidate.missingColumns.filter(
      (column): column is string => typeof column === "string",
    ),
  };
}

/**
 * Everything Launchpad needs at first load, in one request.
 *
 * This used to be four requests, and three more sat beside them: the assigned
 * account list, recent ad actions, and the business target CPA. Seven requests
 * asked the same question about the same account at the same instant, which is
 * why the surface measured 18 first-load reads against a budget of 12.
 * `/api/launchpad/meta/workspace` composes them server-side.
 *
 * What did NOT change:
 *
 * - **Scope.** The composed route resolves the account through the same
 *   `resolveAssignedMetaLaunchAccount` the seven routes call, and the rows are
 *   still filtered to `providerAccountId` here as they were before.
 * - **Freshness.** Every folded read is `force-dynamic` and uncached, and so is
 *   the composed one.
 * - **Reporting.** The four §9 outcomes below keep their ids, their row counts
 *   and their meaning. `resolveMetaSurfaceReadState` is still the only thing
 *   that turns them into a state; this reports observations, as it always did.
 *
 * A section the server did not report on was NOT read — the route omits the
 * account-scoped sections when no account resolves — and that is a failure to
 * read, never an empty list.
 */
export interface LaunchpadWorkspaceRead {
  accounts: MetaHistoryAccount[];
  accountsRead: boolean;
  accountBlocker: { code: string; message: string } | null;
  readOutcomes: MetaSurfaceSource[];
  unavailableMessage: string | null;
  templates: LaunchTemplate[];
  drafts: LaunchDraft[];
  intents: MetaLaunchIntent[];
  launchIntentCapability: MetaLaunchIntentCapability | null;
  draftCapability: MetaLaunchStoreCapability | null;
  templateCapability: MetaLaunchStoreCapability | null;
  recentAdActions: LaunchpadRecentAdAction[];
  targetCpa: number | null;
}

export async function loadLaunchpadWorkspace(
  businessId: string,
  providerAccountId: string,
): Promise<LaunchpadWorkspaceRead> {
  const params = new URLSearchParams({ businessId });
  if (providerAccountId) params.set("providerAccountId", providerAccountId);
  const read = await readLaunchpadJson(
    `/api/launchpad/meta/workspace?${params.toString()}`,
  );
  const payload = launchpadReadPayload(read);
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const sections =
    body &&
    typeof body.sections === "object" &&
    body.sections !== null &&
    !Array.isArray(body.sections)
      ? (body.sections as Record<
          string,
          { status?: unknown; errorCode?: unknown } | undefined
        >)
      : {};
  const sectionRead = (key: string) => sections[key]?.status === "complete";
  const httpStatus = read.ok ? null : read.httpStatus;
  /*
   * A refusal to read and a failure to read say different things to an
   * operator, and always did. Two things can carry that difference: the
   * transport status when the whole request was refused, and — because the
   * account list is `guest`-readable while the library is not — the server's
   * own per-section code on a 200 that carries both answers at once.
   */
  const transportFailureCode: MetaFailureCode =
    httpStatus === 401 || httpStatus === 403
      ? "capability_read_denied"
      : "source_read_failed";
  /*
   * The server's own §9.1 code wins, and only a code the closed vocabulary
   * declares is carried. `schema_not_ready` means the store could not be read
   * at all — its own sentence is "It is unavailable, not empty" — and
   * `insufficient_role` means this membership may read the account list and
   * not the library.
   */
  const SERVED_SECTION_CODES = [
    "schema_not_ready",
    "insufficient_role",
    "capability_read_denied",
  ] as const satisfies ReadonlyArray<MetaFailureCode>;
  const sectionFailureCode = (key: string): MetaFailureCode => {
    const served = sections[key]?.errorCode;
    const declared = SERVED_SECTION_CODES.find((code) => code === served);
    return declared ?? transportFailureCode;
  };
  /*
   * `not-ready` and `failed` are different §9 outcomes and mean different
   * things: `not-ready` is "this cannot be read yet — schema, capability or
   * migration", which is exactly what an unmigrated Launchpad store is. It was
   * reported as `empty`, because the composite route substituted an empty
   * array for the read it never made and then stamped the section complete.
   */
  const sectionNotReady = (key: string) =>
    sections[key]?.errorCode === "schema_not_ready";

  const scoped = <T,>(key: string): T[] => {
    const value = body?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        (row as { providerAccountId?: unknown }).providerAccountId ===
          providerAccountId,
    ) as T[];
  };

  const manualTemplates = scoped<LaunchTemplate>("templates");
  const recentTemplates = scoped<LaunchTemplate>("recentTemplates");
  const draftRows = scoped<LaunchDraft>("drafts");
  const intentRows = scoped<MetaLaunchIntent>("intents");

  const readOutcomes: MetaSurfaceSource[] = (
    [
      {
        id: "templates",
        section: "templates",
        rows: manualTemplates.length + recentTemplates.length,
      },
      {
        id: "recent-templates",
        section: "recentTemplates",
        rows: recentTemplates.length,
      },
      { id: "drafts", section: "drafts", rows: draftRows.length },
      { id: "receipts", section: "intents", rows: intentRows.length },
    ] as const
  ).map(({ id, section, rows }) => ({
    id,
    outcome: sectionRead(section)
      ? rows > 0
        ? ("served" as const)
        : ("empty" as const)
      : sectionNotReady(section)
        ? ("not-ready" as const)
        : ("failed" as const),
    rowCount: rows,
    failureCode: sectionRead(section) ? undefined : sectionFailureCode(section),
  }));

  const capability =
    body &&
    typeof body.capability === "object" &&
    body.capability !== null &&
    !Array.isArray(body.capability)
      ? (body.capability as Record<string, unknown>)
      : {};
  const rawAccounts = body?.accounts;
  const blocker =
    body &&
    typeof body.accountBlocker === "object" &&
    body.accountBlocker !== null &&
    !Array.isArray(body.accountBlocker)
      ? (body.accountBlocker as { code?: unknown; message?: unknown })
      : null;
  const targetCpa = body?.targetCpa;

  return {
    accounts: Array.isArray(rawAccounts)
      ? (rawAccounts as MetaHistoryAccount[])
      : [],
    accountsRead: sectionRead("accounts"),
    accountBlocker:
      typeof blocker?.code === "string" && typeof blocker.message === "string"
        ? { code: blocker.code, message: blocker.message }
        : null,
    readOutcomes,
    // Non-null exactly when at least one of the four sections was not read.
    // Carried beside the rows rather than folded into them, because an empty
    // array is the one thing this state must not be mistaken for.
    /*
     * Non-null exactly when at least one of the four sections was not read.
     * Carried beside the rows rather than folded into them, because an empty
     * array is the one thing this state must not be mistaken for.
     *
     * The sentence follows the §9.1 code the SERVER sent, so a migration, a
     * refusal and a failed read are three different sentences rather than one.
     */
    unavailableMessage: (() => {
      const unread = readOutcomes.filter(
        (source) => source.outcome === "failed" || source.outcome === "not-ready",
      );
      if (unread.length === 0) return null;
      if (unread.some((source) => source.failureCode === "schema_not_ready")) {
        return LAUNCHPAD_LIBRARY_MIGRATION_MESSAGE;
      }
      return unread.some(
        (source) =>
          source.failureCode === "capability_read_denied" ||
          source.failureCode === "insufficient_role",
      )
        ? LAUNCHPAD_LIBRARY_REFUSED_MESSAGE
        : LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE;
    })(),
    templates: [...recentTemplates, ...manualTemplates],
    drafts: draftRows,
    intents: intentRows,
    launchIntentCapability: launchIntentCapabilityFromPayload({
      capability: capability.intents,
    }),
    draftCapability: launchStoreCapabilityFromPayload({
      capability: capability.drafts,
    }),
    templateCapability: launchStoreCapabilityFromPayload({
      capability: capability.templates,
    }),
    recentAdActions: (Array.isArray(body?.recentAdActions)
      ? (body.recentAdActions as LaunchpadRecentAdAction[])
      : []
    ).filter((action) => action.accountId === providerAccountId),
    // Read, never derived. Anything that is not a positive finite number is
    // absent, and an absent target hides the budget warning rather than
    // guessing one.
    targetCpa:
      typeof targetCpa === "number" &&
      Number.isFinite(targetCpa) &&
      targetCpa > 0
        ? targetCpa
        : null,
  };
}

/**
 * One draft's server verdict. A transport failure or an account blocker is
 * reported as `unavailable`, never as "Ready" and never as a blocker count the
 * server did not return.
 */
export async function readLaunchpadDraftValidation(input: {
  businessId: string;
  providerAccountId: string;
  draft: Pick<LaunchDraft, "payload">;
}): Promise<LaunchpadDraftValidation> {
  try {
    const response = await fetch("/api/launchpad/meta/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        payload: input.draft.payload,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      blockers?: unknown;
    } | null;
    if (!body || typeof body.ok !== "boolean" || !Array.isArray(body.blockers)) {
      return { status: "unavailable" };
    }
    return {
      status: "checked",
      ok: body.ok,
      blockerCount: body.blockers.length,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Every draft on the page, in one request.
 *
 * A draft that the server did not answer for stays `unavailable` rather than
 * inheriting a neighbour's verdict, and a transport failure marks the whole
 * page unavailable — never "Ready".
 */
export async function readLaunchpadDraftValidations(input: {
  businessId: string;
  providerAccountId: string;
  drafts: ReadonlyArray<Pick<LaunchDraft, "id" | "payload">>;
}): Promise<Record<string, LaunchpadDraftValidation>> {
  const unavailable = () =>
    Object.fromEntries(
      input.drafts.map((draft) => [
        draft.id,
        { status: "unavailable" } as LaunchpadDraftValidation,
      ]),
    );
  try {
    const response = await fetch("/api/launchpad/meta/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        payloads: input.drafts.map((draft) => ({
          key: draft.id,
          payload: draft.payload,
        })),
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      results?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true || !Array.isArray(body.results)) {
      return unavailable();
    }
    const byKey = new Map<string, LaunchpadDraftValidation>();
    for (const entry of body.results) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as {
        key?: unknown;
        ok?: unknown;
        blockers?: unknown;
      };
      if (typeof row.key !== "string") continue;
      if (typeof row.ok !== "boolean" || !Array.isArray(row.blockers)) {
        byKey.set(row.key, { status: "unavailable" });
        continue;
      }
      byKey.set(row.key, {
        status: "checked",
        ok: row.ok,
        blockerCount: row.blockers.length,
      });
    }
    return Object.fromEntries(
      input.drafts.map((draft) => [
        draft.id,
        byKey.get(draft.id) ?? { status: "unavailable" },
      ]),
    );
  } catch {
    return unavailable();
  }
}

function launchIntentCapabilityFromPayload(
  payload: unknown,
): MetaLaunchIntentCapability | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const capability = (payload as Record<string, unknown>).capability;
  if (
    !capability ||
    typeof capability !== "object" ||
    Array.isArray(capability)
  ) {
    return null;
  }
  const record = capability as Record<string, unknown>;
  if (
    (record.status !== "ready" && record.status !== "migration_required") ||
    typeof record.canRead !== "boolean" ||
    typeof record.canWrite !== "boolean" ||
    !Array.isArray(record.missingTables) ||
    typeof record.checkedAt !== "string"
  ) {
    return null;
  }
  return {
    status: record.status,
    canRead: record.canRead,
    canWrite: record.canWrite,
    missingTables: record.missingTables.filter(
      (value): value is string => typeof value === "string",
    ),
    checkedAt: record.checkedAt,
  };
}

function formatRelativeTime(value: string | undefined) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function makePlaceholderCampaign(
  target: MetaAddToExistingPayload["targets"][number],
): LaunchpadAddToExistingState["targetCampaign"] {
  if (!target.targetCampaignId) return null;
  return {
    id: target.targetCampaignId,
    name: target.targetCampaignName || target.targetCampaignId,
    objective: "OUTCOME_SALES",
    status: null,
    effectiveStatus: null,
    dailyBudgetMinor: null,
    lifetimeBudgetMinor: null,
    isAdsetBudgetSharingEnabled: true,
    adsetCount: target.targetAdsetId ? 1 : 0,
    lastSpend28d: 0,
  };
}

function makePlaceholderAdset(
  target: MetaAddToExistingPayload["targets"][number],
): LaunchpadAddToExistingState["targetAdset"] {
  if (!target.targetAdsetId) return null;
  return {
    id: target.targetAdsetId,
    name: target.targetAdsetName || target.targetAdsetId,
    status: null,
    effectiveStatus: null,
    optimizationGoal: null,
    billingEvent: null,
    pixelId: null,
    customEventType: null,
    dailyBudgetMinor: null,
    lifetimeBudgetMinor: null,
    attributionSpec: [],
    attributionSummary: "Inherited from existing ad set",
    targeting: {
      geoCountries: [],
      ageMin: 18,
      ageMax: 65,
      advantageAudience: true,
      placementSummary: "Inherited",
    },
    currentAdCount: 0,
    last7dSpend: 0,
    last7dRoas: null,
  };
}

export interface MetaLaunchpadPageProps {
  businessId?: string;
  businessName?: string | null;
  /**
   * `undefined` keeps the legacy account picker contract. `null` is an
   * authoritative server result and must never be widened by URL/store state.
   */
  providerAccountId?: string | null;
  /**
   * Who is looking, decided entirely by the server: role, reviewer status,
   * demo status, whether a write may be attempted at all, and the reason when
   * it may not. This surface renders it; it must never recompute any part of
   * it. `undefined` is the preserved legacy mount, which establishes none of
   * these facts — the write routes still refuse on their own authority.
   *
   * @see ./viewer-envelope.ts
   */
  viewer?: LaunchpadViewerEnvelope;
  /**
   * The server's own answer to "was this wizard opened from a verified handoff,
   * and what did that handoff carry".
   *
   * Typed, and read-only from this surface's point of view. Every field in it
   * was decided server-side — the mode, the authorized action, the eligibility,
   * the selection, the frozen evidence window and the lineage — and re-verified
   * at consume time against the CURRENT decision. This body preselects from it
   * and restates it; it must never re-derive any of it, and it never reads any
   * of it out of the URL.
   *
   * `undefined` is the preserved legacy mount, which establishes nothing.
   */
  handoffPrefill?: LaunchpadHandoffPrefillEnvelope;
  /**
   * Whether provider execution is enabled, read from the server's own gate.
   *
   * `undefined` is the preserved legacy mount, which establishes nothing and is
   * therefore treated as closed — the same fail-closed reading the viewer
   * envelope uses. This is presentation only: `rejectIfLaunchpadExecutionGated`
   * in the write routes is what actually refuses, and it refuses whatever this
   * prop says. See `docs/adr-003-launchpad-execution-posture.md`.
   */
  executionEnabled?: boolean;
}

export default function MetaLaunchpadPage({
  businessId: authorizedBusinessId,
  businessName: authorizedBusinessName,
  providerAccountId: authorizedProviderAccountId,
  viewer: authorizedViewer,
  handoffPrefill: authorizedHandoffPrefill,
  executionEnabled: authorizedExecutionEnabled,
}: MetaLaunchpadPageProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const launchpadQuery = searchParams?.toString() ?? "";
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const businessId = authorizedBusinessId?.trim() || selectedBusinessId || "";
  const activeBusiness = businesses.find(
    (business) => business.id === businessId,
  );
  const businessName =
    authorizedBusinessName?.trim() || activeBusiness?.name || "Meta";
  const hasAuthorizedProviderScope = authorizedProviderAccountId !== undefined;
  /**
   * The refusal the server already holds, restated where the operator can see
   * it *before* clicking. Read, never derived: `viewer.reason` and
   * `viewer.canMutate` are computed once on the server from role, reviewer
   * status and demo status together, so this surface cannot drift from the
   * route that answers the click.
   *
   * The legacy mount supplies no envelope. That is not "allowed" — it is "this
   * caller established nothing", and the write routes still refuse on their own
   * authority.
   */
  const viewer = authorizedViewer ?? LAUNCHPAD_VIEWER_NOT_ESTABLISHED;
  /**
   * A mount that forwarded no gate reading proved nothing about it, and an
   * unproven gate is closed. `=== true` rather than `?? false` so that any
   * value other than a server's explicit `true` reads as closed.
   */
  const executionEnabled = authorizedExecutionEnabled === true;
  const writeRefusalReason = viewer.reason;
  const serverProviderAccountId = authorizedProviderAccountId?.trim() || "";
  const requestedProviderAccountId = hasAuthorizedProviderScope
    ? serverProviderAccountId
    : (searchParams?.get("providerAccountId")?.trim() ?? "");
  const [providerAccounts, setProviderAccounts] = useState<
    MetaHistoryAccount[]
  >([]);
  const [selectedProviderAccountId, setSelectedProviderAccountId] =
    useState("");
  const [providerAccountsLoading, setProviderAccountsLoading] = useState(false);
  const [providerAccountsError, setProviderAccountsError] = useState<
    string | null
  >(null);
  const providerAccountId = hasAuthorizedProviderScope
    ? serverProviderAccountId
    : selectedProviderAccountId ||
      (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const selectedProviderAccount =
    providerAccounts.find((account) => account.id === providerAccountId) ??
    null;
  const currency = normalizeCurrencyCode(selectedProviderAccount?.currency);
  const legacyHandoff = useMemo(
    () => parseLaunchpadLegacyHandoff(launchpadQuery),
    [launchpadQuery],
  );
  const serverAuthorizedHandoff =
    hasServerAuthorizedLaunchpadHandoff(legacyHandoff);
  /**
   * The server-verified handoff, or nothing.
   *
   * `LAUNCHPAD_HANDOFF_PREFILL_NONE` is the legacy mount's value on purpose: an
   * absent prop means "no server established a handoff for this render", which
   * is not the same statement as "the operator arrived without one" and must
   * never be widened into a prefill.
   */
  const handoffPrefillEnvelope =
    authorizedHandoffPrefill ?? LAUNCHPAD_HANDOFF_PREFILL_NONE;
  const serverPrefill: LaunchpadHandoffPrefill | null =
    handoffPrefillEnvelope.status === "prefilled"
      ? handoffPrefillEnvelope.prefill
      : null;
  const serverPrefillRefusalMessage =
    handoffPrefillEnvelope.status === "unavailable"
      ? handoffPrefillEnvelope.message
      : null;
  // The server's mode and step win outright. They were decided from the
  // authorized action, not from `?launchpadMode=`, so a hand-edited URL cannot
  // move a verified handoff into a different workflow.
  const requestedMode = serverPrefill
    ? serverPrefill.launchpadMode
    : launchpadModeFromQuery(
        legacyHandoff && !serverAuthorizedHandoff
          ? null
          : (searchParams?.get("launchpadMode") ?? null),
      );
  const requestedStep: WizardStep = serverPrefill
    ? serverPrefill.launchpadStep
    : launchpadStepFromQuery(
        legacyHandoff && !serverAuthorizedHandoff
          ? null
          : (searchParams?.get("launchpadStep") ?? null),
      );

  const [step, setStep] = useState<WizardStep>(requestedStep);
  const [mode, setMode] = useState<LaunchpadMode>(requestedMode);
  const [creatives, setCreatives] = useState<MetaCreativeRow[]>([]);
  const [creativeLoading, setCreativeLoading] = useState(false);
  const [creativeError, setCreativeError] = useState<string | null>(null);
  /**
   * Bumped by the freshness bar's retry so the reads below run again.
   *
   * The reads here are effects keyed on their inputs, not queries with a
   * `refetch()`. Without this the retry button would render and do nothing,
   * which tells the operator the system is trying when it is not.
   */
  const [freshnessRetryNonce, setFreshnessRetryNonce] = useState(0);

  // One freshness contract across every Tier-0 surface. Derived from the
  // state this surface already has, so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "launchpad",
    isLoading: providerAccountsLoading,
    error: providerAccountsError ?? creativeError,
    // Launchpad composes what it is about to publish from live reads; the
    // accounts read is the one that gates the wizard. Those reads publish no
    // observation time, and the timestamps this page does hold -- when a
    // launch was requested, when a draft was saved -- are properties of the
    // records, not of any read, so `measuredAsOf` has nothing honest to
    // measure here. `null` renders "age unknown", which beats a number nobody
    // should trust; it is also why this file is the one entry allowed to
    // hardcode null in lib/tier-zero-as-of.test.ts.
    asOf: null,
    businessId: businessId || null,
    onRetry: () => setFreshnessRetryNonce((nonce) => nonce + 1),
  });
  const [decisions, setDecisions] = useState<DecisionOutput[]>([]);
  const [recentAdActions, setRecentAdActions] = useState<
    LaunchpadRecentAdAction[]
  >([]);
  /**
   * Seeded from the verified handoff on the FIRST render, not by an effect.
   *
   * An effect would leave the wizard rendering an empty picker for one paint
   * and would never appear at all in a server-rendered pass — which is exactly
   * how "the selection never reaches the body" looked from the outside.
   */
  const [selectedCreativeIds, setSelectedCreativeIds] = useState<string[]>(
    () => serverPrefill?.selection.creativeIds ?? [],
  );
  const [campaign, setCampaign] = useState<LaunchpadCampaignBasicsState>({
    name: defaultCampaignName(),
    smartPromotion: false,
    specialAdCategories: [],
  });
  const [budget, setBudget] = useState<LaunchpadBudgetState>({
    mode: "CBO",
    schedule: "daily",
    amount: "50",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bidAmount: "",
  });
  const [adSets, setAdSets] = useState<LaunchpadAdSetState[]>([
    makeDefaultLaunchpadAdSet(1, defaultCampaignName()),
  ]);
  const [addToExistingTarget, setAddToExistingTarget] =
    useState<LaunchpadAddToExistingState>(
      makeDefaultAddToExistingTargetState(),
    );
  const [templates, setTemplates] = useState<LaunchTemplate[]>([]);
  const [drafts, setDrafts] = useState<LaunchDraft[]>([]);
  const [launchIntents, setLaunchIntents] = useState<MetaLaunchIntent[]>([]);
  const [launchIntentCapability, setLaunchIntentCapability] =
    useState<MetaLaunchIntentCapability | null>(null);
  const [draftCapability, setDraftCapability] =
    useState<MetaLaunchStoreCapability | null>(null);
  const [templateCapability, setTemplateCapability] =
    useState<MetaLaunchStoreCapability | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  /**
   * Why the library is empty, when it is empty for a reason other than being
   * empty. `null` means every read answered and an empty table is a measured
   * zero. Nothing sets this before a read is attempted, so the pre-scope
   * landing keeps saying nothing rather than claiming a failure.
   */
  const [libraryUnavailableMessageState, setLibraryUnavailableMessage] =
    useState<string | null>(null);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(
    null,
  );
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchResult, setLaunchResult] =
    useState<LaunchpadProgressResult | null>(null);
  /**
   * The launched intent, re-read after the receipt.
   *
   * The launch response says what was created; it says nothing about whether a
   * standing activation approval exists, because approving is a separate write
   * that may have happened on another day. The activation panel must show the
   * approval that is actually stored — an absent one means operator-only — so
   * it is read from the intent rather than assumed from this response.
   */
  const [activationIntent, setActivationIntent] = useState<{
    id: string;
    operation: "new_campaign" | "add_to_existing";
    status: string;
    activationApproval: unknown;
    activationReceipt: unknown;
  } | null>(null);
  const [sourceDraftId, setSourceDraftId] = useState<string | null>(null);
  const [draftValidations, setDraftValidations] = useState<
    Record<string, LaunchpadDraftValidation | undefined>
  >({});
  const [expectedCpa, setExpectedCpa] = useState<number | null>(null);
  /**
   * Why the stored approval is not stated, when it could not be read.
   *
   * A failed intent read is not an intent without an approval, and the panel
   * must not turn one into the other.
   */
  const [activationIntentUnavailable, setActivationIntentUnavailable] = useState<
    string | null
  >(null);
  const launchIntentId = launchResult?.launchIntentId?.trim() ?? "";
  const launchIntentActivatable =
    launchResult?.launchIntentStatus === "succeeded" ||
    launchResult?.launchIntentStatus === "partially_succeeded";

  /**
   * Re-read the intent the launch just wrote.
   *
   * The launch response carries the created identities and nothing about
   * activation: the standing approval and the last activation receipt are
   * columns on the intent, written by separate calls that may have happened on
   * another day entirely. Reading them here is what lets the panel show the
   * approval that actually exists rather than one inferred from this response,
   * and it is re-read after every approval write so the panel never shows a
   * state the server has already replaced.
   */
  const refreshActivationIntent = useCallback(async () => {
    if (!launchIntentId) return;
    if (!businessId || !providerAccountId) {
      /*
        No scope, no read — and therefore no statement about the approval. The
        panel is told why rather than being left to render "operator only",
        which would assert something about an authorization nothing has looked
        at.
      */
      setActivationIntent(null);
      setActivationIntentUnavailable(
        "The launch record cannot be re-read without a resolved account, so its stored activation approval is not stated here.",
      );
      return;
    }
    try {
      const response = await fetch(
        `/api/launchpad/meta/intents/${encodeURIComponent(launchIntentId)}` +
          `?businessId=${encodeURIComponent(businessId)}` +
          `&providerAccountId=${encodeURIComponent(providerAccountId)}`,
      );
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        intent?: {
          id?: string;
          operation?: string;
          status?: string;
          activationApproval?: unknown;
          activationReceipt?: unknown;
        };
        error?: { message?: string };
      } | null;
      const intent = body?.ok === true ? body.intent : null;
      if (!intent?.id) {
        setActivationIntent(null);
        setActivationIntentUnavailable(
          body?.error?.message ??
            "The launch record could not be re-read, so its stored activation approval is not stated here.",
        );
        return;
      }
      setActivationIntent({
        id: intent.id,
        operation:
          intent.operation === "add_to_existing"
            ? "add_to_existing"
            : "new_campaign",
        status: intent.status ?? "",
        activationApproval: intent.activationApproval ?? null,
        activationReceipt: intent.activationReceipt ?? null,
      });
      setActivationIntentUnavailable(null);
    } catch (error) {
      setActivationIntent(null);
      setActivationIntentUnavailable(
        error instanceof Error
          ? `${error.message} — the stored activation approval is not stated here.`
          : "The launch record could not be re-read, so its stored activation approval is not stated here.",
      );
    }
  }, [businessId, launchIntentId, providerAccountId]);

  useEffect(() => {
    if (!launchIntentId || !launchIntentActivatable) {
      setActivationIntent(null);
      setActivationIntentUnavailable(null);
      return;
    }
    // Unknown until the read answers. A pending read is not an absent approval,
    // and the panel must not say "operator only" while it is still looking.
    setActivationIntentUnavailable(
      "The stored activation approval is still being read.",
    );
    void refreshActivationIntent();
  }, [launchIntentActivatable, launchIntentId, refreshActivationIntent]);

  /**
   * One read for the whole surface.
   *
   * The assigned-account list is presentation only. It is the very set
   * `resolveProviderAccountId` authorizes against, so reading it cannot widen
   * scope — and it has to load even when the server resolved *no* account,
   * otherwise a business with two or more assigned Meta ad accounts is shown
   * "select one assigned Meta ad account" with nothing to select. The chosen id
   * stays server-owned: `providerAccountId` above still reads
   * `serverProviderAccountId` on the canonical route.
   *
   * The library, the recent ad actions and the target CPA arrive in the same
   * response. They were four effects issuing seven requests at the same instant
   * about the same account; `/api/launchpad/meta/workspace` answers all seven
   * at once, in the same scope, with the same authorization and the same
   * freshness. Nothing here decides anything those four did not already decide:
   * `resolveMetaSurfaceReadState` is still the only authority over what the
   * observed outcomes mean.
   */
  useEffect(() => {
    if (!businessId) {
      setProviderAccounts([]);
      setSelectedProviderAccountId("");
      return;
    }
    let cancelled = false;
    setProviderAccountsLoading(true);
    setProviderAccountsError(null);
    if (providerAccountId) {
      setLibraryLoading(true);
    } else {
      // With no account scope the account-scoped sections are not read at all,
      // so the surface must not keep showing the previous account's rows. No
      // read was attempted, so there is nothing to report as unread.
      setTemplates([]);
      setDrafts([]);
      setLaunchIntents([]);
      setLaunchIntentCapability(null);
      setDraftCapability(null);
      setTemplateCapability(null);
      setLibraryUnavailableMessage(null);
      setRecentAdActions([]);
      setExpectedCpa(null);
    }
    loadLaunchpadWorkspace(businessId, providerAccountId)
      .then((workspace) => {
        if (cancelled) return;
        setProviderAccounts(workspace.accounts);
        setSelectedProviderAccountId((current) => {
          if (
            current &&
            workspace.accounts.some((account) => account.id === current)
          )
            return current;
          if (
            requestedProviderAccountId &&
            workspace.accounts.some(
              (account) => account.id === requestedProviderAccountId,
            )
          ) {
            return requestedProviderAccountId;
          }
          return "";
        });
        setProviderAccountsError(
          workspace.accountsRead
            ? null
            : "Assigned Meta accounts could not load.",
        );
        // The account-scoped half of the response is only meaningful when this
        // read carried an account scope.
        if (!providerAccountId) return;
        setTemplates(workspace.templates);
        setDrafts(workspace.drafts);
        setLaunchIntents(workspace.intents);
        setLaunchIntentCapability(workspace.launchIntentCapability);
        setDraftCapability(workspace.draftCapability);
        setTemplateCapability(workspace.templateCapability);
        setLibraryUnavailableMessage(workspace.unavailableMessage);
        setRecentAdActions(workspace.recentAdActions);
        setExpectedCpa(workspace.targetCpa);
        // Observed outcomes in, one shared decision out. See `readOutcomes`.
        publishMetaSurfaceState(
          "meta-launchpad",
          resolveMetaSurfaceReadState({
            businessId,
            providerAccountId,
            requiresProviderAccount: true,
            permissions: {
              role: viewer?.role ?? null,
              reviewerReadOnly: viewer?.reviewerReadOnly === true,
              demo: viewer?.demo === true,
            },
            capability: { canRead: true, canWrite: viewer?.canMutate === true },
            sources: workspace.readOutcomes,
          }),
        );
      })
      .catch(() => {
        // `loadLaunchpadWorkspace` reports a transport failure in its outcomes
        // rather than throwing, so this is the defensive branch only.
        if (cancelled) return;
        setProviderAccounts([]);
        setSelectedProviderAccountId("");
        setProviderAccountsError("Assigned Meta accounts could not load.");
        if (!providerAccountId) return;
        setTemplates([]);
        setDrafts([]);
        setLaunchIntents([]);
        setLaunchIntentCapability(null);
        setDraftCapability(null);
        setTemplateCapability(null);
        setLibraryUnavailableMessage(LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE);
        setRecentAdActions([]);
        setExpectedCpa(null);
      })
      .finally(() => {
        if (cancelled) return;
        setProviderAccountsLoading(false);
        setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // freshnessRetryNonce is not read here; it is in the dependency list so the
    // freshness bar's retry re-runs this read.
  }, [
    businessId,
    providerAccountId,
    freshnessRetryNonce,
    requestedProviderAccountId,
    viewer?.canMutate,
    viewer?.demo,
    viewer?.reviewerReadOnly,
    viewer?.role,
  ]);

  /**
   * The server-verified handoff, applied.
   *
   * This is the half that was missing: consuming a handoff used to set only a
   * generic wizard mode, so an operator who clicked Rebuild on a specific
   * creative landed on an empty picker and had to find it again by hand. The
   * ids come from the record the server re-verified, never from the URL.
   *
   * `unsupported` is restated verbatim. A copy handoff carries an alternate
   * line that no Launchpad payload field can hold, and saying so beats a draft
   * that silently drops it.
   */
  useEffect(() => {
    if (!serverPrefill) return;
    setMode(serverPrefill.launchpadMode);
    setStep(serverPrefill.launchpadStep);
    if (serverPrefill.selection.creativeIds.length > 0) {
      setSelectedCreativeIds(serverPrefill.selection.creativeIds);
    }
    setTemplateMessage(
      [serverPrefill.summary, serverPrefill.unsupported]
        .filter(Boolean)
        .join(" · "),
    );
  }, [serverPrefill]);

  /**
   * A handoff that was named and could not be honoured says so — defensively.
   *
   * The canonical route refuses an unhonourable record before this body is
   * mounted (it redirects to Decisions with the code, because a hop-2 failure
   * lands on the landing, which has no slot for a sentence). This restatement
   * exists so that ANY other caller handing this body an `unavailable`
   * envelope still produces a visible reason rather than silence: an
   * `unavailable` envelope must never be widened into "no handoff was named".
   */
  useEffect(() => {
    if (!serverPrefillRefusalMessage) return;
    setTemplateMessage(serverPrefillRefusalMessage);
  }, [serverPrefillRefusalMessage]);

  /**
   * A `?handoff=` reference that reached this body was never consumed.
   *
   * Only the canonical route can burn a handoff token — it needs the session,
   * the assignment-verified account and a server write. This body is a client
   * component and can do none of that, so a reference that arrives here has
   * carried nothing, and it must not be mistaken for a prefill. Said out loud
   * in the message line that already exists rather than opening a wizard whose
   * emptiness reads as success.
   */
  const unconsumedHandoffReference = Boolean(
    searchParams?.get("handoff")?.trim(),
  );
  useEffect(() => {
    if (!unconsumedHandoffReference) return;
    if (handoffPrefillEnvelope.status !== "none") return;
    setTemplateMessage(
      "That launch handoff was not consumed here: this page cannot verify one. Open Launchpad from your workspace to use it.",
    );
  }, [handoffPrefillEnvelope.status, unconsumedHandoffReference]);

  useEffect(() => {
    if (!legacyHandoff) return;
    const hasLineageIdentifiers =
      hasCompleteLaunchpadLineageIdentifiers(legacyHandoff);
    const actionEligible = hasServerAuthorizedLaunchpadHandoff(legacyHandoff);
    const exactWorkflowAvailable = legacyHandoff.requestedMode !== "apply_bid";
    const nextMode: LaunchpadMode =
      legacyHandoff.requestedMode === "duplicate"
        ? "add_to_existing"
        : "new_campaign";
    if (actionEligible && legacyHandoff.creativeIds.length > 0) {
      setSelectedCreativeIds(legacyHandoff.creativeIds);
    }
    if (actionEligible && exactWorkflowAvailable) {
      setMode(nextMode);
      setStep(
        nextMode === "add_to_existing"
          ? "adsets"
          : legacyHandoff.creativeIds.length > 0
            ? "basics"
            : "creatives",
      );
    } else {
      setStep("source");
    }
    setTemplateMessage(
      [
        `${legacyHandoff.source === "decision" ? "Decision" : "Brief"} handoff detected`,
        actionEligible
          ? exactWorkflowAvailable
            ? "server-authorized lineage will be persisted in the launch record"
            : "apply-bid execution is not part of the Launchpad contract"
          : hasLineageIdentifiers
            ? "lineage identifiers are present, but server-owned action eligibility is unavailable"
            : "legacy URL prefill has no complete lineage identifiers",
        legacyHandoff.requestedMode
          ? `mode=${legacyHandoff.requestedMode}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }, [legacyHandoff]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      setCreatives([]);
      return;
    }
    let cancelled = false;
    setCreativeLoading(true);
    setCreativeError(null);
    fetchMetaCreatives({
      businessId,
      providerAccountId,
      // Inclusive of both ends, so N days back from today is N-1.
      start: isoDateDaysAgo(LAUNCHPAD_CANDIDATE_WINDOW_DAYS - 1),
      end: todayIso(),
      groupBy: mode === "manage_existing" ? "ad" : "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    })
      .then((payload) => {
        if (cancelled) return;
        setCreatives(payload.rows.map(mapApiRowToUiRow));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setCreativeError(
            error instanceof Error
              ? error.message
              : "Could not load creatives.",
          );
      })
      .finally(() => {
        if (!cancelled) setCreativeLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // See above: the nonce is a retry trigger, not a value this read consumes.
  }, [businessId, mode, providerAccountId, freshnessRetryNonce]);

  useEffect(() => {
    if (!businessId || !providerAccountId || creatives.length === 0) {
      setDecisions([]);
      return;
    }
    let cancelled = false;
    fetchCreativeDecisionEngineV3({
      businessId,
      providerAccountId,
      // Only rows that actually carry a creative identity. A null here would
      // ask the engine about a creative that does not exist.
      creativeIds: Array.from(
        new Set(
          creatives
            .map((creative) => creative.creativeId)
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        ),
      ),
    })
      .then((payload) => {
        if (!cancelled) setDecisions(payload.decisions ?? []);
      })
      .catch(() => {
        if (!cancelled) setDecisions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, creatives, providerAccountId]);

  // The Drafts table's Validation column is the server's verdict, never an
  // inference from the stored payload. One batched request for the whole page:
  // billing and pixels are properties of the account, not of a draft, so asking
  // per row cost about a hundred Graph reads for two answers. Rows show
  // `pending` until the page's answer arrives.
  useEffect(() => {
    if (!businessId || !providerAccountId || drafts.length === 0) {
      setDraftValidations({});
      return;
    }
    let cancelled = false;
    setDraftValidations(
      Object.fromEntries(
        drafts.map((draft) => [
          draft.id,
          { status: "pending" } as LaunchpadDraftValidation,
        ]),
      ),
    );
    void readLaunchpadDraftValidations({
      businessId,
      providerAccountId,
      drafts,
    }).then((validations) => {
      if (!cancelled) setDraftValidations(validations);
    });
    return () => {
      cancelled = true;
    };
  }, [businessId, drafts, providerAccountId]);

  async function refreshLibrary() {
    if (!businessId || !providerAccountId) return;
    setLibraryLoading(true);
    try {
      // The same composed read the first load uses. A refresh after a save
      // re-reads recent actions and the target CPA too, which is free here and
      // used to need two more requests.
      const library = await loadLaunchpadWorkspace(businessId, providerAccountId);
      setTemplates(library.templates);
      setDrafts(library.drafts);
      setLaunchIntents(library.intents);
      setLaunchIntentCapability(library.launchIntentCapability);
      setDraftCapability(library.draftCapability);
      setTemplateCapability(library.templateCapability);
      setLibraryUnavailableMessage(library.unavailableMessage);
      setRecentAdActions(library.recentAdActions);
      setExpectedCpa(library.targetCpa);
    } catch {
      setTemplates([]);
      setDrafts([]);
      setLaunchIntents([]);
      setLaunchIntentCapability(null);
      setDraftCapability(null);
      setTemplateCapability(null);
      setLibraryUnavailableMessage(LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE);
    } finally {
      setLibraryLoading(false);
    }
  }

  const decisionByCreativeId = useMemo(
    () => new Map(decisions.map((decision) => [decision.creativeId, decision])),
    [decisions],
  );
  const launchpadCreatives = useMemo(
    () =>
      applyRecentAdActionsToRows(
        creatives,
        mode === "manage_existing" || mode === "add_to_existing"
          ? recentAdActions
          : [],
        currency,
        {
          surface:
            mode === "add_to_existing" ? "source_creatives" : "resulting_ads",
        },
      )
        // A row the provider gave no creative id for cannot be selected,
        // named, or sent to the engine — every use below keys on that id.
        // The field used to be typed non-nullable, so the copies mapper
        // substituted its own row id to satisfy the type and the row then
        // travelled as if it had a creative. Withheld here instead: an
        // absent identity is not a usable identity.
        .filter(
          (creative): creative is typeof creative & { creativeId: string } =>
            typeof creative.creativeId === "string" &&
            creative.creativeId.trim().length > 0,
        ),
    [creatives, currency, mode, recentAdActions],
  );
  const selectedCreatives = useMemo(() => {
    const selected = new Set(selectedCreativeIds);
    return launchpadCreatives.filter((creative) =>
      selected.has(
        mode === "manage_existing"
          ? resolveLaunchpadAdActionId(creative)
          : creative.creativeId,
      ),
    );
  }, [launchpadCreatives, mode, selectedCreativeIds]);
  const selectionSummary = useMemo(
    () =>
      buildLaunchpadSelectionSummary({
        selectedCreatives,
        decisionByCreativeId,
      }),
    [decisionByCreativeId, selectedCreatives],
  );

  const payload = useMemo(
    () =>
      normalizeMetaLaunchPayload({
        mode: "new_campaign",
        currencyCode: currency,
        campaign: {
          name: campaign.name,
          objective: "OUTCOME_SALES",
          smartPromotionType: campaign.smartPromotion
            ? "GUIDED_CREATION"
            : null,
          specialAdCategories: campaign.specialAdCategories,
        },
        budget:
          budget.mode === "CBO"
            ? {
                mode: "CBO",
                schedule: budget.schedule ?? "daily",
                amountMinor: amountToMinorUnits(budget.amount ?? ""),
                bidStrategy: budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
                bidAmountMinor: amountToMinorUnits(budget.bidAmount ?? ""),
              }
            : {
                mode: "ABO",
              },
        creatives: selectedCreatives.map((creative) => ({
          creativeId: creative.creativeId,
          sourceAdId: creative.realAdId?.trim() || creative.id,
          name: creative.name,
        })),
        adSets: adSets.map((adSet) => ({
          clientId: adSet.clientId,
          name: adSet.name,
          optimizationGoal: adSet.optimizationGoal,
          pixelId: adSet.pixelId,
          customEventType: adSet.customEventType,
          targeting: {
            countries: countriesFromInput(adSet.countries),
            ageMin: Number(adSet.ageMin) || 18,
            ageMax: Number(adSet.ageMax) || 65,
            advantageAudience: adSet.advantageAudience,
            advantagePlacements: adSet.advantagePlacements,
            publisherPlatforms: adSet.publisherPlatforms,
            facebookPositions: adSet.facebookPositions,
            instagramPositions: adSet.instagramPositions,
          },
          attributionSpec: attributionSpecFromState(adSet),
          budget:
            budget.mode === "ABO"
              ? {
                  mode: "ABO",
                  schedule: "daily",
                  amountMinor: amountToMinorUnits(adSet.budgetAmount ?? ""),
                  bidStrategy: adSet.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
                  bidAmountMinor: amountToMinorUnits(adSet.bidAmount ?? ""),
                }
              : null,
        })),
      }),
    [adSets, budget, campaign, currency, selectedCreatives],
  );
  const selectedExistingTargets = useMemo(
    () => getSelectedExistingTargets(addToExistingTarget),
    [addToExistingTarget],
  );
  const selectedExistingCampaigns = useMemo(
    () => getSelectedExistingCampaigns(addToExistingTarget),
    [addToExistingTarget],
  );
  const addToExistingPayload = useMemo(() => {
    const firstTarget = selectedExistingTargets[0] ?? null;
    const copyMode = addToExistingTarget.copyMode ?? "reuse_creative";
    return {
      mode: "add_to_existing" as const,
      targetCampaignId: firstTarget?.campaign.id ?? "",
      targetAdsetId: firstTarget?.adset.id ?? "",
      targetCampaignName: firstTarget?.campaign.name ?? null,
      targetAdsetName: firstTarget?.adset.name ?? null,
      copyMode,
      targets: selectedExistingTargets.map(({ campaign, adset }) => ({
        targetCampaignId: campaign.id,
        targetAdsetId: adset.id,
        targetCampaignName: campaign.name,
        targetAdsetName: adset.name,
      })),
      creativeIds: selectedCreatives.map((creative) => creative.creativeId),
      creatives: selectedCreatives.map((creative) => ({
        creativeId: creative.creativeId,
        sourceAdId: creative.realAdId?.trim() || creative.id,
        name: creative.name,
        nameOverride:
          addToExistingTarget.nameOverrides[creative.creativeId] ??
          defaultCreativeAddName(creative),
      })),
      names: selectedCreatives.reduce<Record<string, string>>(
        (acc, creative) => {
          acc[creative.creativeId] =
            addToExistingTarget.nameOverrides[creative.creativeId] ??
            defaultCreativeAddName(creative);
          return acc;
        },
        {},
      ),
    };
  }, [
    addToExistingTarget.copyMode,
    addToExistingTarget.nameOverrides,
    selectedCreatives,
    selectedExistingTargets,
  ]);

  const activeLegacyHandoff = hasServerAuthorizedLaunchpadHandoff(legacyHandoff)
    ? legacyHandoff
    : null;
  const activeSteps = LAUNCH_STEPS;
  const currentStepIndex = activeSteps.findIndex((item) => item.id === step);
  const canGoNext =
    step === "source" || step === "scope"
      ? true
      : step === "creatives"
        ? selectedCreativeIds.length > 0
        : step === "adsets" && mode === "add_to_existing"
          ? selectedExistingCampaigns.length > 0 &&
            selectedExistingTargets.length === selectedExistingCampaigns.length
          : step === "basics" && mode === "new_campaign"
            ? campaign.name.trim().length > 0
            : step !== "progress";

  const toggleCreative = useCallback(
    (row: MetaCreativeRow) => {
      const selectionId =
        mode === "manage_existing"
          ? resolveLaunchpadAdActionId(row)
          : row.creativeId;
      // Nothing to select. The list is already filtered to rows that carry a
      // creative identity, so this is a guard against a future caller rather
      // than a reachable branch — and it refuses instead of selecting a null.
      if (!selectionId) return;
      setSelectedCreativeIds((prev) => {
        if (prev.includes(selectionId)) {
          return prev.filter((id) => id !== selectionId);
        }
        return [...prev, selectionId];
      });
    },
    [mode],
  );

  function goNext() {
    if (step === "review") return;
    const next =
      activeSteps[Math.min(currentStepIndex + 1, activeSteps.length - 1)];
    if (next) setStep(next.id);
  }

  function goBack() {
    const prev = activeSteps[Math.max(currentStepIndex - 1, 0)];
    if (prev) setStep(prev.id);
  }

  function resetLaunchState() {
    setSelectedCreativeIds([]);
    setCampaign({
      name: defaultCampaignName(),
      smartPromotion: false,
      specialAdCategories: [],
    });
    setBudget({
      mode: "CBO",
      schedule: "daily",
      amount: "50",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      bidAmount: "",
    });
    setAdSets([makeDefaultLaunchpadAdSet(1, defaultCampaignName())]);
    setAddToExistingTarget(makeDefaultAddToExistingTargetState());
    setLaunchResult(null);
    setSourceDraftId(null);
    setStep("source");
  }

  function changeProviderAccount(nextProviderAccountId: string) {
    if (nextProviderAccountId === providerAccountId) return;
    if (hasAuthorizedProviderScope) {
      // Canonical `/c/**` routes resolve account assignment on the server, so
      // the client may only *request* an account: it writes the id into the
      // URL and lets `resolveProviderAccountId` authorize it again on the
      // next render. An unassigned id still comes back as null, so this
      // widens nothing — it only makes the choice expressible.
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (nextProviderAccountId) {
        url.searchParams.set("providerAccountId", nextProviderAccountId);
      } else {
        url.searchParams.delete("providerAccountId");
      }
      // Same law the legacy path holds below: a launch half-built against the
      // previous account must not follow the operator into the next one.
      resetLaunchState();
      setMode("new_campaign");
      router.replace(`${url.pathname}${url.search}`);
      return;
    }
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (nextProviderAccountId) {
        url.searchParams.set("providerAccountId", nextProviderAccountId);
      } else {
        url.searchParams.delete("providerAccountId");
      }
      for (const key of [
        "sourceDecisionId",
        "sourceDecisionSnapshotId",
        "creativeBriefId",
        "fromBriefing",
        "fromMetaBriefing",
        "creativeIds",
        "campaignIds",
        "adsetIds",
        "mode",
      ]) {
        url.searchParams.delete(key);
      }
      url.searchParams.set("launchpadMode", "new_campaign");
      url.searchParams.set("launchpadStep", "source");
      window.history.replaceState(null, "", url);
    }
    resetLaunchState();
    setMode("new_campaign");
    setTemplates([]);
    setDrafts([]);
    setLaunchIntents([]);
    setLaunchIntentCapability(null);
    // Switching accounts discards the previous account's answer; the next read
    // owns the next verdict, and until it lands nothing is claimed either way.
    setLibraryUnavailableMessage(null);
    setRecentAdActions([]);
    setDecisions([]);
    setCreatives([]);
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setSelectedProviderAccountId(nextProviderAccountId);
  }

  function clearAppliedTemplate() {
    resetLaunchState();
    setMode("new_campaign");
    setAppliedTemplateName(null);
    setTemplateMessage(null);
  }

  function startMode(nextMode: LaunchpadMode) {
    if (nextMode === mode) {
      setStep("scope");
      return;
    }
    setMode(nextMode);
    resetLaunchState();
    setAppliedTemplateName(null);
    setTemplateMessage(null);
    setStep("scope");
  }

  function applyDraft(draft: LaunchDraft) {
    if (draft.providerAccountId !== providerAccountId) return;
    setSourceDraftId(draft.id);
    if (draft.payload.mode === "add_to_existing") {
      const next = normalizeMetaAddToExistingPayload(draft.payload);
      const targetCampaigns = next.targets
        .map(makePlaceholderCampaign)
        .filter(
          (
            campaign,
          ): campaign is NonNullable<
            LaunchpadAddToExistingState["targetCampaign"]
          > => Boolean(campaign),
        );
      const targetAdsetsByCampaignId = next.targets.reduce<
        NonNullable<LaunchpadAddToExistingState["targetAdsetsByCampaignId"]>
      >((acc, target) => {
        const adset = makePlaceholderAdset(target);
        if (target.targetCampaignId && adset)
          acc[target.targetCampaignId] = adset;
        return acc;
      }, {});
      setMode("add_to_existing");
      setAppliedTemplateName(null);
        setSelectedCreativeIds(next.creativeIds);
      setAddToExistingTarget({
        targetCampaign: targetCampaigns[0] ?? null,
        targetAdset: targetCampaigns[0]
          ? (targetAdsetsByCampaignId[targetCampaigns[0].id] ?? null)
          : null,
        targetCampaigns,
        targetAdsetsByCampaignId,
        copyMode: next.copyMode,
        nameOverrides: next.names ?? {},
      });
      setTemplateMessage(`Resumed ${draft.name}`);
      setLaunchResult(null);
      setStep("creatives");
      return;
    }

    const next = normalizeMetaLaunchPayload(draft.payload);
    setMode("new_campaign");
    setAppliedTemplateName(null);
    setCampaign({
      name: next.campaign.name || campaign.name,
      smartPromotion: next.campaign.smartPromotionType === "GUIDED_CREATION",
      specialAdCategories: next.campaign.specialAdCategories,
    });
    setBudget({
      mode: next.budget.mode,
      schedule: next.budget.schedule,
      amount: next.budget.amountMinor
        ? amountFromMinorUnits(next.budget.amountMinor)
        : budget.amount,
      bidStrategy: next.budget.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidAmount: next.budget.bidAmountMinor
        ? amountFromMinorUnits(next.budget.bidAmountMinor)
        : "",
    });
    setAdSets(
      next.adSets.length > 0
        ? next.adSets.map(stateFromPayloadAdSet)
        : [makeDefaultLaunchpadAdSet(1, defaultCampaignName())],
    );
    setSelectedCreativeIds(next.creativeIds);
    setTemplateMessage(`Resumed ${draft.name}`);
    setLaunchResult(null);
    setStep("creatives");
  }

  async function saveTemplate() {
    // The viewer refusal is server-decided and applies before any capability
    // check: a reviewer, a demo workspace or a sub-collaborator gets the reason,
    // not a POST that returns 403 with a generic "save failed".
    if (!viewer.canMutate) {
      setTemplateMessage(writeRefusalReason ?? "Launchpad writes are unavailable.");
      return;
    }
    if (templateCapability?.canWrite !== true) {
      setTemplateMessage(
        templateCapability?.status === "migration_required"
          ? "Saved templates require the pending account-scope database migration"
          : "Saved template storage capability is unavailable",
      );
      return;
    }
    const name =
      typeof window !== "undefined"
        ? window.prompt("Template name", campaign.name)
        : campaign.name;
    if (!name?.trim()) return;
    const response = await fetch("/api/launchpad/meta/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        providerAccountId,
        name: name.trim(),
        payload,
      }),
    });
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Template saved" : "Template save failed");
    if (response.ok) await refreshLibrary();
  }

  async function saveDraft() {
    // Same law as saveTemplate: the server already decided this viewer may not
    // write, so say so instead of sending a request that will be refused.
    if (!viewer.canMutate) {
      setTemplateMessage(writeRefusalReason ?? "Launchpad writes are unavailable.");
      return;
    }
    if (draftCapability?.canWrite !== true) {
      setTemplateMessage(
        draftCapability?.status === "migration_required"
          ? "Drafts require the pending account-scope database migration"
          : "Draft storage capability is unavailable",
      );
      return;
    }
    const response = await fetch("/api/launchpad/meta/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        providerAccountId,
        name:
          mode === "add_to_existing"
            ? `Add to ${selectedExistingTargets.length || 1} existing target${selectedExistingTargets.length === 1 ? "" : "s"}`
            : campaign.name || defaultCampaignName(),
        payload: mode === "add_to_existing" ? addToExistingPayload : payload,
      }),
    });
    const responsePayload = (await response.json().catch(() => null)) as {
      draft?: { id?: string; providerAccountId?: string };
    } | null;
    if (
      response.ok &&
      responsePayload?.draft?.providerAccountId === providerAccountId &&
      responsePayload.draft.id
    ) {
      setSourceDraftId(responsePayload.draft.id);
    }
    setAppliedTemplateName(null);
    setTemplateMessage(response.ok ? "Draft saved" : "Draft save failed");
    if (response.ok) await refreshLibrary();
  }

  async function launchPaused(authority: MetaLaunchpadManualAuthority) {
    // `launch` refuses a reviewer, a demo workspace and a sub-collaborator
    // before it ever reaches the provider. Surface that as a receipt rather
    // than as an opaque failure after the operator has acknowledged the launch.
    if (!viewer.canMutate) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          // Restated from the server envelope, never re-derived here: the
          // old local ladder answered "insufficient_role" for a workspace
          // whose demo flag simply could not be read.
          code: viewer.refusalCode ?? "insufficient_role",
          message: writeRefusalReason ?? "Launchpad writes are unavailable.",
        },
      });
      return;
    }
    if (!launchIntentCapability?.canWrite) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          code:
            launchIntentCapability?.status === "migration_required"
              ? "launch_intent_migration_required"
              : "launch_intent_capability_unavailable",
          message:
            launchIntentCapability?.status === "migration_required"
              ? "LaunchIntent storage needs the pending database migration. No provider request was sent."
              : "LaunchIntent storage capability could not be verified. No provider request was sent.",
        },
      });
      return;
    }
    if (!providerAccountId || !currency) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          code: !providerAccountId
            ? "provider_account_required"
            : "account_currency_required",
          message: !providerAccountId
            ? "Select an assigned Meta ad account before launching."
            : "The selected Meta account currency is unavailable; minor-unit writes are blocked.",
        },
      });
      return;
    }
    setStep("progress");
    setLaunchLoading(true);
    setLaunchResult(null);
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    try {
      const endpoint =
        mode === "add_to_existing"
          ? "/api/launchpad/meta/add-to-existing"
          : "/api/launchpad/meta/launch";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "add_to_existing"
            ? {
                businessId,
                providerAccountId,
                targetCampaignId: addToExistingPayload.targetCampaignId,
                targetAdsetId: addToExistingPayload.targetAdsetId,
                copyMode: addToExistingPayload.copyMode,
                targets: addToExistingPayload.targets,
                creativeIds: addToExistingPayload.creativeIds,
                creatives: addToExistingPayload.creatives,
                names: addToExistingPayload.names,
                ...authority,
                idempotencyKey,
                sourceDraftId,
              }
            : {
                businessId,
                providerAccountId,
                payload,
                ...authority,
                idempotencyKey,
                sourceDraftId,
              },
        ),
      });
      const body = (await response
        .json()
        .catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(
        body ?? {
          ok: false,
          error: { code: "empty_response", message: "Empty response." },
        },
      );
      void refreshLibrary();
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "launch_request_failed",
          message:
            error instanceof Error ? error.message : "Launch request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  async function runBulkStatusAction(
    action: "pause" | "resume",
    rows: MetaCreativeRow[],
  ) {
    // `bulk-ad-status` refuses a reviewer, a demo workspace and a
    // sub-collaborator role. State it here rather than letting the operator
    // watch a 403 arrive as a partial launch receipt. The code mirrors the one
    // the route would answer with, so the receipt reads the same either way.
    if (!viewer.canMutate) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          // Restated from the server envelope, never re-derived here: the
          // old local ladder answered "insufficient_role" for a workspace
          // whose demo flag simply could not be read.
          code: viewer.refusalCode ?? "insufficient_role",
          message: writeRefusalReason ?? "Launchpad writes are unavailable.",
        },
      });
      return;
    }
    if (
      rows.some(
        (row) =>
          !row.realAdId?.trim() ||
          !row.creativeId?.trim() ||
          row.accountId?.replace(/^act_/, "") !==
            providerAccountId.replace(/^act_/, ""),
      )
    ) {
      setStep("progress");
      setLaunchResult({
        ok: false,
        error: {
          code: "exact_ad_authority_required",
          message:
            "Every manual target needs one server-presented Meta ad, creative, and account identity. Discovery-only rows were not changed.",
        },
      });
      return;
    }
    setStep("progress");
    setLaunchLoading(true);
    setLaunchResult(null);
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    try {
      const response = await fetch("/api/launchpad/meta/bulk-ad-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          providerAccountId,
          actionOrigin: "manual_operator_v1",
          manualConfirmation: "explicit_operator_confirmation",
          action,
          ads: rows.map((row) => ({
            adId: row.realAdId!.trim(),
            providerAccountId,
            creativeId: row.creativeId,
            name: row.name,
          })),
          idempotencyKey,
        }),
      });
      const body = (await response
        .json()
        .catch(() => null)) as LaunchpadProgressResult | null;
      setLaunchResult(
        body ?? {
          ok: false,
          error: { code: "empty_response", message: "Empty response." },
        },
      );
    } catch (error) {
      setLaunchResult({
        ok: false,
        error: {
          code: "bulk_status_request_failed",
          message:
            error instanceof Error
              ? error.message
              : "Bulk status request failed.",
        },
      });
    } finally {
      setLaunchLoading(false);
    }
  }

  function resetWizard() {
    resetLaunchState();
  }

  const appliedTemplateMessageActive =
    appliedTemplateName != null &&
    templateMessage === `Applied ${appliedTemplateName}`;
  // A server-verified handoff prefills; a URL-shaped one never does.
  const wizardPrefilled = Boolean(serverPrefill) || Boolean(activeLegacyHandoff);
  // The chip is the ONLY place a prefill speaks while the wizard is prefilled
  // (the save-message line renders `templateMessage` exclusively when it is
  // not), so the "cannot be applied" half has to travel here or it is invisible.
  const wizardPrefillLabel = serverPrefill
    ? [serverPrefill.summary, serverPrefill.unsupported]
        .filter(Boolean)
        .join(" · ")
    : wizardPrefilled && legacyHandoff
      ? formatLaunchpadPrefillLabel(legacyHandoff, selectedCreativeIds.length)
      : null;
  const sourceLineageLabel = serverPrefill
    ? serverPrefill.origin === "copy"
      ? `Copy line · ${serverPrefill.copy?.copyId ?? "unidentified"}`
      : `Decision snapshot · ${serverPrefill.lineage?.sourceSnapshotId ?? "unidentified"}`
    : sourceDraftId
      ? `Draft · ${sourceDraftId}`
      : activeLegacyHandoff
        ? activeLegacyHandoff.source === "brief"
          ? "Reviewed Creative Brief"
          : "Decision snapshot"
        : "Manual";
  const verifiedLandingRole: LaunchStartRole | null =
    hasServerAuthorizedLaunchpadHandoff(legacyHandoff) &&
    legacyHandoff?.requestedMode !== "apply_bid"
      ? legacyHandoff?.requestedMode === "duplicate"
        ? "duplicate"
        : legacyHandoff?.requestedMode === "rebuild"
          ? "rebuild"
          : null
      : null;
  const verifiedHandoffName =
    verifiedLandingRole && legacyHandoff
      ? creatives
          .find(
            (creative) =>
              creative.creativeId !== null &&
              legacyHandoff.creativeIds.includes(creative.creativeId) &&
              creative.name?.trim(),
          )
          ?.name?.trim() || null
      : null;

  function startLandingRole(role: LaunchStartRole) {
    // Only Manual can start a workflow. Rebuild and Duplicate need a
    // server-authorized handoff, and hasServerAuthorizedLaunchpadHandoff is
    // closed by contract, so their cards stay disabled rather than opening a
    // blank draft under a name that promised a routed source.
    if (role !== "manual") return;
    const card = LAUNCH_START_CARDS.find((item) => item.role === role);
    if (card) startMode(card.mode);
  }
  const desktopQuery = new URLSearchParams(launchpadQuery);
  // A single-use bearer reference must never be copied into another link, burnt
  // or not. The record id (`handoffDraft`) may travel: it names a row that is
  // re-checked against the session on every read.
  desktopQuery.delete("handoff");
  if (legacyHandoff && !serverAuthorizedHandoff) {
    for (const key of [
      "sourceDecisionId",
      "sourceDecisionSnapshotId",
      "creativeBriefId",
      "creativeIds",
      "campaignIds",
      "adsetIds",
      "fromBriefing",
      "fromMetaBriefing",
      "mode",
    ]) {
      desktopQuery.delete(key);
    }
  }
  desktopQuery.set("launchpadMode", mode);
  desktopQuery.set("launchpadStep", step);
  const desktopProviderAccountId =
    providerAccountId || requestedProviderAccountId;
  if (desktopProviderAccountId) {
    desktopQuery.set("providerAccountId", desktopProviderAccountId);
  } else {
    desktopQuery.delete("providerAccountId");
  }
  if (sourceDraftId) {
    desktopQuery.set("sourceDraftId", sourceDraftId);
  } else {
    desktopQuery.delete("sourceDraftId");
  }
  const desktopHref = `/platforms/meta/launchpad?${desktopQuery.toString()}`;

  const accountScopeBlocked =
    providerAccountsLoading ||
    Boolean(providerAccountsError) ||
    !providerAccountId ||
    !currency;
  // The scope-blocked state asks the operator to "select one assigned Meta ad
  // account". It may only say that while a selection is actually expressible,
  // so the surface's own account control is mounted here — the same
  // `LaunchpadContextBar` the wizard uses, not a second picker.
  const providerScopeChoicePending =
    !providerAccountsLoading &&
    !providerAccountsError &&
    !providerAccountId &&
    providerAccounts.length > 0;

  if (accountScopeBlocked) {
    const scopeMessage = !businessId
      ? "Select a business. Launch data and provider writes remain withheld."
      : providerAccountsLoading
        ? "Loading assigned Meta ad accounts."
        : providerAccountsError
          ? providerAccountsError
          : !providerAccountId
            ? "Select one assigned Meta ad account. Launch data and provider writes remain withheld until the scope is explicit."
            : "The selected account currency is unavailable. Minor-unit budgets and provider writes remain blocked.";
    return (
      <div
        className={`ad-final meta-launchpad-final ${styles.route}`}
        data-testid="meta-launchpad-page"
      >
        <LaunchpadMobileSurface
          businessName={businessName}
          currency={currency}
          mode={mode}
          step={step}
          selectedCount={selectedCreativeIds.length}
          draftCount={drafts.length}
          templateCount={templates.length}
          libraryReadable={
            draftCapability?.canRead === true &&
            templateCapability?.canRead === true
          }
          libraryLoading={libraryLoading}
          creativeLoading={creativeLoading}
          providerAccountId={providerAccountId}
          sourceLineageLabel={sourceLineageLabel}
          desktopHref={desktopHref}
          statusMessage={scopeMessage}
        />
        <div className={styles.desktopSurface}>
          {providerScopeChoicePending ? (
            <LaunchpadContextBar
              businessId={businessId}
              businessName={businessName}
              currency={currency}
              providerAccounts={providerAccounts}
              providerAccountId={providerAccountId}
              accountLoading={providerAccountsLoading}
              onProviderAccountChange={changeProviderAccount}
            />
          ) : null}
          <LaunchpadExactLanding
            drafts={[]}
            intents={[]}
            loading={providerAccountsLoading}
            scopeReady={false}
            verifiedRole={verifiedLandingRole}
            verifiedHandoffName={verifiedHandoffName}
            draftValidations={draftValidations}
            onStartRole={startLandingRole}
            onApplyDraft={applyDraft}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ad-final meta-launchpad-final ${styles.route}`}
      data-testid="meta-launchpad-page"
    >
      <LaunchpadMobileSurface
        businessName={businessName}
        currency={currency}
        mode={mode}
        step={step}
        selectedCount={selectedCreativeIds.length}
        draftCount={drafts.length}
        templateCount={templates.length}
        libraryReadable={
          draftCapability?.canRead === true &&
          templateCapability?.canRead === true
        }
        libraryLoading={libraryLoading}
        creativeLoading={creativeLoading}
        providerAccountId={providerAccountId}
        sourceLineageLabel={sourceLineageLabel}
        desktopHref={desktopHref}
      />
      <div className={styles.desktopSurface}>
        {step === "source" ? (
          <LaunchpadExactLanding
            drafts={drafts}
            intents={launchIntents}
            loading={libraryLoading}
            libraryUnavailableReason={libraryUnavailableMessageState}
            verifiedRole={verifiedLandingRole}
            verifiedHandoffName={verifiedHandoffName}
            draftValidations={draftValidations}
            onStartRole={startLandingRole}
            onApplyDraft={applyDraft}
          />
        ) : (
          <div className={styles.workspace} data-testid="launchpad-wizard">
            <LaunchpadContextBar
              businessId={businessId}
              businessName={businessName}
              currency={currency}
              providerAccounts={providerAccounts}
              providerAccountId={providerAccountId}
              accountLoading={providerAccountsLoading}
              onProviderAccountChange={changeProviderAccount}
            />
            {/* Standing write-boundary notice — the surface's contract, not a
              transient state, so it renders on every Launchpad step. */}
            <div
              className={styles.scopeBlock}
              data-testid="launchpad-write-boundary"
            >
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              <div>
                <strong>Launches create PAUSED campaigns.</strong>
                <p>
                  Activation is a separate manual step with its own
                  confirmation. Every write records an immutable receipt.
                </p>
              </div>
            </div>
            <div className={styles.wizardFrame}>
              <div className={styles.wizardHeader}>
                <div className={styles.wizardIdentity}>
                  {step !== "progress" ? (
                    <button
                      type="button"
                      onClick={() => setStep("source")}
                      className={styles.sourceButton}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Source
                    </button>
                  ) : null}
                  <div className={styles.wizardTitle}>
                    <strong>{launchpadModeLabel(mode)}</strong>
                    <span>
                      {sourceLineageLabel} · {providerAccountId} · {currency}
                    </span>
                  </div>
                  {wizardPrefilled ? (
                    <span className="chip chip--info">
                      {wizardPrefillLabel}
                    </span>
                  ) : appliedTemplateMessageActive && appliedTemplateName ? (
                    <span className="chip chip--info">
                      Applied {appliedTemplateName}
                    </span>
                  ) : null}
                </div>
                <div className={styles.wizardActions}>
                  {templateMessage && !wizardPrefilled ? (
                    <span className={styles.saveMessage}>
                      <Cloud className="h-3.5 w-3.5 text-[var(--ok)]" />
                      {templateMessage}
                      {appliedTemplateMessageActive ? (
                        <button type="button" onClick={clearAppliedTemplate}>
                          Clear
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                  {mode === "new_campaign" ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={saveTemplate}
                      disabled={
                        templateCapability?.canWrite !== true ||
                        writeRefusalReason != null
                      }
                      title={
                        writeRefusalReason ??
                        (templateCapability?.canWrite === false
                          ? "Pending account-scope database migration"
                          : undefined)
                      }
                    >
                      <Bookmark className="h-3.5 w-3.5" />
                      Save template
                    </button>
                  ) : null}
                </div>
              </div>

              <div className={styles.wizardGrid}>
                <aside className={styles.stepRail} aria-label="Launch steps">
                  {step !== "progress" ? (
                    <>
                      <LaunchpadModeChooser
                        mode={mode}
                        onSelectMode={startMode}
                      />
                      <LaunchpadStepper
                        steps={activeSteps}
                        currentStep={step}
                        onSelectStep={setStep}
                      />
                    </>
                  ) : (
                    <div className={styles.receiptRail}>
                      <span className="chip chip--info">
                        Provider write receipt
                      </span>
                      <p className="text-[11.5px] leading-relaxed text-[var(--muted)]">
                        Result state comes from the completed route response. No
                        simulated progress is shown.
                      </p>
                    </div>
                  )}
                </aside>

                <main className={styles.editor}>
                  {creativeError ? (
                    <div className="mb-4 rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
                      {creativeError}
                    </div>
                  ) : null}

                  {step === "scope" ? (
                    <LaunchpadScopeStep
                      businessName={businessName}
                      providerAccountId={providerAccountId}
                      providerAccountName={
                        selectedProviderAccount?.name ?? providerAccountId
                      }
                      currency={currency}
                      mode={mode}
                      sourceLineageLabel={sourceLineageLabel}
                    />
                  ) : null}
                  {step === "creatives" ? (
                    <LaunchpadCreativeSelection
                      rows={launchpadCreatives}
                      selectedCreativeIds={selectedCreativeIds}
                      decisionByCreativeId={decisionByCreativeId}
                      loading={creativeLoading}
                      initialStatusFilter={
                        mode === "manage_existing" ? "all" : "active"
                      }
                      currency={currency}
                      getSelectionId={(row) =>
                        mode === "manage_existing"
                          ? resolveLaunchpadAdActionId(row)
                          : // The list is filtered to rows carrying a creative
                            // identity, so this coalesce never fires; it keeps
                            // the selection key a string rather than inventing
                            // one, and an empty key selects nothing.
                            (row.creativeId ?? "")
                      }
                      onToggleCreative={toggleCreative}
                      onSetSelectedCreativeIds={setSelectedCreativeIds}
                    />
                  ) : null}
                  {step === "basics" ? (
                    mode === "new_campaign" ? (
                      <div className={styles.editorStack}>
                        <LaunchpadCampaignBasics
                          value={campaign}
                          onChange={setCampaign}
                        />
                        <LaunchpadBudget
                          value={budget}
                          currency={currency}
                          expectedCpa={expectedCpa}
                          onChange={setBudget}
                        />
                      </div>
                    ) : (
                      <LaunchpadBoundaryStep
                        title={
                          mode === "add_to_existing"
                            ? "Campaign and budget are inherited"
                            : "No creation settings in this workflow"
                        }
                        description={
                          mode === "add_to_existing"
                            ? "The selected target campaign and ad set remain authoritative. Launchpad does not rewrite their budget while adding PAUSED ads."
                            : "Manage existing operates on selected ads. It does not create or edit campaign budgets."
                        }
                        rows={[
                          ["Mode", launchpadModeLabel(mode)],
                          ["Write boundary", "No budget mutation"],
                          ["Delivery", "PAUSED or risk-reducing pause only"],
                        ]}
                      />
                    )
                  ) : null}
                  {step === "adsets" ? (
                    mode === "new_campaign" ? (
                      <LaunchpadAdSets
                        value={adSets}
                        businessId={businessId}
                        providerAccountId={providerAccountId}
                        campaignName={campaign.name}
                        budget={budget}
                        currency={currency}
                        onChange={setAdSets}
                      />
                    ) : mode === "add_to_existing" ? (
                      <LaunchpadAddToExistingTarget
                        businessId={businessId}
                        providerAccountId={providerAccountId}
                        value={addToExistingTarget}
                        selectedCreatives={selectedCreatives}
                        currency={currency}
                        onChange={setAddToExistingTarget}
                        preselectedCampaignIds={
                          serverPrefill?.selection.campaignIds
                        }
                        preselectedAdsetIds={serverPrefill?.selection.adsetIds}
                      />
                    ) : (
                      <LaunchpadBoundaryStep
                        title="Selected ads define the provider scope"
                        description="Pause applies only to the exact selected Meta ad IDs. Campaign and ad-set structure remains unchanged."
                        rows={[
                          ["Selected ads", String(selectedCreativeIds.length)],
                          ["Available actions", "Pause · Activate"],
                        ]}
                      />
                    )
                  ) : null}
                  {step === "review" && mode === "manage_existing" ? (
                    <LaunchpadManageExistingReview
                      selectedCreatives={selectedCreatives}
                      onRun={runBulkStatusAction}
                    />
                  ) : null}
                  {step === "review" && mode !== "manage_existing" ? (
                    <LaunchpadReview
                      mode={mode}
                      businessId={businessId}
                      providerAccountId={providerAccountId}
                      payload={
                        mode === "add_to_existing"
                          ? addToExistingPayload
                          : payload
                      }
                      currencyCode={currency}
                      selectedCreatives={selectedCreatives}
                      decisionByCreativeId={decisionByCreativeId}
                      targetSummary={
                        mode === "add_to_existing"
                          ? {
                              campaignName:
                                selectedExistingTargets[0]?.campaign.name ??
                                null,
                              adsetName:
                                selectedExistingTargets[0]?.adset.name ?? null,
                              campaignCount: selectedExistingCampaigns.length,
                              targetCount: selectedExistingTargets.length,
                              currentAdCount: selectedExistingTargets.reduce(
                                (sum, target) =>
                                  sum + target.adset.currentAdCount,
                                0,
                              ),
                              budgetLines: selectedExistingTargets.map(
                                ({ campaign: targetCampaign, adset }) => ({
                                  label: `${targetCampaign.name} / ${adset.name}`,
                                  amountMinor:
                                    adset.dailyBudgetMinor ??
                                    adset.lifetimeBudgetMinor ??
                                    targetCampaign.dailyBudgetMinor ??
                                    targetCampaign.lifetimeBudgetMinor ??
                                    null,
                                  schedule:
                                    adset.dailyBudgetMinor != null ||
                                    (adset.lifetimeBudgetMinor == null &&
                                      targetCampaign.dailyBudgetMinor != null)
                                      ? ("daily" as const)
                                      : adset.lifetimeBudgetMinor != null ||
                                          targetCampaign.lifetimeBudgetMinor !=
                                            null
                                        ? ("lifetime" as const)
                                        : null,
                                  source:
                                    adset.dailyBudgetMinor != null ||
                                    adset.lifetimeBudgetMinor != null
                                      ? ("ad set" as const)
                                      : targetCampaign.dailyBudgetMinor !=
                                            null ||
                                          targetCampaign.lifetimeBudgetMinor !=
                                            null
                                        ? ("campaign" as const)
                                        : null,
                                }),
                              ),
                            }
                          : null
                      }
                      onSaveTemplate={
                        mode === "new_campaign" &&
                        templateCapability?.canWrite &&
                        viewer.canMutate
                          ? saveTemplate
                          : undefined
                      }
                      onSaveDraft={
                        draftCapability?.canWrite && viewer.canMutate
                          ? saveDraft
                          : undefined
                      }
                      // A viewer the backend will refuse keeps the control on
                      // screen and disabled with the reason, instead of
                      // watching it disappear with no explanation.
                      viewerWriteRefusalReason={writeRefusalReason}
                      onLaunch={launchPaused}
                      executionBlockedReason={
                        // Viewer first, gate second. Being a reviewer is a fact
                        // about this operator and is the more actionable thing
                        // to hear; a closed gate is a fact about the product
                        // and applies to everyone. Both refuse, and the server
                        // enforces both regardless of which sentence is shown.
                        writeRefusalReason ??
                        (!executionEnabled
                          ? META_GATE_REFUSAL_REASONS.launchpadExecution
                          : null) ??
                        (mode === "add_to_existing" &&
                        addToExistingPayload.copyMode === "rebuild_creative"
                          ? "Recreate exact ad is review-only until durable receipts cover every provider image, creative, and ad write."
                          : launchIntentCapability?.canWrite
                            ? null
                            : launchIntentCapability?.status ===
                                "migration_required"
                              ? "LaunchIntent storage migration is required before PAUSED creation can run."
                              : "LaunchIntent storage capability is still being verified.")
                      }
                    />
                  ) : null}
                  {step === "progress" ? (
                    <LaunchpadProgress
                      mode={mode}
                      loading={launchLoading}
                      result={launchResult}
                      activation={
                        launchIntentId && launchIntentActivatable ? (
                          <LaunchpadActivationPanel
                            businessId={businessId}
                            intentId={launchIntentId}
                            intentStatus={launchResult?.launchIntentStatus ?? null}
                            /*
                              The intent's own operation when it has been read,
                              and the wizard mode otherwise. `manage_existing`
                              never writes an intent, so it cannot reach here.
                            */
                            operation={
                              activationIntent?.operation ??
                              (mode === "add_to_existing"
                                ? "add_to_existing"
                                : "new_campaign")
                            }
                            approval={activationIntent?.activationApproval ?? null}
                            approvalUnavailableReason={activationIntentUnavailable}
                            activationReceipt={
                              activationIntent?.activationReceipt ?? null
                            }
                            canMutate={viewer.canMutate && executionEnabled}
                            refusalReason={
                              // The same ladder the create control uses: the
                              // viewer's own refusal first, then the release
                              // gate, which is a deployment fact and applies to
                              // everyone. The route enforces both regardless.
                              writeRefusalReason ??
                              (!executionEnabled
                                ? META_GATE_REFUSAL_REASONS.launchpadExecution
                                : null)
                            }
                            onResult={() => {
                              void refreshActivationIntent();
                            }}
                          />
                        ) : null
                      }
                      onDone={resetWizard}
                    />
                  ) : null}
                </main>
              </div>

              {step !== "progress" ? (
                <div className={styles.footer}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="mono text-[12.5px] text-[var(--ink)]">
                        <strong className="font-semibold">
                          {launchpadFooterMathLine({
                            mode,
                            creativeCount: selectedCreativeIds.length,
                            adSetCount: adSets.length,
                            targetCount: selectedExistingTargets.length,
                          })}
                        </strong>
                      </div>
                      {selectionSummary.count > 0 ? (
                        <div className="mt-0.5 text-[11px] text-[var(--muted-2)] tabular-nums">
                          selection · spend{" "}
                          {selectionSummary.totalSpend == null
                            ? "unavailable"
                            : formatMoney(
                                selectionSummary.totalSpend,
                                currency,
                              )}{" "}
                          · weighted ROAS{" "}
                          {selectionSummary.averageRoas == null
                            ? "—"
                            : `${selectionSummary.averageRoas.toFixed(1)}x`}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                          Create changes provider state to PAUSED and cannot
                          begin delivery.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="btn"
                        disabled={currentStepIndex <= 0}
                        onClick={goBack}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Back
                      </button>
                      {step === "review" ? (
                        <span className="btn btn--ghost" aria-disabled="true">
                          Launch action is in review
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={!canGoNext}
                          onClick={goNext}
                        >
                          Continue
                          <ArrowRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LaunchpadMobileSurface({
  businessName,
  currency,
  providerAccountId,
  mode,
  step,
  selectedCount,
  draftCount,
  templateCount,
  libraryReadable,
  libraryLoading,
  creativeLoading,
  sourceLineageLabel,
  desktopHref,
  statusMessage = null,
}: {
  businessName: string;
  currency: string | null;
  providerAccountId: string;
  mode: LaunchpadMode;
  step: WizardStep;
  selectedCount: number;
  draftCount: number;
  templateCount: number;
  /** False when the store could not be read; a count would then be a guess. */
  libraryReadable: boolean;
  libraryLoading: boolean;
  creativeLoading: boolean;
  sourceLineageLabel: string;
  desktopHref: string;
  statusMessage?: string | null;
}) {
  const loading = libraryLoading || creativeLoading;

  return (
    <section
      className={`meta-mobile-surface-stage ${styles.mobileSurface}`}
      data-testid="meta-mobile-launchpad"
      aria-label="Launchpad mobile read-only"
    >
      <header className={styles.mobileHeader}>
        <p>Launchpad · read-only</p>
        <h1>{businessName}</h1>
        <span>{launchpadModeLabel(mode)}</span>
      </header>
      <div className={styles.mobileBody}>
        {statusMessage ? (
          <div className={styles.mobileStatus} role="status">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {statusMessage}
          </div>
        ) : null}
        <dl className={styles.mobileFacts}>
          <div>
            <dt>Current step</dt>
            <dd>{step}</dd>
          </div>
          <div>
            <dt>Lineage</dt>
            <dd>{sourceLineageLabel}</dd>
          </div>
          <div>
            <dt>Ad account</dt>
            <dd>{providerAccountId || "Not selected"}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{currency ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Selected</dt>
            <dd>{selectedCount}</dd>
          </div>
          <div>
            <dt>Library</dt>
            <dd>
              {loading
                ? "Loading"
                : libraryReadable
                  ? `${draftCount} drafts · ${templateCount} templates`
                  : // The drafts route answers an unreadable store with
                    // `{ok: true, drafts: [], capability}`, so the array is
                    // empty for "none stored" and for "could not read" alike.
                    // Printing 0 for the second is a zero standing in for an
                    // unknown, on the one line that claims to state the library.
                    "Library unavailable"}
            </dd>
          </div>
        </dl>
        <div className={styles.mobilePolicy}>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <p>
            No write controls are rendered on mobile. Desktop creation remains
            PAUSED-only and server validation runs before provider writes.
          </p>
        </div>
        <Link href={desktopHref} className={styles.mobileDeepLink}>
          Open this exact workflow on desktop
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}

function LaunchpadContextBar({
  businessId,
  businessName,
  currency,
  providerAccounts,
  providerAccountId,
  accountLoading,
  onProviderAccountChange,
}: {
  businessId: string;
  businessName: string;
  currency: string | null;
  providerAccounts: MetaHistoryAccount[];
  providerAccountId: string;
  accountLoading: boolean;
  onProviderAccountChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 pb-3">
      <div className="min-w-0">
        {/* v2 page head: mono eyebrow over a display-weight title. */}
        <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
          Meta · Guarded write surface
        </p>
        <h1 className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-[var(--adv-ink)]">
          Launchpad
        </h1>
        <div className="mono mt-1 text-[11px] text-[var(--muted)]">
          {businessName} · {currency ?? "currency unavailable"}
        </div>
      </div>
      <span className="chip chip--warn">Everything launches PAUSED</span>
      <div className="min-w-0 flex-1" />
      <label className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2 text-[11px] text-[var(--muted)]">
        Ad account
        <select
          aria-label="Meta ad account for Launchpad"
          value={providerAccountId}
          disabled={accountLoading}
          onChange={(event) =>
            onProviderAccountChange(event.currentTarget.value)
          }
          className="max-w-[220px] border-0 bg-transparent text-[var(--ink)] outline-none"
        >
          <option value="">
            {accountLoading
              ? "Loading accounts"
              : providerAccounts.length === 0
                ? "No assigned account"
                : "Select account"}
          </option>
          {providerAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name ?? account.id}
              {account.currency ? ` · ${account.currency}` : ""}
            </option>
          ))}
        </select>
      </label>
      <span className="chip chip--ghost">guards checked at write time</span>
      <Link
        href={buildMetaScopedHref("/platforms/meta", {
          businessId,
          providerAccountId,
        })}
        className="text-[12px] font-medium text-[var(--info)] hover:text-[var(--ink)]"
      >
        ← Decisions
      </Link>
    </div>
  );
}

function formatLaunchpadPrefillLabel(
  handoff: LaunchpadLegacyHandoff,
  selectedCount: number,
) {
  const action =
    handoff.requestedMode === "duplicate"
      ? "duplicate"
      : handoff.requestedMode === "apply_bid"
        ? "apply bid"
        : "rebuild";
  const count = Math.max(1, selectedCount);
  return `${hasCompleteLaunchpadLineageIdentifiers(handoff) ? "Lineage identifiers" : "Legacy prefill"} · ${handoff.source} · ${action} · ${count} creative${count === 1 ? "" : "s"}`;
}

function launchpadFooterMathLine(input: {
  mode: LaunchpadMode;
  creativeCount: number;
  adSetCount: number;
  targetCount: number;
}) {
  if (input.mode === "new_campaign") {
    return `${input.creativeCount} creatives × ${input.adSetCount} ad set${input.adSetCount === 1 ? "" : "s"} = ${
      input.creativeCount * input.adSetCount
    } ads`;
  }
  if (input.mode === "add_to_existing") {
    const targetCount = Math.max(1, input.targetCount);
    return `${input.creativeCount} creatives × ${targetCount} target${targetCount === 1 ? "" : "s"} = ${
      input.creativeCount * targetCount
    } ads`;
  }
  return `${input.creativeCount} selected ads · PAUSE is current · ACTIVE is contract-required`;
}

function LaunchpadModeChooser({
  mode,
  onSelectMode,
}: {
  mode: LaunchpadMode;
  onSelectMode: (mode: LaunchpadMode) => void;
}) {
  const modes: Array<{
    id: LaunchpadMode;
    label: string;
    icon: typeof Megaphone;
  }> = [
    { id: "new_campaign", label: "New campaign", icon: Megaphone },
    { id: "add_to_existing", label: "Add to existing", icon: PlusCircle },
    { id: "manage_existing", label: "Pause existing ads", icon: Settings2 },
  ];
  return (
    <div className={styles.modeChooser} data-testid="launchpad-mode-selector">
      <span>Workflow</span>
      {modes.map((item) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            className={styles.modeButton}
            data-active={mode === item.id ? "true" : "false"}
            aria-pressed={mode === item.id}
            key={item.id}
            onClick={() => onSelectMode(item.id)}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function LaunchpadScopeStep({
  businessName,
  providerAccountId,
  providerAccountName,
  currency,
  mode,
  sourceLineageLabel,
}: {
  businessName: string;
  providerAccountId: string;
  providerAccountName: string;
  currency: string;
  mode: LaunchpadMode;
  sourceLineageLabel: string;
}) {
  return (
    <section className={styles.scopePanel} data-testid="launchpad-scope-step">
      <div className={styles.editorHeading}>
        <div>
          <p>Account & scope</p>
          <h2>Confirm the provider boundary</h2>
        </div>
        <span className="chip chip--healthy">Explicit scope</span>
      </div>
      <dl className={styles.scopeFacts}>
        <div>
          <dt>Business</dt>
          <dd>{businessName}</dd>
        </div>
        <div>
          <dt>Meta ad account</dt>
          <dd>
            {providerAccountName} · {providerAccountId}
          </dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{currency}</dd>
        </div>
        <div>
          <dt>Workflow</dt>
          <dd>{launchpadModeLabel(mode)}</dd>
        </div>
        <div>
          <dt>Lineage</dt>
          <dd>{sourceLineageLabel}</dd>
        </div>
        <div>
          <dt>Write posture</dt>
          <dd>Server validation · guard check · PAUSED creation</dd>
        </div>
      </dl>
      <p className={styles.boundaryNote}>
        Currency is never inferred across accounts. Provider writes remain
        blocked if this account scope or its currency becomes unreadable.
      </p>
    </section>
  );
}

function LaunchpadBoundaryStep({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: Array<[string, string]>;
}) {
  return (
    <section className={styles.boundaryPanel}>
      <div className={styles.editorHeading}>
        <div>
          <p>Workflow boundary</p>
          <h2>{title}</h2>
        </div>
        <ShieldCheck aria-hidden="true" className="h-4 w-4" />
      </div>
      <p className={styles.boundaryDescription}>{description}</p>
      <dl className={styles.boundaryFacts}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function draftLandingMode(draft: LaunchDraft) {
  if (draft.payload.mode !== "add_to_existing") return "—";
  if (draft.payload.copyMode === "rebuild_creative") return "Rebuild";
  if (draft.payload.copyMode === "reuse_creative") return "Duplicate";
  return "—";
}

/**
 * One draft's verdict from `/api/launchpad/meta/validate`. `pending` means the
 * server has not answered for this draft yet; `unavailable` means it answered
 * with something that carries no verdict (transport failure, account blocker).
 * Neither is rendered as a verdict.
 */
export type LaunchpadDraftValidation =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "checked"; ok: boolean; blockerCount: number };

export function draftLandingValidation(
  draft: LaunchDraft,
  validations: Record<string, LaunchpadDraftValidation | undefined>,
) {
  const validation = validations[draft.id];
  if (!validation || validation.status !== "checked") return "—";
  if (validation.blockerCount > 0) {
    return `${validation.blockerCount} blocker${validation.blockerCount === 1 ? "" : "s"}`;
  }
  return validation.ok ? "Ready" : "—";
}

function draftLandingValidationStatus(
  draft: LaunchDraft,
  validations: Record<string, LaunchpadDraftValidation | undefined>,
) {
  const validation = validations[draft.id];
  if (!validation || validation.status !== "checked") return "unknown";
  if (validation.blockerCount > 0) return "failed";
  return validation.ok ? "ready" : "unknown";
}

export function LaunchpadExactLanding({
  drafts,
  intents,
  loading,
  scopeReady = true,
  libraryUnavailableReason = null,
  verifiedRole,
  verifiedHandoffName,
  draftValidations = {},
  onStartRole,
  onApplyDraft,
}: {
  drafts: LaunchDraft[];
  intents: MetaLaunchIntent[];
  loading: boolean;
  scopeReady?: boolean;
  /**
   * Why this table is empty, when it is empty because the library was not read
   * rather than because there is nothing in it. `null` means the reads
   * answered. It is rendered in the existing empty row's first cell — the same
   * element, the same layout — because a refusal shown as an em dash is
   * indistinguishable from a real empty account.
   */
  libraryUnavailableReason?: string | null;
  verifiedRole: LaunchStartRole | null;
  verifiedHandoffName: string | null;
  draftValidations?: Record<string, LaunchpadDraftValidation | undefined>;
  onStartRole: (role: LaunchStartRole) => void;
  onApplyDraft: (draft: LaunchDraft) => void;
}) {
  return (
    <section
      className={styles.exactLanding}
      data-screen-label="Launchpad"
      data-testid="launchpad-exact"
    >
      <div className={styles.exactHeader}>
        <p>Meta · Guarded write surface</p>
        <h1>Launchpad</h1>
      </div>

      <div className={styles.exactNotice} data-testid="launchpad-notice">
        <Shield aria-hidden="true" />
        <p>
          <b>Launches create PAUSED campaigns.</b> Activation is a separate
          manual step with its own confirmation. Every write records an
          immutable LaunchIntent lineage.
        </p>
      </div>

      <div className={styles.exactStarts} data-testid="launchpad-starts">
        {LAUNCH_START_CARDS.map((card) => {
          const hasVerifiedName =
            card.role === verifiedRole && Boolean(verifiedHandoffName);
          const roleReady =
            card.role === "manual" || card.role === verifiedRole;
          // A quoted em dash is not a name. These two cards title themselves
          // after the entity Decisions routed here, and until one arrives there
          // is no entity — so the card carries its own name rather than a pair
          // of quotes around a dash, which reads as a value that failed to load.
          const title =
            card.role === "manual"
              ? "Start from scratch"
              : hasVerifiedName
                ? `${card.chip} “${verifiedHandoffName}”`
                : card.chip;
          const description = card.description;
          return (
            <article
              key={card.role}
              className={styles.exactStartCard}
              data-role={card.role}
              data-testid={`launchpad-start-${card.role}`}
            >
              <span className={styles.exactStartChip}>{card.chip}</span>
              <p className={styles.exactStartTitle}>{title}</p>
              <p className={styles.exactStartDescription}>{description}</p>
              <button
                type="button"
                onClick={() => onStartRole(card.role)}
                className={styles.exactStartAction}
                disabled={!scopeReady || !roleReady}
                // A dimmed control with no name announces as "button" and
                // explains nothing. Rebuild and Duplicate are fail-closed by
                // contract — the handoff does not forward server-owned
                // authority, so they stay inert until Decisions routes one —
                // and the reason belongs on the control, not only in a doc
                // comment nobody reading the screen can see.
                aria-label={
                  !scopeReady
                    ? `${card.cta}: select a Meta ad account first`
                    : !roleReady
                      ? `${card.cta}: nothing has been routed here from Decisions yet`
                      : undefined
                }
                title={
                  roleReady && scopeReady
                    ? undefined
                    : !scopeReady
                      ? "Select a Meta ad account first."
                      : "Start this from a decision in the Decision Center; it carries the evidence this draft needs."
                }
              >
                {card.cta} →
              </button>
            </article>
          );
        })}
      </div>

      <article className={styles.exactTableCard} data-testid="launchpad-drafts">
        <div className={styles.exactSectionHeader}>
          <h2>Drafts</h2>
          <span>validation runs before any provider call</span>
        </div>
        <table className={styles.exactDraftTable}>
          <thead>
            <tr>
              <th>Draft</th>
              <th>Mode</th>
              <th>Validation</th>
              <th>Updated</th>
              <th aria-label="Action" />
            </tr>
          </thead>
          <tbody>
            {drafts.length > 0 ? (
              drafts.map((draft) => {
                const validation = draftLandingValidation(
                  draft,
                  draftValidations,
                );
                const resumable =
                  scopeReady &&
                  (draft.status === "draft" || draft.status === "failed");
                return (
                  <tr key={draft.id} data-testid="launchpad-draft-row">
                    <td className={styles.exactDraftName}>
                      {draft.name || "—"}
                    </td>
                    <td>
                      <span className={styles.exactModeChip}>
                        {draftLandingMode(draft)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={styles.exactValidationChip}
                        data-status={draftLandingValidationStatus(
                          draft,
                          draftValidations,
                        )}
                      >
                        {validation}
                      </span>
                    </td>
                    <td className={styles.exactUpdated}>
                      {formatRelativeTime(draft.updatedAt)}
                    </td>
                    <td className={styles.exactDraftActionCell}>
                      <button
                        type="button"
                        onClick={() => onApplyDraft(draft)}
                        disabled={!resumable}
                      >
                        {resumable ? "Resume editing" : "—"}
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr
                data-testid="launchpad-draft-empty"
                data-unread={libraryUnavailableReason ? "true" : undefined}
              >
                <td>{libraryUnavailableReason ?? "—"}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td className={styles.exactDraftActionCell}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </article>

      <article
        className={styles.exactReceiptCard}
        data-testid="launchpad-receipts"
        aria-busy={loading}
      >
        <div className={styles.exactSectionHeader}>
          <h2>Launch receipts</h2>
        </div>
        <LaunchIntentReceiptRows intents={intents} />
      </article>
    </section>
  );
}

function LaunchpadStepper({
  steps,
  currentStep,
  onSelectStep,
}: {
  steps: Array<{ id: WizardStep; label: string }>;
  currentStep: WizardStep;
  onSelectStep: (step: WizardStep) => void;
}) {
  const currentIndex = steps.findIndex((step) => step.id === currentStep);
  return (
    <ol className={styles.stepList}>
      {steps.map((item, index) => {
        const active = item.id === currentStep;
        const done = currentIndex >= 0 && index < currentIndex;
        const gated = currentIndex >= 0 && index > currentIndex;
        return (
          <li key={item.id} className={styles.stepItem}>
            <button
              type="button"
              onClick={() => onSelectStep(item.id)}
              disabled={gated}
              className={cn(
                styles.stepButton,
                active ? "bg-[var(--surface-3)]" : "",
                gated ? "cursor-default" : "cursor-pointer",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums",
                  done
                    ? "border-[var(--ink)] bg-[var(--ink)] text-white"
                    : active
                      ? "border-[var(--ink)] bg-[var(--surface-3)] text-[var(--ink)]"
                      : "border-[var(--border-2)] bg-[var(--surface)] text-[var(--muted)]",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  styles.stepLabel,
                  "min-w-0 truncate text-[12px]",
                  active
                    ? "font-semibold text-[var(--ink)]"
                    : done
                      ? "text-[var(--ink-3)]"
                      : "text-[var(--muted)]",
                )}
              >
                {item.label}
              </span>
            </button>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  styles.stepConnector,
                  done ? "bg-[var(--ink)]" : "bg-[var(--border)]",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
