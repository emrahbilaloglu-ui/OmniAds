/**
 * Agency Today — the cross-client morning read model.
 *
 * A buyer running several clients starts the day wanting one question answered:
 * which client needs me first. Today that answer only exists by opening every
 * client in turn.
 *
 * Severity and ordering are decided here, on the server side of the contract,
 * so the UI renders a ranked list rather than recomputing priority from
 * metrics. Two binding rules shape the output:
 *
 * - Money is never blended across currencies. With no FX contract in this
 *   product, a portfolio total is only produced when every row already shares
 *   one currency; otherwise the total is withheld with a stated reason.
 * - A client whose exposure is unknown is promoted inside its band rather than
 *   sinking to the bottom, because "we cannot rank this" is a reason to look,
 *   not a reason to ignore it.
 */

export type ClientDataHealth =
  | "healthy"
  | "degraded"
  | "action_required"
  | "disconnected"
  | "unknown";

export type ClientSeverity = "critical" | "attention" | "steady" | "unknown";

export interface AgencyTodayClientInput {
  businessId: string;
  businessName: string;
  /** ISO 4217 code. Null when it cannot be established; never defaulted. */
  currency: string | null;
  spend: number | null;
  revenue: number | null;
  purchases?: number | null;
  dataHealth: ClientDataHealth;
  lastSyncAt?: string | null;
  freshness?: "fresh" | "stale" | "unknown";
  criticalAnomalies?: number;
  policyIncidents?: number;
  pendingDecisions?: number;
}

export interface AgencyTodayRow {
  businessId: string;
  businessName: string;
  currency: string | null;
  spend: number | null;
  revenue: number | null;
  /** Null whenever it cannot be derived honestly, never zero. */
  roas: number | null;
  dataHealth: ClientDataHealth;
  freshness: "fresh" | "stale" | "unknown";
  severity: ClientSeverity;
  /** Why this client sits where it does, in the order the server applied. */
  severityReasons: string[];
  criticalAnomalies: number;
  policyIncidents: number;
  pendingDecisions: number;
  /** Scoped destination so opening a row keeps business context. */
  href: string;
}

export interface AgencyTodayPortfolio {
  currency: string | null;
  spend: number | null;
  revenue: number | null;
  /** False whenever a single honest total cannot be produced. */
  available: boolean;
  withheldReason: "mixed_currency" | "unknown_currency" | "no_clients" | null;
}

export interface AgencyTodayReadModel {
  rows: AgencyTodayRow[];
  portfolio: AgencyTodayPortfolio;
  clientCount: number;
  needsAttentionCount: number;
}

const SEVERITY_RANK: Record<ClientSeverity, number> = {
  critical: 0,
  attention: 1,
  steady: 2,
  unknown: 3,
};

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function normalizeCurrency(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function resolveRoas(spend: number | null, revenue: number | null): number | null {
  if (spend == null || revenue == null) return null;
  if (spend <= 0) return null;
  return revenue / spend;
}

function classify(input: AgencyTodayClientInput, freshness: AgencyTodayRow["freshness"]) {
  const reasons: string[] = [];
  const anomalies = Math.max(0, input.criticalAnomalies ?? 0);
  const incidents = Math.max(0, input.policyIncidents ?? 0);
  const pending = Math.max(0, input.pendingDecisions ?? 0);

  if (input.dataHealth === "disconnected") reasons.push("Provider disconnected");
  if (input.dataHealth === "action_required") reasons.push("Provider needs attention");
  if (incidents > 0) {
    reasons.push(`${incidents} delivery or policy incident${incidents === 1 ? "" : "s"}`);
  }
  if (anomalies > 0) {
    reasons.push(`${anomalies} critical anomal${anomalies === 1 ? "y" : "ies"}`);
  }

  const critical = reasons.length > 0;
  if (critical) return { severity: "critical" as const, reasons };

  if (input.dataHealth === "degraded") reasons.push("Partial data");
  if (freshness === "stale") reasons.push("Data is stale");
  if (pending > 0) reasons.push(`${pending} decision${pending === 1 ? "" : "s"} waiting`);
  if (reasons.length > 0) return { severity: "attention" as const, reasons };

  if (input.dataHealth === "unknown" || finite(input.spend) === null) {
    return { severity: "unknown" as const, reasons: ["Not enough data to rank"] };
  }

  return { severity: "steady" as const, reasons: [] };
}

function buildRow(input: AgencyTodayClientInput): AgencyTodayRow {
  const freshness = input.freshness ?? (input.lastSyncAt ? "fresh" : "unknown");
  const spend = finite(input.spend);
  const revenue = finite(input.revenue);
  const { severity, reasons } = classify(input, freshness);

  return {
    businessId: input.businessId,
    businessName: input.businessName,
    currency: normalizeCurrency(input.currency),
    spend,
    revenue,
    roas: resolveRoas(spend, revenue),
    dataHealth: input.dataHealth,
    freshness,
    severity,
    severityReasons: reasons,
    criticalAnomalies: Math.max(0, input.criticalAnomalies ?? 0),
    policyIncidents: Math.max(0, input.policyIncidents ?? 0),
    pendingDecisions: Math.max(0, input.pendingDecisions ?? 0),
    href: `/overview?businessId=${encodeURIComponent(input.businessId)}`,
  };
}

/**
 * Order clients the way a buyer should work them.
 *
 * Severity first; then, inside a band, a client whose exposure is unknown comes
 * before ranked ones so it is investigated rather than buried; then by spend,
 * because real money at stake is the honest tie-breaker; then by name so the
 * list is stable between refreshes.
 */
function compareRows(a: AgencyTodayRow, b: AgencyTodayRow): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;

  const aUnranked = a.spend == null;
  const bUnranked = b.spend == null;
  if (aUnranked !== bUnranked) return aUnranked ? -1 : 1;

  const bySpend = (b.spend ?? 0) - (a.spend ?? 0);
  if (bySpend !== 0) return bySpend;

  return a.businessName.localeCompare(b.businessName);
}

function buildPortfolio(rows: AgencyTodayRow[]): AgencyTodayPortfolio {
  if (rows.length === 0) {
    return {
      currency: null,
      spend: null,
      revenue: null,
      available: false,
      withheldReason: "no_clients",
    };
  }

  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.has(null)) {
    return {
      currency: null,
      spend: null,
      revenue: null,
      available: false,
      withheldReason: "unknown_currency",
    };
  }
  if (currencies.size > 1) {
    return {
      currency: null,
      spend: null,
      revenue: null,
      available: false,
      withheldReason: "mixed_currency",
    };
  }

  const [currency] = [...currencies];
  return {
    currency: currency ?? null,
    spend: rows.reduce((sum, row) => sum + (row.spend ?? 0), 0),
    revenue: rows.reduce((sum, row) => sum + (row.revenue ?? 0), 0),
    available: true,
    withheldReason: null,
  };
}

export function buildAgencyTodayReadModel(
  clients: AgencyTodayClientInput[],
): AgencyTodayReadModel {
  const rows = clients.map(buildRow).sort(compareRows);
  return {
    rows,
    portfolio: buildPortfolio(rows),
    clientCount: rows.length,
    needsAttentionCount: rows.filter(
      (row) => row.severity === "critical" || row.severity === "attention",
    ).length,
  };
}
