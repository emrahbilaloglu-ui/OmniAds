import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
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

/**
 * design 4315-4321 `integBase` — order, name and description are fixed UI copy.
 * The grid opens with Shopify and closes with Klaviyo, in this order.
 */
export const INTEGRATIONS_LIVE_ORDER: IntegrationProvider[] = [
  "shopify",
  "meta",
  "google",
  "ga4",
  "search_console",
  "klaviyo",
];

/** design 4349-4353 `soonIntegrations` — order and names. */
export const INTEGRATIONS_SOON_ORDER: IntegrationProvider[] = [
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

/** design 4315-4321 `desc` — verbatim, this is fixed copy and not provider data. */
export const INTEGRATIONS_PROVIDER_DESCRIPTIONS: Record<
  IntegrationProvider,
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
  tiktok: "Campaign performance from TikTok Ads.",
  pinterest: "Campaign performance from Pinterest Ads.",
  snapchat: "Campaign performance from Snapchat Ads.",
};

/** design 4342 — the two fixed meta strings for the non-connected states. */
export const INTEGRATIONS_META_NOT_CONNECTED = "no data pulled yet";
export const INTEGRATIONS_META_SYNCING =
  "first import running — nothing shows in the app until the snapshot lands";

/**
 * Klaviyo has no authorization route: `app/api/oauth/klaviyo/start` answers 501
 * on purpose rather than fabricating a connection. The design's own `showBtn`
 * conditional carries that — no button, and the meta line says why.
 */
export const INTEGRATIONS_META_NO_AUTH_FLOW =
  "no authorization flow available yet";

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
 * Every field is read from a served status response — nothing here advances on
 * a clock. A provider that serves no status at all yields `null` signals and
 * therefore no progress block, because we cannot honestly claim an import is
 * running.
 */
export interface FirstSyncSignals {
  /** The OAuth handshake landed. */
  connected: boolean;
  /** Accounts/properties are discovered and assigned. */
  entitiesReady: boolean;
  /** 0..1 of the historical window that has landed, or null when unknown. */
  backfillFraction: number | null;
  /** The provider's readiness verdict says the snapshot is servable. */
  snapshotReady: boolean;
}

/**
 * Map a provider's real signals onto the design's percent scale.
 *
 * Returns null when there is nothing to show: either the provider is not
 * connected, or its first import has already landed. The design states the rule
 * outright at line 2819 — "Sync progress appears once: while a new source runs
 * its first import."
 *
 * The percent never runs ahead of evidence. Each stage boundary is only crossed
 * when the fact behind it is true, so an unknown backfill parks the bar at the
 * start of its own stage instead of drifting upward.
 */
export function resolveFirstSyncPercent(
  signals: FirstSyncSignals | null,
): number | null {
  if (!signals) return null;
  if (!signals.connected) return null;
  if (signals.snapshotReady) return null;

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
): IntegrationsFirstSyncModel | null {
  const percent = resolveFirstSyncPercent(signals);
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
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    entitiesReady: (status.assignedAccountIds?.length ?? 0) > 0,
    backfillFraction:
      fractionFromDays(
        status.priorityWindow?.completedDays,
        status.priorityWindow?.totalDays,
      ) ?? fractionFromPercent(status.currentCoreProgressPercent),
    snapshotReady:
      status.state === "ready" || status.coreReadiness?.complete === true,
  };
}

export function googleFirstSyncSignals(
  status: GoogleAdsStatusResponse | null | undefined,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  return {
    connected: true,
    entitiesReady:
      (status.assignedAccountIds?.length ?? 0) > 0 &&
      status.state !== "connected_no_assignment",
    backfillFraction:
      fractionFromPercent(status.historicalProgress?.percent) ??
      fractionFromPercent(status.backgroundBackfill?.percent),
    snapshotReady: status.state === "ready",
  };
}

export function shopifyFirstSyncSignals(
  status: ShopifyStatusResponse | null | undefined,
): FirstSyncSignals | null {
  if (!status || !status.connected) return null;
  const ordersHistorical = status.sync?.ordersHistorical ?? null;
  const readyThrough = ordersHistorical?.readyThroughDate ?? null;
  const target = ordersHistorical?.historicalTargetEnd ?? null;
  return {
    connected: true,
    entitiesReady: Boolean(status.shopId),
    // Shopify reports a ready-through date, not a day count: it can prove the
    // backfill finished but cannot say how far along an unfinished one is.
    backfillFraction: readyThrough && target ? (readyThrough >= target ? 1 : null) : null,
    snapshotReady: status.state === "ready",
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

function resolveStatus(
  provider: IntegrationProvider,
  view: ProviderViewState,
  syncing: boolean,
): { status: string; tone: IntegrationsStatusTone } {
  // design 4341: while the first import runs the pill always reads "Connecting".
  if (syncing) return { status: "Connecting", tone: "connecting" };
  switch (view.status) {
    case "ready":
      return {
        status: provider === "klaviyo" ? "Connected · Beta" : "Connected",
        tone: "connected",
      };
    case "degraded":
      return { status: "Degraded", tone: "attention" };
    case "loading_data":
      return { status: "Connecting", tone: "connecting" };
    case "needs_assignment":
      return { status: "Needs setup", tone: "connecting" };
    case "action_required":
      return { status: "Action required", tone: "attention" };
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

    const signals =
      provider === "meta"
        ? metaFirstSyncSignals(input.metaStatus)
        : provider === "google"
          ? googleFirstSyncSignals(input.googleStatus)
          : provider === "shopify"
            ? shopifyFirstSyncSignals(input.shopifyStatus)
            : null;
    const firstSync = buildFirstSyncModel(signals);
    const syncing = firstSync !== null;
    const { status, tone } = resolveStatus(provider, view, syncing);
    const connectable = input.connectableProviders.includes(provider);

    const meta = syncing
      ? INTEGRATIONS_META_SYNCING
      : view.isConnected
        ? buildConnectedMetaLine(view, now)
        : connectable
          ? INTEGRATIONS_META_NOT_CONNECTED
          : INTEGRATIONS_META_NO_AUTH_FLOW;

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
