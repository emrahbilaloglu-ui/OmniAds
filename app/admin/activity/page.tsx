"use client";

import { useEffect, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, Activity } from "lucide-react";

interface AuditRow {
  id: string;
  admin_id: string;
  admin_name: string;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  "user.suspend":            "Kullanıcı askıya alındı",
  "user.unsuspend":          "Kullanıcı aktif edildi",
  "user.delete":             "Kullanıcı silindi",
  "user.reset_password":     "Şifre sıfırlandı",
  "user.terminate_sessions": "Sessionlar sonlandırıldı",
  "user.set_admin":          "Admin yetkisi verildi",
  "user.revoke_admin":       "Admin yetkisi kaldırıldı",
  "business.delete":         "Workspace silindi",
  "business.plan_override":  "Plan override uygulandı",
  "business.remove_member":  "Üye workspace'den çıkarıldı",
  "discount.create":         "İndirim kodu oluşturuldu",
  "discount.delete":         "İndirim kodu silindi",
  "discount.toggle":         "İndirim kodu durumu değiştirildi",
};

const TARGET_ICONS: Record<string, string> = {
  user: "👤",
  business: "🏢",
  discount: "🏷️",
  subscription: "💳",
};

const ACTION_COLORS: Record<string, string> = {
  "user.delete": "text-red-600",
  "business.delete": "text-red-600",
  "user.suspend": "text-orange-600",
  "user.set_admin": "text-indigo-600",
  "business.plan_override": "text-amber-600",
  "user.reset_password": "text-amber-600",
};

export default function AdminActivityPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/admin/activity?page=${page}`)
      .then((r) => r.json())
      .then((d) => { setRows(d.rows ?? []); setTotal(d.total ?? 0); })
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Activity className="w-5 h-5 text-gray-400" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Aktivite Logu</h1>
          <p className="text-sm text-gray-500 mt-0.5">Tüm admin aksiyonlarının kaydı — toplam {total}</p>
        </div>
      </div>

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-dashed border-gray-200 rounded-xl px-6 py-16 text-center">
          <Activity className="w-8 h-8 text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Henüz aksiyon kaydı yok.</p>
          <p className="text-xs text-gray-300 mt-1">Admin aksiyonları burada görünecek.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
                <th className="text-left px-5 py-3 font-semibold">Aksiyon</th>
                <th className="text-left px-5 py-3 font-semibold">Admin</th>
                <th className="text-left px-5 py-3 font-semibold">Hedef</th>
                <th className="text-left px-5 py-3 font-semibold">Detay</th>
                <th className="text-left px-5 py-3 font-semibold">Tarih</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-400">Yükleniyor...</td></tr>
              )}
              {!loading && rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3.5">
                    <span className={`font-medium ${ACTION_COLORS[row.action] ?? "text-gray-900"}`}>
                      {ACTION_LABELS[row.action] ?? row.action}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="text-gray-700">{row.admin_name}</p>
                    <p className="text-xs text-gray-400">{row.admin_email}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="mr-1.5">{TARGET_ICONS[row.target_type] ?? "•"}</span>
                    <span className="text-xs text-gray-400 capitalize">{row.target_type}</span>
                    {row.target_id && (
                      <p className="text-[12px] font-mono text-gray-300 mt-0.5">{row.target_id.slice(0, 18)}…</p>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-gray-400 max-w-xs">
                    {Object.keys(row.meta ?? {}).length > 0 && (
                      <span>
                        {Object.entries(row.meta)
                          .filter(([, v]) => v !== null && v !== undefined)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-gray-400 whitespace-nowrap">
                    {new Date(row.created_at).toLocaleString("tr-TR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
