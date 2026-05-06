"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { usePlan } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import { PRICING_PLANS, type PlanId } from "@/lib/pricing/plans";
import { useAppStore } from "@/store/app-store";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { getNavItems } from "./nav-items";

const groups = ["Main", "Platforms", "Launchpad", "Assets", "Manage"] as const;

const PLATFORM_LOGOS_BY_HREF: Record<string, string> = {
  "/platforms/meta": "/platform-logos/Meta.png",
  "/launchpad/meta": "/platform-logos/Meta.png",
  "/google-ads": "/platform-logos/googleAds.svg",
  "/platforms/tiktok": "/platform-logos/tiktok.svg",
  "/platforms/pinterest": "/platform-logos/Pinterest.svg",
  "/platforms/snapchat": "/platform-logos/snapchat.svg",
  "/platforms/klaviyo": "/platform-logos/Klaviyo.svg",
};

const PLAN_LABELS: Record<PlanId, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  scale: "Scale",
};

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const language = usePreferencesStore((s) => s.language);
  const currentPlan = usePlan();
  const selectedBusinessId = useAppStore((s) => s.selectedBusinessId);
  const businesses = useAppStore((s) => s.businesses);
  const isDemo = isDemoBusinessSelected(selectedBusinessId, businesses);
  const t = getTranslations(language);
  const navItems = getNavItems(language);
  const groupLabels = {
    Main: t.navigation.main,
    Platforms: t.navigation.platforms,
    Launchpad: t.navigation.launchpad,
    Assets: t.navigation.assets,
    Manage: t.navigation.manage,
  } as const;

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 flex items-center gap-2">
        <BrandLogo markClassName="h-8 w-8" textClassName="text-lg" size={32} />
      </div>

      <Separator />

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {groups.map((group) => {
          const items = navItems.filter((item) => item.group === group);
          if (!items.length) return null;
          return (
            <div key={group}>
              <p className="px-3 mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {groupLabels[group]}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href;
                  const logoSrc =
                    item.group === "Platforms"
                      ? PLATFORM_LOGOS_BY_HREF[item.href]
                      : undefined;
                  const locked =
                    !isDemo &&
                    item.requiredPlan !== undefined &&
                    planRank(currentPlan) < planRank(item.requiredPlan);
                  const disabled = item.disabled === true;

                  if (disabled) {
                    return (
                      <li key={item.href}>
                        <button
                          type="button"
                          disabled
                          title={item.disabledLabel ?? "Coming soon"}
                          className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/40 cursor-not-allowed"
                        >
                          {logoSrc ? (
                            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-sm opacity-40">
                              <img
                                src={logoSrc}
                                alt={`${item.label} logo`}
                                className="h-4 w-4 object-contain"
                                loading="lazy"
                              />
                            </span>
                          ) : (
                            <Icon className="w-4 h-4 shrink-0 opacity-40" />
                          )}
                          <span className="flex-1 text-left">{item.label}</span>
                          {item.disabledLabel ? (
                            <span className="text-[10px] uppercase tracking-wide">
                              {item.disabledLabel}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  }

                  if (locked) {
                    const requiredName = PLAN_LABELS[item.requiredPlan!];
                    return (
                      <li key={item.href}>
                        <button
                          type="button"
                          onClick={() => router.push("/settings")}
                          title={t.layout.upgradeToUnlock.replace("{plan}", requiredName)}
                          className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/50 cursor-pointer hover:bg-accent/50 hover:text-muted-foreground transition-colors"
                        >
                          {logoSrc ? (
                            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-sm opacity-40">
                              <img
                                src={logoSrc}
                                alt={`${item.label} logo`}
                                className="h-4 w-4 object-contain"
                                loading="lazy"
                              />
                            </span>
                          ) : (
                            <Icon className="w-4 h-4 shrink-0 opacity-40" />
                          )}
                          <span className="flex-1 text-left">{item.label}</span>
                          <Lock className="w-3 h-3 shrink-0 opacity-50" />
                        </button>
                      </li>
                    );
                  }

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                          active
                            ? "bg-primary text-primary-foreground font-medium"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                      >
                        {logoSrc ? (
                          <span
                            className={cn(
                              "inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-sm",
                              active ? "bg-white/85" : "bg-transparent"
                            )}
                          >
                            <img
                              src={logoSrc}
                              alt={`${item.label} logo`}
                              className="h-4 w-4 object-contain"
                              loading="lazy"
                            />
                          </span>
                        ) : (
                          <Icon className="w-4 h-4 shrink-0" />
                        )}
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
