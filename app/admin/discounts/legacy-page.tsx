"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, CheckCircle2, XCircle, ChevronRight } from "lucide-react";

interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  type: "percent" | "fixed";
  value: number;
  max_uses: number | null;
  uses: number;
  applies_to: string[];
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
}

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter", growth: "Growth", pro: "Pro", scale: "Scale",
};

export default function AdminDiscountsPage() {
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/discounts")
      .then((r) => r.json())
      .then((d) => setCodes(d.codes ?? []))
      .finally(() => setLoading(false));
  }, []);

  const toggleActive = async (code: DiscountCode) => {
    const res = await fetch(`/api/admin/discounts/${code.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !code.is_active }),
    });
    if (res.ok) {
      setCodes((prev) => prev.map((c) => c.id === code.id ? { ...c, is_active: !c.is_active } : c));
    }
  };

  const deleteCode = async (code: DiscountCode) => {
    if (!confirm(`"${code.code}" kodunu silmek istediğinizden emin misiniz?`)) return;
    const res = await fetch(`/api/admin/discounts/${code.id}`, { method: "DELETE" });
    if (res.ok) setCodes((prev) => prev.filter((c) => c.id !== code.id));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">İndirim Kodları</h1>
          <p className="text-sm text-gray-500 mt-1">{codes.length} kod tanımlı</p>
        </div>
        <Link
          href="/admin/discounts/new"
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Yeni Kod
        </Link>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 bg-gray-200 rounded-xl" />)}
        </div>
      ) : codes.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-200 rounded-xl px-6 py-12 text-center">
          <p className="text-sm text-gray-400">Henüz indirim kodu yok.</p>
          <Link href="/admin/discounts/new" className="mt-3 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline">
            <Plus className="w-3.5 h-3.5" /> İlk kodu oluştur
          </Link>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-500">Kod</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">İndirim</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Geçerlilik</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Kullanım</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Durum</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {codes.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-mono font-semibold text-gray-900">{c.code}</p>
                    {c.description && <p className="text-xs text-gray-400 mt-0.5">{c.description}</p>}
                    {c.applies_to.length > 0 && (
                      <div className="flex gap-1 mt-1">
                        {c.applies_to.map((p) => (
                          <span key={p} className="text-xs bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full">
                            {PLAN_LABELS[p] ?? p}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-900">
                    {c.type === "percent" ? `%${c.value}` : `$${c.value}`}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {c.valid_from ? new Date(c.valid_from).toLocaleDateString("tr-TR") : "—"}
                    {" → "}
                    {c.valid_until ? new Date(c.valid_until).toLocaleDateString("tr-TR") : "Süresiz"}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {c.uses}{c.max_uses !== null ? ` / ${c.max_uses}` : ""}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleActive(c)} title="Durumu değiştir">
                      {c.is_active
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        : <XCircle className="w-4 h-4 text-gray-300" />}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => deleteCode(c)}
                        className="text-xs text-red-400 hover:text-red-600"
                      >
                        Sil
                      </button>
                      <Link href={`/admin/discounts/${c.id}`}>
                        <ChevronRight className="w-4 h-4 text-gray-400 hover:text-gray-600" />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
