import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { GoogleAnalyticsStatusResponse } from "@/lib/google-analytics-status";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { SearchConsoleStatusResponse } from "@/lib/search-console-status";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import type { ProviderReadCapability } from "@/lib/provider-read-capability";
import type {
  IntegrationProvider,
  ProviderViewState,
} from "@/store/integrations-store";
import type {
  IntegrationsCardModel,
  IntegrationsExactModel,
  IntegrationsFirstSyncModel,
  IntegrationsFirstSyncStepModel,
  IntegrationsSoonCardModel,
  IntegrationsStatusTone,
} from "@/components/integrations/integrations-exact-model";

const DASH = "—";

/** The six providers the design draws in the live grid (4315-4321). */
export type IntegrationsLiveProvider = Extract<
  IntegrationProvider,
  "shopify" | "meta" | "google" | "ga4" | "search_console" | "klaviyo"
>;

/** The three providers the design draws under "Coming soon" (4349-4353). */
export type IntegrationsSoonProvider = Extract<
  IntegrationProvider,
  "tiktok" | "pinterest" | "snapchat"
>;

/**
 * design 4315-4321 `integBase` — order, name and description are fixed UI copy.
 * The grid opens with Shopify and closes with Klaviyo, in this order.
 */
export const INTEGRATIONS_LIVE_ORDER: IntegrationsLiveProvider[] = [
  "shopify",
  "meta",
  "google",
  "ga4",
  "search_console",
  "klaviyo",
];

/** design 4349-4353 `soonIntegrations` — order and names. */
export const INTEGRATIONS_SOON_ORDER: IntegrationsSoonProvider[] = [
  "tiktok",
  "pinterest",
  "snapchat",
];

/** design 4315-4321 / 4349-4353 `name`. */
export const INTEGRATIONS_PROVIDER_NAMES: Record<IntegrationProvider, string> = {
  shopify: "Shopify",
  meta: "Meta Ads",
  google: "Google Ads",
  ga4: "GA4",
  search_console: "Search Console",
  klaviyo: "Klaviyo",
  tiktok: "TikTok Ads",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
};

/**
 * design 4315-4321 `desc` — verbatim, this is fixed copy and not provider data.
 *
 * Only the six live cards have one. The design's roadmap entries (4349-4353)
 * carry a name and an ETA and nothing else, and `SoonCard` has no slot for a
 * description, so there is none to write here.
 */
export const INTEGRATIONS_PROVIDER_DESCRIPTIONS: Record<
  IntegrationsLiveProvider,
  string
> = {
  shopify: "Orders and revenue ledger — the trusted commercial source.",
  meta: "Campaign performance, decision snapshots and guarded writes.",
  google:
    "Search, PMax and Shopping intelligence — guarded writes with receipts.",
  ga4: "Site behavior, funnels and audience quality for Insights.",
  search_console: "Query and indexing data behind SEO insights.",
  klaviyo:
    "Email & SMS lifecycle analysis, read-only during beta. Connect to run the first import — the source joins the sidebar once its snapshot is ready.",
};

/**
 * design 4342 — the two fixed meta strings.
 *
 * `INTEGRATIONS_META_NOT_CONNECTED` covers every non-connected card, including
 * Klaviyo, whose authorization route answers 501: the design's own `showBtn`
 * conditional takes the button away, and the meta line stays the design's.
 */
export const INTEGRATIONS_META_NOT_CONNECTED = "no data pulled yet";
export const INTEGRATIONS_META_SYNCING =
  "first import running — nothing shows in the app until the snapshot lands";

/** design 4323-4330 `syncSteps` — labels, boundaries and hint notes. */
const FIRST_SYNC_STAGES: Array<{
  key: string;
  label: string;
  from: number;
  to: number;
  hint: string;
}> = [
  { key: "authorize", label: "Authorize", from: 0, to: 8, hint: "OAuth scopes" },
  {
    key: "entities",
    label: "Fetch entities",
    from: 8,
    to: 35,
    hint: "flows · campaigns · lists",
  },
  {
    key: "backfill",
    label: "Backfill 28 days",
    from: 35,
    to: 82,
    hint: "events & revenue",
  },
  {
    key: "snapshot",
    label: "Validate & snapshot",
    from: 82,
    to: 100,
    hint: "ready to read",
  },
];

/** design 4323-4330: done at/after `to`, current at/after `from`, else pending. */
export function buildFirstSyncSteps(
  percent: number,
): IntegrationsFirstSyncStepModel[] {
  return FIRST_SYNC_STAGES.map((stage) => {
    const done = percent >= stage.to;
    const current = !done && percent >= stage.from;
    return {
      key: stage.key,
      label: stage.label,
      note: current ? stage.hint : done ? "done" : "",
      state: done ? "done" : current ? "current" : "pending",
    };
  });
}

/**
 * What a provider's own status endpoint says about its first import.
 *
 * Every field is read from a served status response or from the stored
 * connection row — nothing here advances on a clock. A provider that serves no
 * status at all yields `null` signals and therefore no progress block, because
 * we cannot honestly claim an import is running.
 */
export interface FirstSyncSignals {
  /** The OAuth handshake landed. */
  connected: boolean;
  /**
   * The provider's own state says work is moving right now, as opposed to
   * halted, behind, broken, waiting on the operator or finished.
   */
  importing: boolean;
  /** Accounts/properties are discovered and assigned. */
  entitiesReady: boolean;
  /** 0..1 of the historical window that has landed, or null when unknown. */
  backfillFraction: number | null;
  /** The provider's readiness verdict says the snapshot is servable. */
  snapshotReady: boolean;
  /** When this connection was made (`ProviderViewState.connectedAt`). */
  connectedAt: string | null;
}

/**
 * Provider states that mean an import is actually in flight.
 *
 * Every other state a connected provider can report is something else: `ready`
 * has landed, `paused` was halted, `stale` fell behind after landing,
 * `action_required` is broken, `advisor_not_ready` is a downstream verdict, and
 * `connected_no_assignment` is waiting on the operator rather than on data.
 * None of those may paint a progress bar.
 */
const IMPORTING_PROVIDER_STATES = new Set<string>(["syncing", "partial"]);

/**
 * How long after connecting a source may still be said to be running its FIRST
 * import.
 *
 * The design's own third stage is "Backfill 28 days": landing that window is
 * what the first import is for. A connection older than the window it had to
 * backfill is not still running it — it is a long-lived source that dropped out
 * of "ready" for some other reason, and the card must say that instead of
 * showing a bar. A connection with no recorded date proves nothing, so it gets
 * no bar either.
 */
export const FIRST_IMPORT_MAX_CONNECTION_AGE_MS = 28 * 24 * 60 * 60 * 1000;

/** True only when `connectedAt` is known and new enough to be a first import. */
export function isFirstImportConnection(
  connectedAt: string | null | undefined,
  now: number,
): boolean {
  if (!connectedAt) return false;
  const started = Date.parse(connectedAt);
  if (Number.isNaN(started)) return false;
  return now - started <= FIRST_IMPORT_MAX_CONNECTION_AGE_MS;
}

/**
 * Map a provider's real signals onto the design's percent scale.
 *
 * Returns null unless the provider plausibly is running its first import. The
 * design states the rule outright at line 2819 — "Sync progress appears once:
 * while a new source runs its first import" — so all four facts must hold:
 * connected, no snapshot yet, an in-flight state, and a connection young enough
 * that the import it is running can only be the first one.
 *
 * The percent never runs ahead of evidence. Each stage boundary is only crossed
 * when the fact behind it is true, so an unknown backfill parks the bar at the
 * start of its own stage instead of drifting upward.
 */
export function resolveFirstSyncPercent(
  signals: FirstSyncSignals | null,
  now: number = Date.now(),
): number | null {
  if (!signals) return null;
  if (!signals.connected) return null;
  if (signals.snapshotReady) return null;
  if (!signals.importing) return null;
  if (!isFirstImportConnection(signals.connectedAt, now)) return null;

  if (!signals.entitiesReady) return FIRST_SYNC_STAGES[1]!.from;

  const fraction = signals.backfillFraction;
  if (fraction === null || !Number.isFinite(fraction)) {
    return FIRST_SYNC_STAGES[2]!.from;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  if (clamped >= 1) return FIRST_SYNC_STAGES[3]!.from;
  return FIRST_SYNC_STAGES[2]!.from + clamped * (FIRST_SYNC_STAGES[2]!.to - FIRST_SYNC_STAGES[2]!.from);
}

export function buildFirstSyncModel(
  signals: FirstSyncSignals | null,
  now: number = Date.now(),
): IntegrationsFirstSyncModel | null {
  const percent = resolveFirstSyncPercent(signals, now);
  if (percent === null) return null;
  const rounded = Math.round(percent);
  return {
    percentLabel: `${rounded}%`,
    barWidth: `${percent}%`,
    complete: percent >= 100,
    steps: buildFirstSyncSteps(percent),
  };
}

function fractionFromDays(
  completed: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (typeof completed !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return completed / total;
}

function fractionFromPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value / 100;
}

export function metaFirstSyncSignals(
  status: MetaStatusResponse | null | undefined,
  connectedAt: string | null = null,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    importing: IMPORTING_PROVIDER_STATES.has(status.state),
    entitiesReady: (status.assignedAccountIds?.length ?? 0) > 0,
    backfillFraction:
      fractionFromDays(
        status.priorityWindow?.completedDays,
        status.priorityWindow?.totalDays,
      ) ?? fractionFromPercent(status.currentCoreProgressPercent),
    snapshotReady:
      status.state === "ready" || status.coreReadiness?.complete === true,
    connectedAt,
  };
}

export function googleFirstSyncSignals(
  status: GoogleAdsStatusResponse | null | undefined,
  connectedAt: string | null = null,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    importing: IMPORTING_PROVIDER_STATES.has(status.state),
    entitiesReady:
      (status.assignedAccountIds?.length ?? 0) > 0 &&
      status.state !== "connected_no_assignment",
    backfillFraction:
      fractionFromPercent(status.historicalProgress?.percent) ??
      fractionFromPercent(status.backgroundBackfill?.percent),
    snapshotReady: status.state === "ready",
    connectedAt,
  };
}

export function shopifyFirstSyncSignals(
  status: ShopifyStatusResponse | null | undefined,
  connectedAt: string | null = null,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  const ordersHistorical = status.sync?.ordersHistorical ?? null;
  const readyThrough = ordersHistorical?.readyThroughDate ?? null;
  const target = ordersHistorical?.historicalTargetEnd ?? null;
  return {
    connected: true,
    importing: IMPORTING_PROVIDER_STATES.has(status.state),
    entitiesReady: Boolean(status.shopId),
    // Shopify reports a ready-through date, not a day count: it can prove the
    // backfill finished but cannot say how far along an unfinished one is.
    backfillFraction: readyThrough && target ? (readyThrough >= target ? 1 : null) : null,
    snapshotReady: status.state === "ready",
    connectedAt,
  };
}

/**
 * GA4's importer is the report warmer, and it reports its own state.
 *
 * `state: "syncing"` is set by `lib/google-analytics-status.ts` only while a
 * `provider_sync_jobs` row for the GA4 warm loop is `running` and inside the
 * fifteen-minute boundary this codebase already uses to call such a job stuck —
 * so a crashed or finished import cannot keep the bar alive. `connected_no_property`
 * waits on the operator, `awaiting_first_sync` has nothing in flight and
 * `first_sync_stalled` has stopped moving; none of those is in
 * `IMPORTING_PROVIDER_STATES`, so none of them paints a bar.
 *
 * `backfillFraction` is null by contract — GA4 exposes no share of the window,
 * only "the snapshot is there or it is not" — which parks the bar at the start
 * of the backfill stage exactly as it does for Shopify's unfinished backfill,
 * rather than approximating a number under the design's own caption.
 */
export function ga4FirstSyncSignals(
  status: GoogleAnalyticsStatusResponse | null | undefined,
  connectedAt: string | null = null,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    importing: IMPORTING_PROVIDER_STATES.has(status.state),
    entitiesReady: status.propertyReady,
    backfillFraction: fractionFromPercent(status.backfillPercent),
    snapshotReady: status.state === "ready" || status.snapshotReady,
    connectedAt,
  };
}

/**
 * Search Console's importer is the same report warmer; see `ga4FirstSyncSignals`.
 *
 * One extra fact matters here: Search Console reads on the `google`
 * connection's credential, so `lib/search-console-status.ts` reports
 * `action_required` when that credential is missing or lacks the webmasters
 * scope even though the Search Console row itself still says connected. That
 * state is not an importing state, so a card whose authority is broken shows
 * the fault instead of a progress bar.
 */
export function searchConsoleFirstSyncSignals(
  status: SearchConsoleStatusResponse | null | undefined,
  connectedAt: string | null = null,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    importing: IMPORTING_PROVIDER_STATES.has(status.state),
    entitiesReady: status.siteReady,
    backfillFraction: fractionFromPercent(status.backfillPercent),
    snapshotReady: status.state === "ready" || status.snapshotReady,
    connectedAt,
  };
}

function formatConnectedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatFreshness(
  value: string | null | undefined,
  now: number,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * design 4342 — one monospace line: identity · connected date · freshness.
 *
 * Any of the three the provider does not supply renders as an em-dash rather
 * than collapsing, so a card never implies a fact it does not have.
 */
export function buildConnectedMetaLine(
  view: ProviderViewState,
  now: number,
): string {
  const identity =
    view.detailValue && view.detailValue !== "Not configured yet"
      ? view.detailValue
      : (view.accountValue && view.accountValue !== DASH ? view.accountValue : DASH);
  const connected = formatConnectedDate(view.connectedAt);
  const fresh = formatFreshness(view.lastSyncValue, now);
  return [
    identity,
    connected ? `connected ${connected}` : DASH,
    fresh ? `fresh ${fresh}` : DASH,
  ].join(" · ");
}

/**
 * The pill caption (design 4341).
 *
 * The design has three captions — Connecting / Connected / Not connected —
 * because its fixture has three states. This product has more: a connection can
 * be broken or degraded while still being a connection. "Action required" and
 * "Degraded" are a deliberate extension, recorded in
 * docs/dashboard-v2-parity-defects.md, and they are read FIRST: a broken
 * provider must never be described as "Connecting", whatever any in-flight
 * import claims.
 */
/**
 * The same lie the Insights header used to tell, on the card the operator would
 * come here to fix.
 *
 * `view.status` is derived from one connection row, so a `search_console` row
 * whose borrowed `google` credential is gone, or a `ga4` row with no property
 * selected, both render "Connected" while every read they gate refuses. When a
 * capability is supplied it outranks the row: the pill names the setup step
 * (the card's own button already says "Select Property" / "Select Site") or
 * sends the operator to the Google card, rather than claiming a working source.
 */
function statusFromBlockedCapability(
  capability: ProviderReadCapability | undefined,
): { status: string; tone: IntegrationsStatusTone } | null {
  if (!capability || capability.canRead) return null;
  switch (capability.block) {
    case "google_reconnect_required":
      return { status: "Action required", tone: "attention" };
    case "property_not_selected":
    case "site_not_selected":
      return { status: "Needs setup", tone: "connecting" };
    default:
      // "not connected" and "connection fault" are already what the row says.
      return null;
  }
}

function resolveStatus(
  provider: IntegrationProvider,
  view: ProviderViewState,
  syncing: boolean,
  capability?: ProviderReadCapability,
): { status: string; tone: IntegrationsStatusTone } {
  if (view.status === "action_required") {
    return { status: "Action required", tone: "attention" };
  }
  if (view.status === "degraded") {
    return { status: "Degraded", tone: "attention" };
  }
  const blocked = statusFromBlockedCapability(capability);
  if (blocked) return blocked;
  // design 4341: while the first import runs the pill reads "Connecting".
  if (syncing) return { status: "Connecting", tone: "connecting" };
  switch (view.status) {
    case "ready":
      return {
        status: provider === "klaviyo" ? "Connected · Beta" : "Connected",
        tone: "connected",
      };
    case "loading_data":
      return { status: "Connecting", tone: "connecting" };
    case "needs_assignment":
      return { status: "Needs setup", tone: "connecting" };
    default:
      return { status: "Not connected", tone: "neutral" };
  }
}

export interface IntegrationsExactAdapterInput {
  /** Provider view states derived from the integrations store, keyed by provider. */
  views: Partial<Record<IntegrationProvider, ProviderViewState>>;
  metaStatus?: MetaStatusResponse | null;
  googleStatus?: GoogleAdsStatusResponse | null;
  shopifyStatus?: ShopifyStatusResponse | null;
  ga4Status?: GoogleAnalyticsStatusResponse | null;
  searchConsoleStatus?: SearchConsoleStatusResponse | null;
  /**
   * Effective read capability per provider, from `lib/provider-read-capability`.
   * Optional: a caller that supplies none leaves the cards on the stored rows.
   */
  capabilities?: Partial<Record<IntegrationProvider, ProviderReadCapability>>;
  /** Providers with a working authorization route today. */
  connectableProviders: IntegrationProvider[];
  logoFor: (provider: IntegrationProvider) => string | null;
  /** Injected so the freshness suffix is deterministic under test. */
  now?: number;
}

export function buildIntegrationsExactModel(
  input: IntegrationsExactAdapterInput,
): IntegrationsExactModel {
  const now = input.now ?? Date.now();

  const cards: IntegrationsCardModel[] = [];
  for (const provider of INTEGRATIONS_LIVE_ORDER) {
    const view = input.views[provider];
    if (!view) continue;

    const capability = input.capabilities?.[provider];

    // A stored connection that has expired or errored is not a new source
    // running its first import, whatever its status endpoint still reports —
    // and neither is one whose reads the app itself refuses.
    const connectedAt = view.isConnected ? (view.connectedAt ?? null) : null;
    const signals = !view.isConnected || (capability && !capability.canRead)
      ? null
      : provider === "meta"
        ? metaFirstSyncSignals(input.metaStatus, connectedAt)
        : provider === "google"
          ? googleFirstSyncSignals(input.googleStatus, connectedAt)
          : provider === "shopify"
            ? shopifyFirstSyncSignals(input.shopifyStatus, connectedAt)
            : provider === "ga4"
              ? ga4FirstSyncSignals(input.ga4Status, connectedAt)
              : provider === "search_console"
                ? searchConsoleFirstSyncSignals(
                    input.searchConsoleStatus,
                    connectedAt,
                  )
                : null;
    const firstSync = buildFirstSyncModel(signals, now);
    const syncing = firstSync !== null;
    const { status, tone } = resolveStatus(provider, view, syncing, capability);
    const connectable = input.connectableProviders.includes(provider);

    const meta = syncing
      ? INTEGRATIONS_META_SYNCING
      : view.isConnected
        ? buildConnectedMetaLine(view, now)
        : INTEGRATIONS_META_NOT_CONNECTED;

    // design 4345-4346: no button while syncing; otherwise exactly one, whose
    // caption is Manage when connected and Connect when not. A provider with no
    // authorization route gets no button rather than one that would 501.
    const button = syncing
      ? null
      : view.isConnected
        ? { caption: "Manage", kind: "manage" as const }
        : connectable
          ? { caption: "Connect", kind: "connect" as const }
          : null;

    cards.push({
      provider,
      name: INTEGRATIONS_PROVIDER_NAMES[provider],
      logoSrc: input.logoFor(provider),
      description: INTEGRATIONS_PROVIDER_DESCRIPTIONS[provider],
      status,
      statusTone: tone,
      syncing,
      firstSync,
      meta,
      button,
    });
  }

  const soonCards: IntegrationsSoonCardModel[] = INTEGRATIONS_SOON_ORDER.map(
    (provider) => ({
      provider,
      name: INTEGRATIONS_PROVIDER_NAMES[provider],
      logoSrc: input.logoFor(provider),
      // No roadmap source serves a date for these, and inventing a quarter
      // would read as a commitment the product has not made.
      eta: DASH,
    }),
  );

  return { cards, soonCards };
}
