"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Trash2, ShieldCheck, Ban, ExternalLink, Plug } from "lucide-react";

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter", growth: "Growth", pro: "Pro", scale: "Scale",
};
const PLANS = ["starter", "growth", "pro", "scale"] as const;

interface BusinessDetail {
  business: {
    id: string; name: string; created_at: string; timezone: string | null; currency: string;
    plan_override: string | null; is_demo_business: boolean;
    owner_id: string; owner_name: string; owner_email: string;
  };
  members: Array<{
    id: string; role: string; status: string; joined_at: string;
    user_id: string; user_name: string; user_email: string;
    suspended_at: string | null; is_superadmin: boolean;
  }>;
  integrations: Array<{ provider: string; status: string; created_at: string }>;
  subscription: { plan_id: string; status: string; billing_cycle: string; created_at: string } | null;
}

const INTEGRATION_LABELS: Record<string, string> = {
  meta: "Meta Ads", google_ads: "Google Ads", google_analytics: "Google Analytics",
  shopify: "Shopify", tiktok: "TikTok", pinterest: "Pinterest",
  snapchat: "Snapchat", klaviyo: "Klaviyo", google_search_console: "Search Console",
};

export default function AdminBusinessDetailPage() {
  const { businessId } = useParams<{ businessId: string }>();
  const router = useRouter();
  const [data, setData] = useState<BusinessDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [planOverride, setPlanOverride] = useState<string>("");

  useEffect(() => {
    fetch(`/api/admin/businesses/${businessId}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setPlanOverride(d.business?.plan_override ?? "");
      })
      .finally(() => setLoading(false));
  }, [businessId]);

  const showMsg = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const applyPlanOverride = async () => {
    setBusy(true);
    const res = await fetch(`/api/admin/businesses/${businessId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planOverride: planOverride || null }),
    });
    setBusy(false);
    if (res.ok) {
      setData((d) => d ? { ...d, business: { ...d.business, plan_override: planOverride || null } } : d);
      showMsg("success", planOverride ? `Plan override: ${PLAN_LABELS[planOverride] ?? planOverride} uygulandı.` : "Plan override kaldırıldı.");
    } else showMsg("error", "Hata oluştu.");
  };

  const removeMember = async (userId: string, userName: string) => {
    if (!confirm(`"${userName}" kullanıcısını bu workspace'den çıkarmak istiyor musunuz?`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/businesses/${businessId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeMemberId: userId }),
    });
    setBusy(false);
    if (res.ok) {
      setData((d) => d ? { ...d, members: d.members.filter((m) => m.user_id !== userId) } : d);
      showMsg("success", `${userName} çıkarıldı.`);
    } else showMsg("error", "Hata oluştu.");
  };

  const deleteBusiness = async () => {
    if (!confirm(`"${data?.business.name}" workspace'ini kalıcı olarak silmek istiyor musunuz? Bu işlem geri alınamaz.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/businesses/${businessId}`, { method: "DELETE" });
    if (res.ok) { router.push("/admin/businesses"); return; }
    const body = await res.json().catch(() => null);
    showMsg("error", body?.message ?? "Silme başarısız.");
    setBusy(false);
  };

  if (loading) return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-64" /><div className="h-48 bg-gray-200 rounded-xl" /></div>;
  if (!data) return <div className="text-sm text-gray-500">Workspace bulunamadı.</div>;

  const { business, members, integrations, subscription } = data;
  const effectivePlan = business.plan_override || subscription?.plan_id || "starter";

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/admin/businesses" className="mt-1 text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Owner: <Link href={`/admin/users/${business.owner_id}`} className="text-indigo-500 hover:underline">{business.owner_name}</Link>
            {" · "}{business.owner_email}
          </p>
        </div>
        <button onClick={deleteBusiness} disabled={busy}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50">
          <Trash2 className="w-4 h-4" /> Sil
        </button>
      </div>

      {message && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium ${message.type === "success" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {message.text}
        </div>
      )}

      {/* Info + Plan Override */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Info */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Workspace Bilgileri</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-400">ID</dt><dd className="font-mono text-xs text-gray-600">{business.id.slice(0, 18)}…</dd></div>
            <div className="flex justify-between"><dt className="text-gray-400">Oluşturulma</dt><dd className="text-gray-700">{new Date(business.created_at).toLocaleString("tr-TR")}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-400">Timezone</dt><dd className="text-gray-700">{business.timezone ?? "Unset"}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-400">Para Birimi</dt><dd className="text-gray-700">{business.currency}</dd></div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Aktif Plan</dt>
              <dd className="font-semibold text-gray-900">
                {PLAN_LABELS[effectivePlan] ?? effectivePlan}
                {business.plan_override && <span className="ml-1.5 text-[12px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Override</span>}
              </dd>
            </div>
            {subscription && (
              <div className="flex justify-between"><dt className="text-gray-400">Shopify Abonelik</dt><dd className="capitalize text-gray-700">{subscription.status}</dd></div>
            )}
          </dl>
        </div>

        {/* Plan Override */}
        <div className="bg-white border border-amber-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Plan Override</h2>
          <p className="text-xs text-gray-400 mb-4">Shopify billing'den bağımsız olarak bu workspace'e manuel plan atayın. Boş bırakırsanız Shopify aboneliği geçerli olur.</p>
          <div className="flex gap-2">
            <select
              value={planOverride}
              onChange={(e) => setPlanOverride(e.target.value)}
              className="flex-1 py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300"
            >
              <option value="">— Override yok (Shopify planı kullan)</option>
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
            <button
              onClick={applyPlanOverride}
              disabled={busy || planOverride === (business.plan_override ?? "")}
              className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              Uygula
            </button>
          </div>
        </div>
      </div>

      {/* Members */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Üyeler ({members.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-50 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
              <th className="text-left px-5 py-2.5 font-semibold">Kullanıcı</th>
              <th className="text-left px-5 py-2.5 font-semibold">Rol</th>
              <th className="text-left px-5 py-2.5 font-semibold">Durum</th>
              <th className="text-left px-5 py-2.5 font-semibold">Katılım</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {members.map((m) => (
              <tr key={m.id} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <Link href={`/admin/users/${m.user_id}`} className="group flex items-center gap-1.5">
                    <span className="font-medium text-gray-900 group-hover:text-indigo-600">{m.user_name}</span>
                    {m.is_superadmin && <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />}
                    {m.suspended_at && <Ban className="w-3.5 h-3.5 text-red-400" />}
                  </Link>
                  <p className="text-xs text-gray-400">{m.user_email}</p>
                </td>
                <td className="px-5 py-3 capitalize text-gray-500">{m.role}</td>
                <td className="px-5 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                    {m.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-gray-400">{new Date(m.joined_at).toLocaleDateString("tr-TR")}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link href={`/admin/users/${m.user_id}`} className="text-indigo-400 hover:text-indigo-600">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                    <button
                      onClick={() => removeMember(m.user_id, m.user_name)}
                      disabled={busy}
                      className="text-xs text-red-400 hover:text-red-600 disabled:opacity-40"
                    >
                      Çıkar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Integrations */}
      {integrations.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <Plug className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Entegrasyonlar ({integrations.length})</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {integrations.map((intg) => (
              <div key={intg.provider} className="flex items-center justify-between px-5 py-3">
                <p className="text-sm text-gray-900">{INTEGRATION_LABELS[intg.provider] ?? intg.provider}</p>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${intg.status === "connected" ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                  {intg.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
