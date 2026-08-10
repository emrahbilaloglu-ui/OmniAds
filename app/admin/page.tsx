"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import {
  Users, Building2, CreditCard, ShieldAlert,
  UserPlus, Activity, AlertTriangle, KeyRound, RefreshCw, HardDrive, TrendingDown,
} from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";
import type { SystemCapacityStatus } from "@/lib/admin-system-capacity";

interface Stats {
  users: { total: number; last7d: number; last30d: number; suspended: number; admins: number };
  businesses: { total: number; last7d: number; demo: number };
  planBreakdown: Array<{ planId: string; count: number }>;
  recentUsers: Array<{ id: string; name: string; email: string; created_at: string; is_superadmin: boolean; suspended_at: string | null; auth_provider: string }>;
  recentActivity: Array<{ action: string; target_type: string; meta: any; created_at: string; admin_name: string }>;
  integrationHealth: Array<{
    provider: "meta" | "google";
    connectedBusinesses: number;
    affectedBusinesses: number;
    staleSnapshots: number;
    failedSnapshots: number;
    missingSnapshots: number;
    refreshInProgress: number;
    topIssue: string | null;
  }>;
  integrationHealthSummary?: {
    totalAffectedWorkspaces: number;
    topIssue: string | null;
  };
  authHealthSummary?: {
    affectedBusinesses: number;
    connectedIntegrations: number;
    expiredTokens: number;
    expiringSoon: number;
    missingRefreshTokens: number;
    missingScopes: number;
    integrationErrors: number;
    topIssue: string | null;
  };
  syncHealthSummary?: {
    impactedBusinesses: number;
    runningJobs: number;
    stuckJobs: number;
    failedJobs24h: number;
    activeCooldowns: number;
    successJobs24h: number;
    topIssue: string | null;
    googleAdsQueueDepth?: number;
    googleAdsLeasedPartitions?: number;
    googleAdsDeadLetterPartitions?: number;
    googleAdsOldestQueuedPartition?: string | null;
  };
  revenueRiskSummary?: {
    atRiskBusinesses: number;
    activeSubscriptions: number;
    nonActiveSubscriptions: number;
    unsubscribedBusinesses: number;
    topIssue: string | null;
  };
  systemCapacitySummary?: {
    status: SystemCapacityStatus;
    databaseSizeBytes: number;
    databaseSizePretty: string;
    diskUsedPercent: number | null;
    diskAvailableBytes: number | null;
    diskPath: string | null;
    diskStatus: SystemCapacityStatus;
    topRelation: string | null;
  };
}

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter", growth: "Growth", pro: "Pro", scale: "Scale",
};

const PLAN_COLORS: Record<string, string> = {
  starter: "bg-gray-100 text-gray-600",
  growth: "bg-blue-100 text-blue-700",
  pro: "bg-indigo-100 text-indigo-700",
  scale: "bg-purple-100 text-purple-700",
};

const DASHBOARD_HELP: Record<string, string> = {
  Users: "Total registered users in the platform.",
  Workspaces: "Total created workspaces across the platform.",
  "Active subscriptions": "Subscriptions currently in active billing state.",
  Admins: "Users with superadmin permissions.",
  Failed: "Confirmed integration refresh failures with no successful recovery yet.",
  Stale: "Older saved snapshots that are still being served after a failed refresh attempt.",
  Missing: "Connected integrations that still do not have a stored account snapshot.",
  Refreshing: "Background snapshot refreshes currently in progress.",
  "Failed 24h": "Background sync jobs that failed during the last 24 hours.",
  "Non-active": "Subscription records whose billing state is not active.",
  DB: "Current PostgreSQL database size reported by pg_database_size.",
  Disk: "Runtime disk usage reported by df for the configured server path.",
  Free: "Available bytes on the primary reported disk path.",
};

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 1;
  return `${nextValue.toFixed(digits)} ${units[unitIndex]}`;
}

function capacityBadgeLabel(status: SystemCapacityStatus) {
  if (status === "ok") return "Normal";
  if (status === "warning") return "Uyarı";
  if (status === "critical") return "Kritik";
  return "Bilinmiyor";
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    "user.suspend": "Kullanıcı askıya alındı",
    "user.unsuspend": "Kullanıcı aktif edildi",
    "user.delete": "Kullanıcı silindi",
    "user.reset_password": "Şifre sıfırlandı",
    "user.terminate_sessions": "Sessionlar sonlandırıldı",
    "user.set_admin": "Admin yetkisi verildi",
    "user.revoke_admin": "Admin yetkisi kaldırıldı",
    "business.delete": "Workspace silindi",
    "business.plan_override": "Plan override uygulandı",
    "business.remove_member": "Üye çıkarıldı",
    "discount.create": "İndirim kodu oluşturuldu",
    "discount.delete": "İndirim kodu silindi",
    "discount.toggle": "İndirim kodu durumu değiştirildi",
  };
  return map[action] ?? action;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/stats")
      .then(async (r) => {
        const payload = await r.json().catch(() => null);
        if (!r.ok) {
          throw new Error(
            (payload as { message?: string } | null)?.message ??
              "Admin statistics could not be loaded."
          );
        }
        return payload as Stats;
      })
      .then((payload) => {
        if (cancelled) return;
        setStats(payload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStats(null);
        setLoadError(
          error instanceof Error ? error.message : "Admin statistics could not be loaded."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-gray-200 rounded w-48" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 bg-gray-200 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="h-72 bg-gray-200 rounded-xl" />
          <div className="h-72 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Platforma genel bakış</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <p className="text-sm font-medium text-red-800">Admin istatistikleri yüklenemedi.</p>
          <p className="text-sm text-red-700 mt-1">{loadError}</p>
        </div>
      </div>
    );
  }

  const userStats = stats?.users ?? {
    total: 0,
    last7d: 0,
    last30d: 0,
    suspended: 0,
    admins: 0,
  };
  const businessStats = stats?.businesses ?? {
    total: 0,
    last7d: 0,
    demo: 0,
  };
  const planBreakdown = stats?.planBreakdown ?? [];
  const recentUsers = stats?.recentUsers ?? [];
  const recentActivity = stats?.recentActivity ?? [];
  const integrationHealth = stats?.integrationHealth ?? [];

  const totalActive = planBreakdown.reduce((s, p) => s + p.count, 0);
  const totalAffectedIntegrations =
    stats?.integrationHealthSummary?.totalAffectedWorkspaces ??
    integrationHealth.reduce((sum, row) => sum + row.affectedBusinesses, 0);
  const topIntegrationIssue = stats?.integrationHealthSummary?.topIssue ?? null;
  const authHealthSummary = stats?.authHealthSummary ?? {
    affectedBusinesses: 0,
    connectedIntegrations: 0,
    expiredTokens: 0,
    expiringSoon: 0,
    missingRefreshTokens: 0,
    missingScopes: 0,
    integrationErrors: 0,
    topIssue: null,
  };
  const syncHealthSummary = stats?.syncHealthSummary ?? {
    impactedBusinesses: 0,
    runningJobs: 0,
    stuckJobs: 0,
    failedJobs24h: 0,
    activeCooldowns: 0,
    successJobs24h: 0,
    topIssue: null,
    googleAdsQueueDepth: 0,
    googleAdsLeasedPartitions: 0,
    googleAdsDeadLetterPartitions: 0,
    googleAdsOldestQueuedPartition: null,
  };
  const revenueRiskSummary = stats?.revenueRiskSummary ?? {
    atRiskBusinesses: 0,
    activeSubscriptions: 0,
    nonActiveSubscriptions: 0,
    unsubscribedBusinesses: 0,
    topIssue: null,
  };
  const systemCapacitySummary = stats?.systemCapacitySummary ?? {
    status: "unknown" as const,
    databaseSizeBytes: 0,
    databaseSizePretty: "—",
    diskUsedPercent: null,
    diskAvailableBytes: null,
    diskPath: null,
    diskStatus: "unknown" as const,
    topRelation: null,
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Platforma genel bakış</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/admin/users" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-indigo-50 rounded-lg"><Users className="w-4 h-4 text-indigo-600" /></div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-gray-500">Kullanıcılar</p>
              <InlineHelp text={DASHBOARD_HELP.Users} />
            </div>
          </div>
          <p className="text-3xl font-bold text-gray-900">{userStats.total}</p>
          <div className="flex gap-3 mt-2">
            <p className="text-xs text-emerald-600">+{userStats.last7d} bu hafta</p>
            {userStats.suspended > 0 && (
              <p className="text-xs text-red-500">{userStats.suspended} askıda</p>
            )}
          </div>
        </Link>

        <Link href="/admin/businesses" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-emerald-50 rounded-lg"><Building2 className="w-4 h-4 text-emerald-600" /></div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-gray-500">Workspace&apos;ler</p>
              <InlineHelp text={DASHBOARD_HELP.Workspaces} />
            </div>
          </div>
          <p className="text-3xl font-bold text-gray-900">{businessStats.total}</p>
          <p className="text-xs text-emerald-600 mt-2">+{businessStats.last7d} bu hafta</p>
        </Link>

        <Link href="/admin/subscriptions" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-amber-50 rounded-lg"><CreditCard className="w-4 h-4 text-amber-600" /></div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-gray-500">Aktif Abonelik</p>
              <InlineHelp text={DASHBOARD_HELP["Active subscriptions"]} />
            </div>
          </div>
          <p className="text-3xl font-bold text-gray-900">{totalActive}</p>
          <div className="flex flex-wrap gap-1 mt-2">
            {planBreakdown.map((p) => (
              <span key={p.planId} className={`text-[12px] font-medium px-1.5 py-0.5 rounded-full ${PLAN_COLORS[p.planId] ?? "bg-gray-100 text-gray-600"}`}>
                {PLAN_LABELS[p.planId] ?? p.planId}: {p.count}
              </span>
            ))}
          </div>
        </Link>

        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-rose-50 rounded-lg"><ShieldAlert className="w-4 h-4 text-rose-600" /></div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-gray-500">Adminler</p>
              <InlineHelp text={DASHBOARD_HELP.Admins} />
            </div>
          </div>
          <p className="text-3xl font-bold text-gray-900">{userStats.admins}</p>
          <p className="text-xs text-gray-400 mt-2">Superadmin yetkili</p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Entegrasyon Sağlığı</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Sistem genelindeki Meta ve Google senkron sorunları
              </p>
            </div>
          </div>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${
            totalAffectedIntegrations > 0
              ? "bg-amber-100 text-amber-700"
              : "bg-emerald-100 text-emerald-700"
          }`}>
            {totalAffectedIntegrations > 0
              ? `${totalAffectedIntegrations} etkilenen workspace`
              : "Sorun yok"}
          </span>
        </div>

        {integrationHealth.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            Entegrasyon sağlık verisi henüz yok.
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {integrationHealth.map((provider) => (
                <div key={provider.provider} className="rounded-xl border border-gray-200 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">
                        {provider.provider === "meta" ? "Meta Ads" : "Google Ads"}
                      </h3>
                      <p className="text-xs text-gray-500 mt-1">
                        {provider.connectedBusinesses} bağlı workspace
                      </p>
                    </div>
                    <span className={`text-[11px] font-medium px-2 py-1 rounded-full ${
                      provider.affectedBusinesses > 0
                        ? "bg-amber-100 text-amber-700"
                        : "bg-emerald-100 text-emerald-700"
                    }`}>
                      {provider.affectedBusinesses > 0
                        ? `${provider.affectedBusinesses} etkilenmiş`
                        : "Healthy"}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-4 text-center">
                    <div>
                      <p className="text-lg font-semibold text-gray-900">{provider.failedSnapshots}</p>
                      <div className="mt-1 flex items-center justify-center gap-1">
                        <p className="text-[11px] text-gray-500">Failed</p>
                        <InlineHelp text={DASHBOARD_HELP.Failed} />
                      </div>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-gray-900">{provider.staleSnapshots}</p>
                      <div className="mt-1 flex items-center justify-center gap-1">
                        <p className="text-[11px] text-gray-500">Stale</p>
                        <InlineHelp text={DASHBOARD_HELP.Stale} />
                      </div>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-gray-900">{provider.missingSnapshots}</p>
                      <div className="mt-1 flex items-center justify-center gap-1">
                        <p className="text-[11px] text-gray-500">Missing</p>
                        <InlineHelp text={DASHBOARD_HELP.Missing} />
                      </div>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-gray-900">{provider.refreshInProgress}</p>
                      <div className="mt-1 flex items-center justify-center gap-1">
                        <p className="text-[11px] text-gray-500">Refreshing</p>
                        <InlineHelp text={DASHBOARD_HELP.Refreshing} />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-4">
                    Ana problem: <span className="font-medium text-gray-700">{provider.topIssue ?? "None"}</span>
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  Genel ana problem: {topIntegrationIssue ?? "Sorun yok"}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Workspace detayları issue hiyerarşisi ile ayrı ekranda yönetilir.
                </p>
              </div>
              <Link
                href="/admin/integrations"
                className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Detaylari gor
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <SummaryPanel
          href="/admin/auth-health"
          icon={<KeyRound className="w-4 h-4 text-indigo-600" />}
          title="Auth & OAuth"
          subtitle={`${authHealthSummary.connectedIntegrations} aktif bağlantı izleniyor`}
          badge={
            authHealthSummary.affectedBusinesses > 0
              ? `${authHealthSummary.affectedBusinesses} etkilenen workspace`
              : "Sorun yok"
          }
          badgeTone={authHealthSummary.affectedBusinesses > 0 ? "warning" : "healthy"}
          metrics={[
            { label: "Expired", value: authHealthSummary.expiredTokens },
            { label: "Expiring", value: authHealthSummary.expiringSoon },
            { label: "Scopes", value: authHealthSummary.missingScopes },
          ]}
          footnote={authHealthSummary.topIssue ?? "OAuth tarafında aktif problem yok"}
        />

        <SummaryPanel
          href="/admin/sync-health"
          icon={<RefreshCw className="w-4 h-4 text-sky-600" />}
          title="Sync Health"
          subtitle="Arka plan job ve cooldown takibi"
          badge={
            syncHealthSummary.impactedBusinesses > 0
              ? `${syncHealthSummary.impactedBusinesses} etkilenen workspace`
              : "Sorun yok"
          }
          badgeTone={syncHealthSummary.impactedBusinesses > 0 ? "warning" : "healthy"}
          metrics={[
            { label: "Failed 24h", value: syncHealthSummary.failedJobs24h },
            { label: "Stuck", value: syncHealthSummary.stuckJobs },
            { label: "Cooldown", value: syncHealthSummary.activeCooldowns },
            { label: "GAds Queue", value: syncHealthSummary.googleAdsQueueDepth ?? 0 },
          ]}
          footnote={syncHealthSummary.topIssue ?? "Sync tarafında aktif problem yok"}
        />

        <SummaryPanel
          href="/admin/revenue-risk"
          icon={<TrendingDown className="w-4 h-4 text-rose-600" />}
          title="Revenue Risk"
          subtitle={`${revenueRiskSummary.activeSubscriptions} aktif abonelik`}
          badge={
            revenueRiskSummary.atRiskBusinesses > 0
              ? `${revenueRiskSummary.atRiskBusinesses} riskli workspace`
              : "Sorun yok"
          }
          badgeTone="neutral"
          metrics={[
            { label: "Non-active", value: revenueRiskSummary.nonActiveSubscriptions },
            { label: "No sub", value: revenueRiskSummary.unsubscribedBusinesses },
            { label: "At risk", value: revenueRiskSummary.atRiskBusinesses },
          ]}
          footnote={revenueRiskSummary.topIssue ?? "Gelir tarafında aktif risk yok"}
        />

        <SummaryPanel
          href="/admin/system-capacity"
          icon={<HardDrive className="w-4 h-4 text-slate-700" />}
          title="System Capacity"
          subtitle={systemCapacitySummary.diskPath ? `Disk path: ${systemCapacitySummary.diskPath}` : "Disk kaynağı bekleniyor"}
          badge={capacityBadgeLabel(systemCapacitySummary.status)}
          badgeTone={
            systemCapacitySummary.status === "ok"
              ? "healthy"
              : systemCapacitySummary.status === "unknown"
                ? "neutral"
                : "warning"
          }
          metrics={[
            { label: "DB", value: systemCapacitySummary.databaseSizePretty },
            {
              label: "Disk",
              value:
                systemCapacitySummary.diskUsedPercent == null
                  ? "—"
                  : `${systemCapacitySummary.diskUsedPercent}%`,
            },
            { label: "Free", value: formatBytes(systemCapacitySummary.diskAvailableBytes) },
          ]}
          footnote={systemCapacitySummary.topRelation ?? "DB relation detayı ayrı ekranda"}
        />
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent users */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Son Kayıt Olan Kullanıcılar</h2>
            </div>
            <Link href="/admin/users" className="text-xs text-indigo-600 hover:underline">Tümü →</Link>
          </div>
          <div className="divide-y divide-gray-50">
            {recentUsers.map((u) => (
              <Link key={u.id} href={`/admin/users/${u.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors">
                <div>
                  <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                    {u.name}
                    {u.is_superadmin && <span className="text-[12px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">Admin</span>}
                    {u.suspended_at && <span className="text-[12px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-semibold">Askıda</span>}
                  </p>
                  <p className="text-xs text-gray-400">{u.email}</p>
                </div>
                <p className="text-xs text-gray-400 shrink-0">{new Date(u.created_at).toLocaleDateString("tr-TR")}</p>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Son Admin Aksiyonları</h2>
            </div>
            <Link href="/admin/activity" className="text-xs text-indigo-600 hover:underline">Tümü →</Link>
          </div>
          {recentActivity.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-gray-400">Henüz aksiyon kaydı yok.</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentActivity.map((a, i) => (
                <div key={i} className="flex items-start justify-between px-5 py-3">
                  <div>
                    <p className="text-sm text-gray-900">{actionLabel(a.action)}</p>
                    <p className="text-xs text-gray-400">{a.admin_name}</p>
                  </div>
                  <p className="text-xs text-gray-400 shrink-0">{new Date(a.created_at).toLocaleDateString("tr-TR")}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryPanel({
  href,
  icon,
  title,
  subtitle,
  badge,
  badgeTone,
  metrics,
  footnote,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  badge: string;
  badgeTone: "healthy" | "warning" | "neutral";
  metrics: Array<{ label: string; value: number | string }>;
  footnote: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-gray-50">{icon}</div>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          </div>
        </div>
        <span
          className={`text-[11px] font-medium px-2 py-1 rounded-full ${
            badgeTone === "warning"
              ? "bg-amber-100 text-amber-700"
              : badgeTone === "healthy"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          {badge}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-4 text-center">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <p className="text-lg font-semibold text-gray-900">{metric.value}</p>
            <div className="mt-1 flex items-center justify-center gap-1">
              <p className="text-[11px] text-gray-500">{metric.label}</p>
              {DASHBOARD_HELP[metric.label] ? <InlineHelp text={DASHBOARD_HELP[metric.label]} /> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">{footnote}</p>
        <Link
          href={href}
          className="shrink-0 inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Detayi gor
        </Link>
      </div>
    </div>
  );
}
