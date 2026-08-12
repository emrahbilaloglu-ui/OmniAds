"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Filter, CreditCard } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";

interface SubscriptionRow {
  id: string;
  plan_id: string;
  status: string;
  billing_cycle: string;
  created_at: string;
  updated_at: string;
  shop_id: string;
  business_id: string | null;
  business_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

interface PlanSummaryRow {
  plan_id: string;
  status: string;
  count: number;
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
const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-600",
  cancelled: "bg-red-50 text-red-500",
  pending: "bg-amber-50 text-amber-600",
  declined: "bg-red-50 text-red-500",
  expired: "bg-gray-100 text-gray-400",
};

const SUBSCRIPTION_HELP: Record<string, string> = {
  "Toplam Aktif": "Subscriptions currently in active billing state.",
  Workspace: "Workspace linked to the subscription record.",
  Owner: "Workspace owner linked to the subscription.",
  Plan: "Current subscription plan.",
  Durum: "Billing status coming from the subscription record.",
  "Döngü": "Billing cycle such as monthly or annual.",
  Başlangıç: "Subscription creation date.",
};

export default function AdminSubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [planSummary, setPlanSummary] = useState<PlanSummaryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(true);

  useEffect(() => { setPage(1); }, [plan, status]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (plan) params.set("plan", plan);
    if (status) params.set("status", status);
    fetch(`/api/admin/subscriptions?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setSubscriptions(d.subscriptions ?? []);
        setTotal(d.total ?? 0);
        setPlanSummary(d.planSummary ?? []);
      })
      .finally(() => setLoading(false));
  }, [page, plan, status]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / 30);

  // Summary totals
  const activeByPlan = planSummary.filter((r) => r.status === "active");
  const totalActive = activeByPlan.reduce((s, r) => s + Number(r.count), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Abonelikler</h1>
        <p className="text-sm text-gray-500 mt-1">Shopify üzerinden yönetilen abonelikler</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-4 col-span-2 lg:col-span-1">
          <div className="mb-1 flex items-center gap-1.5">
            <p className="text-xs text-gray-400">Toplam Aktif</p>
            <InlineHelp text={SUBSCRIPTION_HELP["Toplam Aktif"]} />
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalActive}</p>
        </div>
        {["starter", "growth", "pro", "scale"].map((p) => {
          const row = activeByPlan.find((r) => r.plan_id === p);
          return (
            <div key={p} className="bg-white border border-gray-200 rounded-xl p-4">
              <p className={`text-xs font-semibold mb-1 ${PLAN_COLORS[p].split(" ")[1]}`}>{PLAN_LABELS[p]}</p>
              <p className="text-2xl font-bold text-gray-900">{row ? Number(row.count) : 0}</p>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-gray-400" />
        <select value={plan} onChange={(e) => setPlan(e.target.value)}
          className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300">
          <option value="">Tüm Planlar</option>
          <option value="starter">Starter</option>
          <option value="growth">Growth</option>
          <option value="pro">Pro</option>
          <option value="scale">Scale</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300">
          <option value="">Tüm Durumlar</option>
          <option value="active">Aktif</option>
          <option value="cancelled">İptal</option>
          <option value="pending">Beklemede</option>
          <option value="declined">Reddedildi</option>
          <option value="expired">Süresi Dolmuş</option>
        </select>
        {(plan || status !== "active") && (
          <button onClick={() => { setPlan(""); setStatus("active"); }} className="text-xs text-gray-400 hover:text-gray-600 underline">Sıfırla</button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Workspace" help={SUBSCRIPTION_HELP.Workspace} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Owner" help={SUBSCRIPTION_HELP.Owner} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Plan" help={SUBSCRIPTION_HELP.Plan} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Durum" help={SUBSCRIPTION_HELP.Durum} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Döngü" help={SUBSCRIPTION_HELP["Döngü"]} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Başlangıç" help={SUBSCRIPTION_HELP.Başlangıç} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-400">Yükleniyor...</td></tr>
            )}
            {!loading && subscriptions.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-400">Sonuç bulunamadı.</td></tr>
            )}
            {!loading && subscriptions.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3.5">
                  {s.business_id ? (
                    <Link href={`/admin/businesses/${s.business_id}`} className="font-medium text-gray-900 hover:text-indigo-600">
                      {s.business_name ?? "—"}
                    </Link>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  {s.owner_id ? (
                    <Link href={`/admin/users/${s.owner_id}`} className="hover:text-indigo-600">
                      <p className="text-gray-700">{s.owner_name}</p>
                      <p className="text-xs text-gray-400">{s.owner_email}</p>
                    </Link>
                  ) : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-5 py-3.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_COLORS[s.plan_id] ?? "bg-gray-100 text-gray-600"}`}>
                    {PLAN_LABELS[s.plan_id] ?? s.plan_id}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[s.status] ?? "bg-gray-100 text-gray-400"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-gray-500 capitalize">{s.billing_cycle}</td>
                <td className="px-5 py-3.5 text-gray-400 text-xs">
                  {new Date(s.created_at).toLocaleDateString("tr-TR")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">Sayfa {page} / {totalPages}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">
              <ChevronLeft className="w-4 h-4" /> Önceki
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50">
              Sonraki <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <InlineHelp text={help} />
    </span>
  );
}
