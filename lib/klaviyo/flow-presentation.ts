import { formatMoneyIso, MISSING_VALUE } from "@/lib/metric-format";
import type { KlaviyoFlowMetricRow } from "@/lib/klaviyo/warehouse";

/**
 * Warehouse row → the five strings the design's table renders.
 *
 * Pure, and the only place a Klaviyo number becomes text. The route serves the
 * result so `KlaviyoFlowSource` in `components/klaviyo/klaviyo-exact-adapter.ts`
 * keeps the shape it already declares.
 *
 * The rule throughout: a null stays null and the adapter renders the em-dash.
 * Nothing is coerced to zero, and money with no currency code renders as
 * missing rather than claiming dollars — `formatMoneyIso` is the repo's
 * existing decision on that and this reuses it rather than restating it.
 */

export interface KlaviyoFlowPresentation {
  id: string;
  name: string | null;
  status: string | null;
  revenue: string | null;
  openRate: string | null;
  recipients: string | null;
}

/**
 * Klaviyo's status verbs are lowercase ("live", "draft", "manual"); the design
 * shows them capitalised ("Live", "Draft"). This is a case change on the
 * provider's own word, not a relabelling — an unrecognised status is passed
 * through capitalised rather than mapped onto one of the design's two.
 */
function presentStatus(status: string | null): string | null {
  if (!status) return null;
  const trimmed = status.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function presentOpenRate(openRate: number | null): string | null {
  if (openRate == null || !Number.isFinite(openRate)) return null;
  // Klaviyo reports a fraction in [0,1]; the design shows a whole percent.
  return `${Math.round(openRate * 100)}%`;
}

function presentRecipients(recipients: number | null): string | null {
  if (recipients == null || !Number.isFinite(recipients)) return null;
  return Math.round(recipients).toLocaleString("en-US");
}

function presentRevenue(
  revenue: number | null,
  currency: string | null,
): string | null {
  if (revenue == null || !Number.isFinite(revenue)) return null;
  const formatted = formatMoneyIso(revenue, {
    currency,
    locale: "en-US",
  });
  // `formatMoneyIso` returns the em-dash itself when the currency is unknown.
  // Collapsing that back to null keeps ONE place responsible for drawing the
  // em-dash — the adapter — instead of two spellings of the same absence.
  return formatted === MISSING_VALUE ? null : formatted;
}

export function presentKlaviyoFlow(
  row: KlaviyoFlowMetricRow,
): KlaviyoFlowPresentation {
  return {
    id: row.flowId,
    name: row.flowName,
    status: presentStatus(row.flowStatus),
    revenue: presentRevenue(row.revenue, row.currency),
    openRate: presentOpenRate(row.openRate),
    recipients: presentRecipients(row.recipients),
  };
}
