"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter", growth: "Growth", pro: "Pro", scale: "Scale",
};

interface CodeDetail {
  code: {
    id: string; code: string; description: string | null;
    type: "percent" | "fixed"; value: number;
    max_uses: number | null; uses: number;
    applies_to: string[]; valid_from: string | null; valid_until: string | null;
    is_active: boolean; created_at: string;
  };
  redemptions: Array<{
    id: string; user_name: string; user_email: string;
    plan_id: string; amount_off: number; redeemed_at: string;
  }>;
}

export default function DiscountDetailPage() {
  const { codeId } = useParams<{ codeId: string }>();
  const router = useRouter();
  const [data, setData] = useState<CodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/admin/discounts/${codeId}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [codeId]);

  const toggleActive = async () => {
    if (!data) return;
    setSaving(true);
    const res = await fetch(`/api/admin/discounts/${codeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !data.code.is_active }),
    });
    if (res.ok) {
      setData((d) => d ? { ...d, code: { ...d.code, is_active: !d.code.is_active } } : d);
    }
    setSaving(false);
  };

  const deleteCode = async () => {
    if (!confirm("Bu indirim kodunu silmek istediğinizden emin misiniz?")) return;
    await fetch(`/api/admin/discounts/${codeId}`, { method: "DELETE" });
    router.push("/admin/discounts");
  };

  if (loading) return <div className="animate-pulse h-48 bg-gray-200 rounded-xl" />;
  if (!data) return <div className="text-sm text-gray-500">Kod bulunamadı.</div>;

  const { code, redemptions } = data;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/discounts" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold font-mono text-gray-900">{code.code}</h1>
          {code.description && <p className="text-sm text-gray-400 mt-0.5">{code.description}</p>}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={toggleActive}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {code.is_active
              ? <><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Aktif</>
              : <><XCircle className="w-4 h-4 text-gray-300" /> Pasif</>}
          </button>
          <button
            onClick={deleteCode}
            className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
          >
            Sil
          </button>
        </div>
      </div>

      {/* Details */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 grid grid-cols-2 gap-4 text-sm">
        <div><p className="text-gray-400">Tip</p><p className="font-semibold text-gray-900 mt-0.5">{code.type === "percent" ? "Yüzde" : "Sabit"}</p></div>
        <div><p className="text-gray-400">Değer</p><p className="font-semibold text-gray-900 mt-0.5">{code.type === "percent" ? `%${code.value}` : `$${code.value}`}</p></div>
        <div><p className="text-gray-400">Kullanım</p><p className="font-semibold text-gray-900 mt-0.5">{code.uses}{code.max_uses !== null ? ` / ${code.max_uses}` : " (sınırsız)"}</p></div>
        <div><p className="text-gray-400">Geçerli Planlar</p>
          <p className="font-semibold text-gray-900 mt-0.5">
            {code.applies_to.length === 0 ? "Tümü" : code.applies_to.map((p) => PLAN_LABELS[p] ?? p).join(", ")}
          </p>
        </div>
        <div><p className="text-gray-400">Başlangıç</p><p className="font-semibold text-gray-900 mt-0.5">{code.valid_from ? new Date(code.valid_from).toLocaleDateString("tr-TR") : "—"}</p></div>
        <div><p className="text-gray-400">Bitiş</p><p className="font-semibold text-gray-900 mt-0.5">{code.valid_until ? new Date(code.valid_until).toLocaleDateString("tr-TR") : "Süresiz"}</p></div>
      </div>

      {/* Redemptions */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Kullanım Geçmişi ({redemptions.length})</h2>
        </div>
        {redemptions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-400">Henüz kullanılmamış.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-50 bg-gray-50">
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Kullanıcı</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Plan</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">İndirim</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Tarih</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-50">
              {redemptions.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <p className="text-gray-900">{r.user_name}</p>
                    <p className="text-xs text-gray-400">{r.user_email}</p>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">{PLAN_LABELS[r.plan_id] ?? r.plan_id}</td>
                  <td className="px-4 py-2.5 font-semibold text-gray-900">${Number(r.amount_off).toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-gray-400">{new Date(r.redeemed_at).toLocaleDateString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
