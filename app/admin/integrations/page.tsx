"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";

interface IntegrationProviderDetail {
  provider: "meta" | "google";
  issueType: string;
  lastError: string | null;
  displayDetail: string;
  fetchedAt: string | null;
  nextRefreshAfter: string | null;
  refreshInProgress: boolean;
}

interface IntegrationWorkspaceNode {
  businessId: string;
  businessName: string;
  providerCount: number;
  providers: Array<"meta" | "google">;
  worstStatus: string;
  latestFetchedAt: string | null;
  nextRefreshAfter: string | null;
  providerDetails: IntegrationProviderDetail[];
}

interface IntegrationProviderNode {
  provider: "meta" | "google";
  affectedWorkspaces: number;
  connectedBusinesses: number;
  failedSnapshots: number;
  staleSnapshots: number;
  missingSnapshots: number;
  refreshInProgress: number;
  workspaces: IntegrationWorkspaceNode[];
}

interface IntegrationIssueGroup {
  issueType: string;
  affectedWorkspaces: number;
  criticality: "healthy" | "warning" | "critical";
  oldestFetchedAt: string | null;
  latestRetryAfter: string | null;
  providers: IntegrationProviderNode[];
}

interface IntegrationHealthPayload {
  issueGroups: IntegrationIssueGroup[];
  summary: {
    totalAffectedWorkspaces: number;
    topIssue: string | null;
    providers: Array<{
      provider: "meta" | "google";
      connectedBusinesses: number;
      affectedBusinesses: number;
      staleSnapshots: number;
      failedSnapshots: number;
      missingSnapshots: number;
      refreshInProgress: number;
      topIssue: string | null;
    }>;
  };
}

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("tr-TR");
}

function providerLabel(provider: "meta" | "google") {
  return provider === "meta" ? "Meta Ads" : "Google Ads";
}

function criticalityStyles(level: "healthy" | "warning" | "critical") {
  if (level === "critical") return "bg-red-100 text-red-700 border-red-200";
  if (level === "warning") return "bg-amber-100 text-amber-700 border-amber-200";
  return "bg-emerald-100 text-emerald-700 border-emerald-200";
}

const INTEGRATION_HELP: Record<string, string> = {
  Failed: "Confirmed refresh failures where the last refresh attempt did not complete successfully.",
  Stale: "Saved snapshots still being served after a failed refresh attempt.",
  Missing: "Connected integrations with no saved account snapshot yet.",
  Refreshing: "Background snapshot refreshes currently in progress.",
};

export default function AdminIntegrationsPage() {
  const [payload, setPayload] = useState<IntegrationHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [issueFilter, setIssueFilter] = useState("all");
  const [multiProviderOnly, setMultiProviderOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/integrations/health")
      .then(async (response) => {
        const nextPayload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            (nextPayload as { message?: string } | null)?.message ??
              "Integration health could not be loaded."
          );
        }
        return nextPayload as IntegrationHealthPayload;
      })
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPayload(null);
        setLoadError(
          error instanceof Error ? error.message : "Integration health could not be loaded."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const issueOptions = useMemo(
    () => Array.from(new Set((payload?.issueGroups ?? []).map((group) => group.issueType))),
    [payload]
  );

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();

    return (payload?.issueGroups ?? [])
      .filter((group) => issueFilter === "all" || group.issueType === issueFilter)
      .map((group) => ({
        ...group,
        providers: group.providers
          .map((provider) => ({
            ...provider,
            workspaces: provider.workspaces.filter((workspace) => {
              if (multiProviderOnly && workspace.providerCount < 2) return false;
              if (!query) return true;
              return (
                workspace.businessName.toLowerCase().includes(query) ||
                workspace.worstStatus.toLowerCase().includes(query) ||
                workspace.providerDetails.some((detail) =>
                  (detail.lastError ?? "").toLowerCase().includes(query)
                )
              );
            }),
          }))
          .filter((provider) => provider.workspaces.length > 0),
      }))
      .filter((group) => group.providers.length > 0);
  }, [issueFilter, multiProviderOnly, payload, search]);

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-gray-200 rounded w-64" />
        <div className="h-24 bg-gray-200 rounded-xl" />
        <div className="space-y-4">
          <div className="h-40 bg-gray-200 rounded-xl" />
          <div className="h-40 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Entegrasyon Sağlığı</h1>
          <p className="text-sm text-gray-500 mt-1">Meta ve Google için detaylı operasyon görünümü</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <p className="text-sm font-medium text-red-800">Entegrasyon detayları yüklenemedi.</p>
          <p className="text-sm text-red-700 mt-1">{loadError}</p>
        </div>
      </div>
    );
  }

  const summary = payload?.summary ?? {
    totalAffectedWorkspaces: 0,
    topIssue: null,
    providers: [],
  };

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Entegrasyon Sağlığı</h1>
          <p className="text-sm text-gray-500 mt-1">
            Sorunları issue hiyerarşisine göre incele, sonra provider ve workspace bazında aç
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          Dashboard'a dön
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <div>
              <p className="text-sm font-semibold text-gray-900">Sistem Özeti</p>
              <p className="text-xs text-gray-500">
                {summary.topIssue ? `En yaygin problem: ${summary.topIssue}` : "Aktif sistem problemi yok"}
              </p>
            </div>
          </div>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${
            summary.totalAffectedWorkspaces > 0
              ? "bg-amber-100 text-amber-700"
              : "bg-emerald-100 text-emerald-700"
          }`}>
            {summary.totalAffectedWorkspaces > 0
              ? `${summary.totalAffectedWorkspaces} etkilenen workspace`
              : "Sorun yok"}
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Workspace veya hata ara"
              className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-gray-400" />
            <select
              value={issueFilter}
              onChange={(event) => setIssueFilter(event.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            >
              <option value="all">Tum issue'lar</option>
              {issueOptions.map((issue) => (
                <option key={issue} value={issue}>
                  {issue}
                </option>
              ))}
            </select>
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={multiProviderOnly}
              onChange={(event) => setMultiProviderOnly(event.target.checked)}
            />
            Sadece çoklu-provider workspace'ler
          </label>
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-center text-sm text-gray-400">
          Seçili filtrelerle eslesen issue bulunamadi.
        </div>
      ) : (
        <div className="space-y-4">
          {filteredGroups.map((group) => (
            <details key={group.issueType} open className="rounded-xl border border-gray-200 bg-white">
              <summary className="list-none cursor-pointer px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                      <div className="flex items-center gap-1.5">
                        <h2 className="text-base font-semibold text-gray-900">{group.issueType}</h2>
                        <InlineHelp text={`Grouped by confirmed issue type: ${group.issueType}.`} />
                      </div>
                      <span className={`border text-xs font-medium px-2 py-1 rounded-full ${criticalityStyles(group.criticality)}`}>
                        {group.criticality === "critical"
                          ? "Critical"
                          : group.criticality === "warning"
                            ? "Warning"
                            : "Healthy"}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-2">
                      {group.affectedWorkspaces} etkilenen workspace
                      {" • "}
                      {group.providers.map((provider) => `${providerLabel(provider.provider)} (${provider.affectedWorkspaces})`).join(", ")}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      En eski account snapshot: {formatDateTime(group.oldestFetchedAt)}
                      {" • "}
                      Son retry: {formatDateTime(group.latestRetryAfter)}
                    </p>
                  </div>
                </div>
              </summary>

              <div className="px-5 pb-5 space-y-3">
                {group.providers.map((provider) => (
                  <details key={`${group.issueType}:${provider.provider}`} className="rounded-xl border border-gray-200">
                    <summary className="list-none cursor-pointer px-4 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <ChevronDown className="w-4 h-4 text-gray-400" />
                            <div className="flex items-center gap-1.5">
                              <h3 className="text-sm font-semibold text-gray-900">
                                {providerLabel(provider.provider)}
                              </h3>
                              <InlineHelp text="Provider-level aggregation of confirmed snapshot issues." />
                            </div>
                          </div>
                          <p className="text-xs text-gray-500 mt-2">
                            {provider.affectedWorkspaces} affected / {provider.connectedBusinesses} connected
                          </p>
                        </div>
                        <div className="grid grid-cols-4 gap-3 text-center">
                          <Metric value={provider.failedSnapshots} label="Failed" />
                          <Metric value={provider.staleSnapshots} label="Stale" />
                          <Metric value={provider.missingSnapshots} label="Missing" />
                          <Metric value={provider.refreshInProgress} label="Refreshing" />
                        </div>
                      </div>
                    </summary>

                    <div className="divide-y divide-gray-100 border-t border-gray-100">
                      {provider.workspaces.map((workspace) => (
                        <details key={`${group.issueType}:${provider.provider}:${workspace.businessId}`} className="px-4 py-0">
                          <summary className="list-none cursor-pointer py-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="flex items-center gap-2">
                                  <ChevronDown className="w-4 h-4 text-gray-400" />
                                  <p className="text-sm font-medium text-gray-900">{workspace.businessName}</p>
                                  <span className="text-[12px] font-medium rounded-full bg-gray-100 text-gray-700 px-2 py-0.5">
                                    {workspace.providerCount} provider
                                  </span>
                                  <span className={`text-[12px] font-medium rounded-full px-2 py-0.5 ${criticalityStyles(criticalityForIssue(workspace.worstStatus))}`}>
                                    {workspace.worstStatus}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-500 mt-2">
                                  Providers: {workspace.providers.map(providerLabel).join(", ")}
                                </p>
                              </div>
                              <div className="text-right text-xs text-gray-400">
                                <p>Account list snapshot: {formatDateTime(workspace.latestFetchedAt)}</p>
                                <p className="mt-1">Retry after: {formatDateTime(workspace.nextRefreshAfter)}</p>
                              </div>
                            </div>
                          </summary>

                          <div className="pb-4 space-y-3">
                            {workspace.providerDetails.map((detail) => (
                              <div
                                key={`${workspace.businessId}:${detail.provider}:${detail.issueType}`}
                                className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3"
                              >
                                <div className="flex items-start justify-between gap-4">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium text-gray-900">
                                        {providerLabel(detail.provider)}
                                      </p>
                                      <span className={`text-[12px] font-medium rounded-full px-2 py-0.5 ${criticalityStyles(criticalityForIssue(detail.issueType))}`}>
                                        {detail.issueType}
                                      </span>
                                    </div>
                                    <p className="text-sm text-gray-500 mt-2 break-words">
                                      {detail.displayDetail}
                                    </p>
                                  </div>
                                  {detail.refreshInProgress ? (
                                    <span className="text-[12px] font-medium rounded-full bg-blue-100 text-blue-700 px-2 py-1">
                                      Refreshing
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-400">
                                  <span>Account list snapshot: {formatDateTime(detail.fetchedAt)}</span>
                                  <span>Retry after: {formatDateTime(detail.nextRefreshAfter)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-[52px]">
      <p className="text-sm font-semibold text-gray-900">{value}</p>
      <div className="mt-1 flex items-center justify-center gap-1">
        <p className="text-[12px] text-gray-500">{label}</p>
        {INTEGRATION_HELP[label] ? <InlineHelp text={INTEGRATION_HELP[label]} /> : null}
      </div>
    </div>
  );
}

function criticalityForIssue(issueType: string): "healthy" | "warning" | "critical" {
  if (
    issueType === "Quota / rate limit" ||
    issueType === "Missing scope" ||
    issueType === "Permissions" ||
    issueType === "Token / refresh" ||
    issueType === "Provider/API error"
  ) {
    return "critical";
  }
  if (issueType === "Stale snapshot" || issueType === "Missing snapshot") {
    return "warning";
  }
  return "healthy";
}
