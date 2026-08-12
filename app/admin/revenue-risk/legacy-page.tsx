"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingDown } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";

interface RevenueWorkspaceRow {
  businessId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string;
  connectedIntegrations: number;
  reason: string;
}

interface RevenueSubscriptionRow {
  businessId: string | null;
  businessName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  planId: string;
  status: string;
  updatedAt: string;
}

interface RevenueRiskPayload {
  summary: {
    atRiskBusinesses: number;
    activeSubscriptions: number;
    nonActiveSubscriptions: number;
    unsubscribedBusinesses: number;
    topIssue: string | null;
  };
  unsubscribedBusinesses: RevenueWorkspaceRow[];
  subscriptionIssues: RevenueSubscriptionRow[];
  statusBreakdown: Array<{ status: string; count: number }>;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("tr-TR");
}

const REVENUE_HELP: Record<string, string> = {
  "At Risk":
    "Workspaces that may have monetization or subscription follow-up risk. This is an operational business signal, not necessarily a system failure.",
  "Active Subs": "Currently active subscriptions across the platform.",
  "Non-active":
    "Subscription records whose status is not active, such as cancelled or incomplete states.",
  "No Active Sub":
    "Older workspaces that still do not have an active subscription attached.",
};

export default function AdminRevenueRiskPage() {
  const [payload, setPayload] = useState<RevenueRiskPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/revenue-risk")
      .then(async (response) => {
        const nextPayload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            (nextPayload as { message?: string } | null)?.message ??
              "Revenue risk could not be loaded."
          );
        }
        return nextPayload as RevenueRiskPayload;
      })
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPayload(null);
        setLoadError(error instanceof Error ? error.message : "Revenue risk could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-400">Yükleniyor...</div>;
  }

  if (loadError) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">{loadError}</div>;
  }

  const summary = payload?.summary ?? {
    atRiskBusinesses: 0,
    activeSubscriptions: 0,
    nonActiveSubscriptions: 0,
    unsubscribedBusinesses: 0,
    topIssue: null,
  };
  const unsubscribedBusinesses = payload?.unsubscribedBusinesses ?? [];
  const subscriptionIssues = payload?.subscriptionIssues ?? [];
  const statusBreakdown = payload?.statusBreakdown ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-rose-50">
            <TrendingDown className="w-5 h-5 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Revenue Risk</h1>
            <p className="text-sm text-gray-500 mt-1">Abonelik riski ve monetization boşluklarını izle</p>
          </div>
        </div>
        <Link href="/admin" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
          Dashboard&apos;a dön
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="At Risk" value={summary.atRiskBusinesses} help={REVENUE_HELP["At Risk"]} />
        <MetricCard label="Active Subs" value={summary.activeSubscriptions} help={REVENUE_HELP["Active Subs"]} />
        <MetricCard label="Non-active" value={summary.nonActiveSubscriptions} help={REVENUE_HELP["Non-active"]} />
        <MetricCard label="No Active Sub" value={summary.unsubscribedBusinesses} help={REVENUE_HELP["No Active Sub"]} />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-900">Status breakdown</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {statusBreakdown.length === 0 ? (
            <span className="text-sm text-gray-400">Abonelik verisi yok.</span>
          ) : (
            statusBreakdown.map((row) => (
              <span key={row.status} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                {row.status}: {row.count}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Aktif aboneliği olmayan workspace&apos;ler</h2>
          </div>
          {unsubscribedBusinesses.length === 0 ? (
            <div className="px-5 py-10 text-sm text-gray-400">Bu segmentte riskli workspace yok.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {unsubscribedBusinesses.map((row) => (
                <div key={row.businessId} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{row.businessName}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {row.ownerName ?? "Owner unknown"} • {row.ownerEmail ?? "No email"}
                      </p>
                      <p className="text-sm text-gray-600 mt-3">{row.reason}</p>
                    </div>
                    <div className="text-right text-xs text-gray-400">
                      <p>Connected: {row.connectedIntegrations}</p>
                      <p className="mt-1">Created: {formatDateTime(row.createdAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Non-active subscription kayıtları</h2>
          </div>
          {subscriptionIssues.length === 0 ? (
            <div className="px-5 py-10 text-sm text-gray-400">Aktif olmayan abonelik kaydı yok.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {subscriptionIssues.map((row, index) => (
                <div key={`${row.businessId ?? "none"}:${row.planId}:${row.updatedAt}:${index}`} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{row.businessName ?? "Unlinked subscription"}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {row.ownerName ?? "Owner unknown"} • {row.ownerEmail ?? "No email"}
                      </p>
                      <p className="text-sm text-gray-600 mt-3">
                        {row.planId} • {row.status}
                      </p>
                    </div>
                    <div className="text-right text-xs text-gray-400">
                      <p>Updated: {formatDateTime(row.updatedAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  help,
}: {
  label: string;
  value: number;
  help?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
        {help ? <InlineHelp text={help} /> : null}
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-2">{value}</p>
    </div>
  );
}
