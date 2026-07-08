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
    <div className="ad-admin-shell flex min-h-screen flex-col bg-neutral-50 text-neutral-950 lg:flex-row">
      {/* Sidebar */}
      <aside className="ad-admin-sidebar z-10 flex w-full shrink-0 flex-col border-b border-neutral-200 bg-white lg:fixed lg:inset-y-0 lg:left-0 lg:w-[196px] lg:border-b-0 lg:border-r">
        {/* Brand */}
        <div className="ad-admin-brand flex items-center gap-2.5 border-b border-neutral-200 px-4 py-3">
          <div className="ad-admin-mark flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-950">
            <ShieldCheck className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold leading-none text-neutral-950">Adsecute</p>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-widest leading-none text-neutral-500">Admin Console</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="ad-admin-nav flex-1 space-y-5 overflow-x-auto px-2.5 py-3 lg:overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="ad-admin-nav-group-label mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                {group.label}
              </p>
              <ul className="flex gap-0.5 lg:block lg:space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="ad-admin-nav-item flex whitespace-nowrap rounded-lg px-2.5 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-950 lg:items-center lg:gap-2"
                      >
                        <Icon className="h-4 w-4 shrink-0" />
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
        <div className="ad-admin-footer space-y-1 border-t border-neutral-200 px-2.5 py-3">
          <Link
            href="/overview"
            className="ad-admin-nav-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-950"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard'a dön
          </Link>
          <div className="px-2.5 py-1.5">
            <p className="text-xs font-medium text-neutral-700">{session.user.name}</p>
            <p className="truncate text-[11px] text-neutral-400">{session.user.email}</p>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="ad-admin-content min-h-screen flex-1 lg:ml-[196px]">
        <main className="mx-auto max-w-7xl p-4 sm:p-5 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
