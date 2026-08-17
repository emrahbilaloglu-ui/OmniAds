import type { ProviderDomainState } from "@/store/integrations-store";

const DASH = "—";

/** design 3895 `klaviyoTabs` — four labels, the first one selected. */
export const KLAVIYO_TABS = [
  "Flows",
  "Campaigns",
  "Templates",
  "Segments",
] as const;

export type KlaviyoFlowStatusTone = "live" | "draft";

export interface KlaviyoExactRowModel {
  key: string;
  /** design 3897-3902 `f.name`. */
  name: string;
  /** design 3897-3902 `f.status`. */
  status: string;
  statusTone: KlaviyoFlowStatusTone;
  /** Revenue · 28d */
  revenue: string;
  /** Open rate */
  openRate: string;
  /** Recipients */
  recipients: string;
}

export interface KlaviyoExactModel {
  tabs: readonly string[];
  activeTabIndex: number;
  rows: KlaviyoExactRowModel[];
  /**
   * True when nothing serves lifecycle flows. The table keeps the design's row
   * geometry and renders an em-dash in every cell rather than seeding names.
   */
  unavailable: boolean;
}

/** A served flow row, once a Klaviyo reporting route exists. */
export interface KlaviyoFlowSource {
  id: string;
  name: string | null;
  status: string | null;
  /** Pre-formatted 28-day attributed revenue, or null when not supplied. */
  revenue: string | null;
  /** Pre-formatted open rate, or null when not supplied. */
  openRate: string | null;
  /** Pre-formatted recipient count, or null when not supplied. */
  recipients: string | null;
}

export interface KlaviyoExactAdapterInput {
  /** Klaviyo's connection domain from the integrations store. */
  domain: ProviderDomainState | null | undefined;
  /**
   * Rows from a Klaviyo reporting route. `null` means no route serves them —
   * which is the state today, since `app/api/oauth/klaviyo/start` answers 501
   * and no reporting endpoint exists.
   */
  flows: KlaviyoFlowSource[] | null;
}

function toTone(status: string | null): KlaviyoFlowStatusTone {
  return status && status.toLowerCase() === "live" ? "live" : "draft";
}

/**
 * Map real Klaviyo state onto the design's one lifecycle screen.
 *
 * Pure: no fetching, no store reads. When no route serves flows the model says
 * so explicitly instead of substituting the prototype's seeded flow names.
 */
export function buildKlaviyoExactModel(
  input: KlaviyoExactAdapterInput,
): KlaviyoExactModel {
  const connected = input.domain?.connection.status === "connected";
  const flows = input.flows;

  if (!flows) {
    return {
      tabs: KLAVIYO_TABS,
      activeTabIndex: 0,
      // design 1717-1725: one row, five cells, every fact an em-dash because no
      // provider supplies it. The geometry is the design's; the content is not
      // invented.
      rows: [
        {
          key: "unavailable",
          name: DASH,
          status: DASH,
          statusTone: "draft",
          revenue: DASH,
          openRate: DASH,
          recipients: DASH,
        },
      ],
      unavailable: true,
    };
  }

  return {
    tabs: KLAVIYO_TABS,
    activeTabIndex: 0,
    rows: flows.map((flow) => ({
      key: flow.id,
      name: flow.name?.trim() || DASH,
      status: flow.status?.trim() || DASH,
      statusTone: toTone(flow.status),
      revenue: flow.revenue?.trim() || DASH,
      openRate: flow.openRate?.trim() || DASH,
      recipients: flow.recipients?.trim() || DASH,
    })),
    unavailable: !connected && flows.length === 0,
  };
}
