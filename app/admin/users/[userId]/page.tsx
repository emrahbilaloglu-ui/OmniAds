"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, ShieldCheck, Trash2, Ban, CheckCircle2,
  KeyRound, LogOut, ExternalLink, Clock, Building2, CreditCard,
} from "lucide-react";

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter", growth: "Growth", pro: "Pro", scale: "Scale",
};
const PLANS = ["starter", "growth", "pro", "scale"] as const;

interface UserDetail {
  user: {
    id: string; name: string; email: string; avatar: string | null;
    created_at: string; is_superadmin: boolean; auth_provider: string;
    suspended_at: string | null; last_login_at: string | null;
    plan_override: string | null;
  };
  subscription: { plan_id: string; status: string; billing_cycle: string; shop_id: string } | null;
  businesses: Array<{
    id: string; name: string; created_at: string; role: string;
    plan_id: string | null; plan_override: string | null; subscription_status: string | null;
  }>;
  redemptions: Array<{ id: string; code: string; plan_id: string; amount_off: number; redeemed_at: string }>;
  sessions: Array<{ id: string; created_at: string; expires_at: string; session_status: string }>;
}

export default function AdminUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const [data, setData] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [planOverride, setPlanOverride] = useState<string>("");

  const load = () => {
    fetch(`/api/admin/users/${userId}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setPlanOverride(d.user?.plan_override ?? "");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [userId]);

  const showMsg = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const call = async (url: string, body?: object) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) { showMsg("error", payload?.message ?? "Hata oluştu."); return false; }
      return true;
    } finally { setBusy(false); }
  };

  const patch = async (body: object) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) { showMsg("error", payload?.message ?? "Hata oluştu."); return false; }
      return true;
    } finally { setBusy(false); }
  };

  const toggleAdmin = async () => {
    if (!data) return;
    const ok = await patch({ is_superadmin: !data.user.is_superadmin });
    if (ok) {
      setData((d) => d ? { ...d, user: { ...d.user, is_superadmin: !d.user.is_superadmin } } : d);
      showMsg("success", "Güncellendi.");
    }
  };

  const toggleSuspend = async () => {
    if (!data) return;
    const isSuspended = !!data.user.suspended_at;
    const ok = await call(`/api/admin/users/${userId}/suspend`, { unsuspend: isSuspended });
    if (ok) {
      setData((d) => d ? { ...d, user: { ...d.user, suspended_at: isSuspended ? null : new Date().toISOString() } } : d);
      showMsg("success", isSuspended ? "Kullanıcı aktif edildi." : "Kullanıcı askıya alındı.");
    }
  };

  const terminateSessions = async () => {
    const ok = await call(`/api/admin/users/${userId}/terminate-sessions`);
    if (ok) { showMsg("success", "Tüm sessionlar sonlandırıldı."); load(); }
  };

  const resetPassword = async () => {
    if (newPassword !== confirmPassword) { showMsg("error", "Şifreler eşleşmiyor."); return; }
    if (newPassword.length < 8) { showMsg("error", "Şifre en az 8 karakter olmalıdır."); return; }
    const ok = await call(`/api/admin/users/${userId}/reset-password`, { password: newPassword });
    if (ok) {
      showMsg("success", "Şifre sıfırlandı ve tüm sessionlar sonlandırıldı.");
      setShowPasswordForm(false); setNewPassword(""); setConfirmPassword("");
    }
  };

  const applyPlanOverride = async () => {
    const ok = await patch({ plan_override: planOverride || null });
    if (ok) {
      setData((d) => d ? { ...d, user: { ...d.user, plan_override: planOverride || null } } : d);
      showMsg("success", planOverride ? `Plan override: ${PLAN_LABELS[planOverride] ?? planOverride} uygulandı.` : "Plan override kaldırıldı.");
    }
  };

  const deleteUser = async () => {
    if (!confirm(`"${data?.user.name}" kullanıcısını silmek istediğinizden emin misiniz? Bu işlem geri alınamaz.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) { router.push("/admin/users"); return; }
    const body = await res.json().catch(() => null);
    showMsg("error", body?.message ?? "Silme başarısız.");
    setBusy(false);
  };

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-64" /><div className="h-48 bg-gray-200 rounded-xl" /></div>;
  }
  if (!data || !data.user) return <div className="text-sm text-gray-500">Kullanıcı bulunamadı.</div>;

  const { user, subscription, businesses, redemptions, sessions } = data;
  const isSuspended = !!user.suspended_at;
  const activeSessions = sessions.filter((s) => s.session_status === "active");
  const effectivePlan = user.plan_override || subscription?.plan_id || "starter";

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/admin/users" className="mt-1 text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{user.name}</h1>
            {user.is_superadmin && (
              <span className="inline-flex items-center gap-1 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">
                <ShieldCheck className="w-3 h-3" /> Admin
              </span>
            )}
            {isSuspended && (
              <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">
                <Ban className="w-3 h-3" /> Askıda
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-0.5">{user.email}</p>
        </div>
      </div>

      {message && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium ${message.type === "success" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {message.text}
        </div>
      )}

      {/* Info + Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Kullanıcı Bilgileri</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div><dt className="text-gray-400 text-xs mb-0.5">ID</dt><dd className="font-mono text-xs text-gray-600 break-all">{user.id}</dd></div>
            <div><dt className="text-gray-400 text-xs mb-0.5">Giriş Yöntemi</dt><dd className="capitalize text-gray-700">{user.auth_provider}</dd></div>
            <div><dt className="text-gray-400 text-xs mb-0.5">Kayıt Tarihi</dt><dd className="text-gray-700">{new Date(user.created_at).toLocaleString("tr-TR")}</dd></div>
            <div><dt className="text-gray-400 text-xs mb-0.5">Son Giriş</dt><dd className="text-gray-700">{user.last_login_at ? new Date(user.last_login_at).toLocaleString("tr-TR") : "—"}</dd></div>
            <div>
              <dt className="text-gray-400 text-xs mb-0.5">Aktif Plan</dt>
              <dd className="font-semibold text-gray-900">
                {PLAN_LABELS[effectivePlan] ?? effectivePlan}
                {user.plan_override && <span className="ml-1.5 text-[12px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Override</span>}
              </dd>
            </div>
            <div>
              <dt className="text-gray-400 text-xs mb-0.5">Shopify Abonelik</dt>
              <dd className="text-gray-700">{subscription ? `${PLAN_LABELS[subscription.plan_id] ?? subscription.plan_id} · ${subscription.status}` : "—"}</dd>
            </div>
            {isSuspended && (
              <div><dt className="text-gray-400 text-xs mb-0.5">Askıya Alınma</dt><dd className="text-red-600">{new Date(user.suspended_at!).toLocaleString("tr-TR")}</dd></div>
            )}
            <div><dt className="text-gray-400 text-xs mb-0.5">Aktif Session</dt><dd className="text-gray-700">{activeSessions.length}</dd></div>
          </dl>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Aksiyonlar</h2>
          <button onClick={toggleAdmin} disabled={busy}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
            <ShieldCheck className="w-4 h-4 text-indigo-500 shrink-0" />
            {user.is_superadmin ? "Admin yetkisini kaldır" : "Admin yap"}
          </button>
          <button onClick={toggleSuspend} disabled={busy}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border rounded-lg disabled:opacity-50 transition-colors ${isSuspended ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50" : "border-orange-200 text-orange-700 hover:bg-orange-50"}`}>
            {isSuspended ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <Ban className="w-4 h-4 shrink-0" />}
            {isSuspended ? "Askıyı kaldır" : "Hesabı askıya al"}
          </button>
          <button onClick={() => setShowPasswordForm((v) => !v)} disabled={busy}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
            <KeyRound className="w-4 h-4 text-amber-500 shrink-0" />
            Şifre sıfırla
          </button>
          <button onClick={terminateSessions} disabled={busy || activeSessions.length === 0}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
            <LogOut className="w-4 h-4 text-gray-500 shrink-0" />
            Tüm sessionları sonlandır ({activeSessions.length})
          </button>
          <hr className="border-gray-100 my-1" />
          <button onClick={deleteUser} disabled={busy}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors">
            <Trash2 className="w-4 h-4 shrink-0" />
            Kullanıcıyı sil
          </button>
        </div>
      </div>

      {/* Plan Override (user-level) */}
      <div className="bg-white border border-amber-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <CreditCard className="w-4 h-4 text-amber-500" />
          <h2 className="text-sm font-semibold text-gray-900">Kullanıcı Plan Override</h2>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Bu kullanıcıya Shopify'dan bağımsız olarak manuel plan ata. Override varken kullanıcının tüm workspace'leri bu planı kullanır.
        </p>
        <div className="flex gap-2 max-w-md">
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
            disabled={busy || planOverride === (user.plan_override ?? "")}
            className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
          >
            Uygula
          </button>
        </div>
      </div>

      {/* Password Reset Form */}
      {showPasswordForm && (
        <div className="bg-white border border-amber-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-amber-500" /> Yeni Şifre Belirle
          </h3>
          <div className="grid grid-cols-2 gap-4 max-w-md">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Yeni Şifre</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                placeholder="En az 8 karakter"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Şifre Tekrar</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Aynı şifreyi gir"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300" />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={resetPassword} disabled={busy || !newPassword || !confirmPassword}
              className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors">
              {busy ? "Kaydediliyor..." : "Şifreyi Kaydet"}
            </button>
            <button onClick={() => { setShowPasswordForm(false); setNewPassword(""); setConfirmPassword(""); }}
              className="px-4 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
              İptal
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">Şifre sıfırlandıktan sonra kullanıcının tüm aktif sessionları otomatik sonlandırılır.</p>
        </div>
      )}

      {/* Workspaces */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Building2 className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Workspace'ler ({businesses.length})</h2>
        </div>
        {businesses.length === 0 ? (
          <p className="px-5 py-5 text-sm text-gray-400">Hiç workspace yok.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
                <th className="text-left px-5 py-2.5 font-semibold">Workspace</th>
                <th className="text-left px-5 py-2.5 font-semibold">Rol</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {businesses.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{b.name}</td>
                  <td className="px-5 py-3 text-gray-500 capitalize">{b.role}</td>
                  <td className="px-5 py-3 text-right">
                    <Link href={`/admin/businesses/${b.id}`} className="text-indigo-500 hover:text-indigo-700">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Sessions */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Sessionlar (son 10)</h2>
        </div>
        {sessions.length === 0 ? (
          <p className="px-5 py-5 text-sm text-gray-400">Hiç session bulunamadı.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
                <th className="text-left px-5 py-2.5 font-semibold">Oluşturulma</th>
                <th className="text-left px-5 py-2.5 font-semibold">Bitiş</th>
                <th className="text-left px-5 py-2.5 font-semibold">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="px-5 py-2.5 text-gray-600">{new Date(s.created_at).toLocaleString("tr-TR")}</td>
                  <td className="px-5 py-2.5 text-gray-400">{new Date(s.expires_at).toLocaleString("tr-TR")}</td>
                  <td className="px-5 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${s.session_status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                      {s.session_status === "active" ? "Aktif" : "Süresi Dolmuş"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {redemptions.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Kullanılan İndirim Kodları</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
                <th className="text-left px-5 py-2.5 font-semibold">Kod</th>
                <th className="text-left px-5 py-2.5 font-semibold">Plan</th>
                <th className="text-left px-5 py-2.5 font-semibold">İndirim</th>
                <th className="text-left px-5 py-2.5 font-semibold">Tarih</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {redemptions.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-900 font-semibold">{r.code}</td>
                  <td className="px-5 py-2.5 text-gray-500">{PLAN_LABELS[r.plan_id] ?? r.plan_id}</td>
                  <td className="px-5 py-2.5 text-gray-700 font-semibold">${Number(r.amount_off).toFixed(2)}</td>
                  <td className="px-5 py-2.5 text-gray-400">{new Date(r.redeemed_at).toLocaleDateString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
