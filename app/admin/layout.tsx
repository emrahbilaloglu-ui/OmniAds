import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionFromCookies } from "@/lib/auth";
import { isSuperadmin } from "@/lib/admin-auth";
import {
  LayoutDashboard,
  Users,
  Building2,
  CreditCard,
  Tag,
  Activity,
  AlertTriangle,
  KeyRound,
  RefreshCw,
  HardDrive,
  TrendingDown,
  ArrowLeft,
  ShieldCheck,
} from "lucide-react";

const navGroups = [
  {
    label: "Genel",
    items: [
      { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
      { href: "/admin/activity", label: "Aktivite Logu", icon: Activity },
      { href: "/admin/integrations", label: "Entegrasyon Sağlığı", icon: AlertTriangle },
      { href: "/admin/auth-health", label: "Auth & OAuth", icon: KeyRound },
      { href: "/admin/sync-health", label: "Sync Health", icon: RefreshCw },
      { href: "/admin/system-capacity", label: "System Capacity", icon: HardDrive },
      { href: "/admin/release-authority", label: "Release Authority", icon: ShieldCheck },
      { href: "/admin/revenue-risk", label: "Revenue Risk", icon: TrendingDown },
    ],
  },
  {
    label: "Kullanıcılar",
    items: [
      { href: "/admin/users", label: "Kullanıcılar", icon: Users },
      { href: "/admin/businesses", label: "Workspace'ler", icon: Building2 },
    ],
  },
  {
    label: "Finansal",
    items: [
      { href: "/admin/subscriptions", label: "Abonelikler", icon: CreditCard },
      { href: "/admin/discounts", label: "İndirim Kodları", icon: Tag },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies();
  if (!session) redirect("/login");

  const admin = await isSuperadmin(session.user.id);
  if (!admin) redirect("/overview");

  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-900">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col fixed inset-y-0 left-0 z-10">
        {/* Brand */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600">
            <ShieldCheck className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900 leading-none">Adsecute</p>
            <p className="text-[10px] font-medium text-indigo-600 uppercase tracking-widest leading-none mt-0.5">Admin Panel</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-600 rounded-lg hover:bg-gray-100 hover:text-gray-900 transition-colors"
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-gray-200 space-y-1">
          <Link
            href="/overview"
            className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Dashboard'a dön
          </Link>
          <div className="px-3 py-1.5">
            <p className="text-xs font-medium text-gray-700">{session.user.name}</p>
            <p className="text-[11px] text-gray-400 truncate">{session.user.email}</p>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 ml-60 min-h-screen">
        <main className="p-8 max-w-7xl mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
