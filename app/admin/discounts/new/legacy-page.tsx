"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DatePicker } from "@/components/date-range/DateRangePicker";

const PLANS = [
  { id: "starter", label: "Starter" },
  { id: "growth", label: "Growth" },
  { id: "pro", label: "Pro" },
  { id: "scale", label: "Scale" },
];

export default function NewDiscountPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [appliesTo, setAppliesTo] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");

  const togglePlan = (planId: string) => {
    setAppliesTo((prev) =>
      prev.includes(planId) ? prev.filter((p) => p !== planId) : [...prev, planId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const res = await fetch("/api/admin/discounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        description: description || undefined,
        type,
        value: Number(value),
        maxUses: maxUses ? Number(maxUses) : undefined,
        appliesTo,
        validFrom: validFrom || undefined,
        validUntil: validUntil || undefined,
      }),
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.message ?? "Bir hata oluştu.");
      setSaving(false);
      return;
    }

    router.push("/admin/discounts");
  };

  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/discounts" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Yeni İndirim Kodu</h1>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
        {/* Code */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Kod *</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="YILBASI20"
            required
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 font-mono uppercase"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Açıklama</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Yılbaşı kampanyası"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Type + Value */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">İndirim Tipi *</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "percent" | "fixed")}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="percent">Yüzde (%)</option>
              <option value="fixed">Sabit ($)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              İndirim Değeri * {type === "percent" ? "(%)" : "($)"}
            </label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={type === "percent" ? "20" : "10"}
              min="0.01"
              max={type === "percent" ? "100" : undefined}
              step="0.01"
              required
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
        </div>

        {/* Max uses */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Maksimum Kullanım <span className="text-gray-400 font-normal">(boş bırakırsan sınırsız)</span>
          </label>
          <input
            type="number"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="100"
            min="1"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Applies to */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Geçerli Planlar <span className="text-gray-400 font-normal">(hiçbiri seçilmezse tüm planlar için geçerli)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {PLANS.map((plan) => (
              <button
                key={plan.id}
                type="button"
                onClick={() => togglePlan(plan.id)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  appliesTo.includes(plan.id)
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {plan.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-4">
          <DatePicker
            label="Başlangıç tarihi"
            value={validFrom || null}
            onChange={(value) => setValidFrom(value ?? "")}
            maxDate={validUntil || null}
            className="w-full"
            testId="discount-valid-from"
          />
          <DatePicker
            label="Bitiş tarihi"
            value={validUntil || null}
            onChange={(value) => setValidUntil(value ?? "")}
            minDate={validFrom || undefined}
            maxDate={null}
            className="w-full"
            testId="discount-valid-until"
            align="end"
          />
        </div>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Kaydediliyor..." : "Kodu Oluştur"}
          </button>
          <Link
            href="/admin/discounts"
            className="px-4 py-2.5 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
          >
            İptal
          </Link>
        </div>
      </form>
    </div>
  );
}
