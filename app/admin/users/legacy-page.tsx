"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight, ShieldCheck, Ban, Filter } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";

interface UserRow {
  id: string;
  name: string;
  email: string;
  created_at: string;
  is_superadmin: boolean;
  auth_provider: string;
  suspended_at: string | null;
  last_login_at: string | null;
  business_count: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  password: "E-posta", google: "Google", facebook: "Facebook",
};

const PROVIDER_COLORS: Record<string, string> = {
  password: "bg-gray-100 text-gray-600",
  google: "bg-red-50 text-red-600",
  facebook: "bg-blue-50 text-blue-700",
};

const USER_HELP: Record<string, string> = {
  Kullanıcı: "User profile and admin marker, if present.",
  Giriş: "Authentication method used by the user account.",
  Workspace: "Number of workspaces the user is associated with.",
  "Son Giriş": "Most recent recorded login date.",
  Kayıt: "User account creation date.",
  Durum: "Whether the user is currently active or suspended.",
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, provider, status]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (provider) params.set("provider", provider);
    if (status) params.set("status", status);
    fetch(`/api/admin/users?${params}`)
      .then((r) => r.json())
      .then((d) => { setUsers(d.users ?? []); setTotal(d.total ?? 0); })
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, provider, status]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / 30);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kullanıcılar</h1>
          <p className="text-sm text-gray-500 mt-1">Toplam <span className="font-semibold text-gray-700">{total}</span> kullanıcı</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="İsim veya e-posta ara..."
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 w-64"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            <option value="">Tüm Giriş Yöntemleri</option>
            <option value="password">E-posta / Şifre</option>
            <option value="google">Google</option>
            <option value="facebook">Facebook</option>
          </select>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            <option value="">Tüm Durumlar</option>
            <option value="active">Aktif</option>
            <option value="suspended">Askıda</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {(search || provider || status) && (
          <button
            onClick={() => { setSearch(""); setProvider(""); setStatus(""); }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Filtreleri temizle
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Kullanıcı" help={USER_HELP.Kullanıcı} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Giriş" help={USER_HELP.Giriş} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Workspace" help={USER_HELP.Workspace} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Son Giriş" help={USER_HELP["Son Giriş"]} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Kayıt" help={USER_HELP.Kayıt} /></th>
              <th className="text-left px-5 py-3 font-semibold"><HeaderWithHelp label="Durum" help={USER_HELP.Durum} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-400">Yükleniyor...</td></tr>
            )}
            {!loading && users.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-400">Sonuç bulunamadı.</td></tr>
            )}
            {!loading && users.map((u) => (
              <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${u.suspended_at ? "opacity-60" : ""}`}>
                <td className="px-5 py-3.5">
                  <Link href={`/admin/users/${u.id}`} className="group">
                    <p className="font-medium text-gray-900 group-hover:text-indigo-600 flex items-center gap-1.5">
                      {u.name}
                      {u.is_superadmin && <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" />}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{u.email}</p>
                  </Link>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PROVIDER_COLORS[u.auth_provider] ?? "bg-gray-100 text-gray-600"}`}>
                    {PROVIDER_LABELS[u.auth_provider] ?? u.auth_provider}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-gray-500">{u.business_count}</td>
                <td className="px-5 py-3.5 text-gray-400 text-xs">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString("tr-TR") : "—"}
                </td>
                <td className="px-5 py-3.5 text-gray-400 text-xs">
                  {new Date(u.created_at).toLocaleDateString("tr-TR")}
                </td>
                <td className="px-5 py-3.5">
                  {u.suspended_at ? (
                    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-600">
                      <Ban className="w-3 h-3" /> Askıda
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-600">
                      Aktif
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">Sayfa {page} / {totalPages} — {total} kullanıcı</p>
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
