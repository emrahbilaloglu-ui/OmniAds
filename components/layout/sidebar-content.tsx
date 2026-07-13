"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { usePlan } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import type { PlanId } from "@/lib/pricing/plans";
import { useAppStore } from "@/store/app-store";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";
import { usePlatformContext } from "@/lib/navigation/platform-context";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { PlatformLogo } from "./PlatformSwitcher";
import {
  getLayer1Items,
  getLayer3Items,
  getPlatformLayer2Items,
  platformsRegistry,
  type PlatformAccent,
  type ShellNavItem,
} from "./nav-items";

const PLAN_LABELS: Record<PlanId, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  scale: "Scale",
};

// Triple-Whale-calm: a single blue primary carries the active state across
// every platform — no per-platform accent theming, so the chrome stays quiet
// and the numbers do the talking. Keyed by accent to preserve the type surface.
const L2_ACTIVE_ACCENT: string =
  "bg-blue-50 text-blue-700 font-semibold border-l-[3px] border-l-blue-600 pl-[7px]";
const L2_ACTIVE_ACCENT_CLASSES: Record<PlatformAccent, string> = {
  blue: L2_ACTIVE_ACCENT,
  violet: L2_ACTIVE_ACCENT,
  emerald: L2_ACTIVE_ACCENT,
  slate: L2_ACTIVE_ACCENT,
};

const L2_SUB_STATUS_CLASSES = {
  coming: "bg-amber-50 text-amber-800 border-amber-200",
  soon: "bg-neutral-100 text-neutral-500 border-neutral-200",
} as const;

function isItemActive(item: ShellNavItem, pathname: string) {
  const candidates = [item.href, ...(item.activeHrefs ?? [])];
  if (item.exact) return candidates.some((href) => pathname === href);
  return candidates.some((href) => pathname === href || pathname.startsWith(`${href}/`));
}

function isLocked(item: ShellNavItem, currentPlan: PlanId, isDemo: boolean) {
  return (
    !isDemo &&
    item.requiredPlan !== undefined &&
    planRank(currentPlan) < planRank(item.requiredPlan)
  );
}

function SubStatusBadge({ status }: { status: NonNullable<ShellNavItem["subStatus"]> }) {
  const label = status === "coming" ? "Coming" : "Soon";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1 py-px rounded border text-[9px] font-semibold uppercase tracking-wider",
        L2_SUB_STATUS_CLASSES[status]
      )}
    >
      {label}
    </span>
  );
}

function LockTrail({ requiredPlan }: { requiredPlan: PlanId }) {
  return (
    <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-neutral-400">
      <Lock className="h-[11px] w-[11px]" />
      <span className="font-medium uppercase tracking-wider">{PLAN_LABELS[requiredPlan]}</span>
    </span>
  );
}

function renderL1Trail(item: ShellNavItem, locked: boolean) {
  if (locked && item.requiredPlan) return <LockTrail requiredPlan={item.requiredPlan} />;
  return null;
}

function L1NavItem({
  item,
  active,
  locked,
  isConsole = false,
  collapsed = false,
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  locked: boolean;
  isConsole?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const Icon = item.icon;
  const className = cn(
    "flex items-center gap-2 py-1.5 rounded-md text-[13px] cursor-pointer",
    collapsed ? "justify-center px-2" : "pl-2.5 pr-2",
    active
      ? isConsole
        ? "bg-[var(--adc-s2)] border border-[var(--adc-b1)] text-[var(--adc-ink)] font-semibold"
        : "bg-blue-50 text-blue-700 font-semibold"
      : "text-neutral-600 hover:bg-neutral-50"
  );
  const content = (
    <>
      <span className={cn("w-4 h-4 grid place-items-center", active ? (isConsole ? "text-[var(--adc-ink2)]" : "text-blue-600") : "text-neutral-500")}>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      {!collapsed ? <span>{item.label}</span> : null}
      {!collapsed ? renderL1Trail(item, locked) : null}
    </>
  );

  if (locked) {
    return (
      <button
        type="button"
        className={cn(className, "w-full text-left")}
        title={`Upgrade to ${PLAN_LABELS[item.requiredPlan!]} to unlock`}
        onClick={() => router.push("/settings")}
      >
        {content}
      </button>
    );
  }

  return (
    <Link
      href={item.href}
      className={className}
      onClick={onNavigate}
      data-l1={item.id}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
    >
      {content}
    </Link>
  );
}

function L2NavItem({
  item,
  href,
  active,
  dimmed,
  locked,
  accent,
  isConsole = false,
  collapsed = false,
  onNavigate,
}: {
  item: ShellNavItem;
  href?: string;
  active: boolean;
  dimmed: boolean;
  locked: boolean;
  accent: PlatformAccent;
  isConsole?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const Icon = item.icon;
  const className = cn(
    isConsole
      ? "flex items-center gap-2 pr-2 py-1.5 rounded-md text-[13px] cursor-pointer"
      : "flex items-center gap-2 pr-2 py-1.5 rounded-r-md text-[13px] cursor-pointer",
    collapsed ? "justify-center px-2" : "",
    active
      ? isConsole
        ? cn(
            "bg-[var(--adc-s2)] border border-[var(--adc-b1)] text-[var(--adc-ink)] font-semibold",
            collapsed ? "pl-2" : "pl-[7px]",
          )
        : L2_ACTIVE_ACCENT_CLASSES[accent]
      : isConsole
        ? cn(
            "text-[var(--adc-ink2)] hover:bg-[var(--adc-s3)]",
            collapsed ? "pl-2" : "pl-[7px]",
          )
        : "text-neutral-700 hover:bg-neutral-50 border-l-[3px] border-l-transparent pl-[7px]",
    dimmed ? "opacity-50" : ""
  );
  const content = (
    <>
      <span className={cn("w-4 h-4 grid place-items-center", active ? (isConsole ? "text-[var(--adc-ink2)]" : "") : "text-neutral-500")}>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      {!collapsed ? <span>{item.label}</span> : null}
      {!collapsed && item.subStatus ? (
        <span className="ml-auto">
          <SubStatusBadge status={item.subStatus} />
        </span>
      ) : !collapsed && locked ? (
        <span className="ml-auto inline-flex items-center text-neutral-400">
          <Lock className="h-3 w-3" />
        </span>
      ) : !collapsed && item.badge != null ? (
        <span className="ml-auto text-[11px] font-mono tabular-nums text-neutral-500 px-1.5 py-0.5 bg-white border border-neutral-200 rounded-md">
          {item.badge}
        </span>
      ) : null}
    </>
  );

  if (locked) {
    return (
      <button
        type="button"
        className={cn(className, "w-full text-left")}
        title={`Upgrade to ${PLAN_LABELS[item.requiredPlan!]} to unlock`}
        onClick={() => router.push("/settings")}
      >
        {content}
      </button>
    );
  }

  return (
    <Link
      href={href ?? item.href}
      className={className}
      onClick={onNavigate}
      data-l2={item.id}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
    >
      {content}
    </Link>
  );
}

function SoonPlatformEmpty({
  platformId,
  collapsed = false,
}: {
  platformId: keyof typeof platformsRegistry;
  collapsed?: boolean;
}) {
  const platform = platformsRegistry[platformId];
  if (collapsed) {
    return (
      <div className="mx-2 grid h-9 place-items-center" title={`${platform.name} not live yet`}>
        <PlatformLogo platformId={platformId} size={18} />
      </div>
    );
  }
  return (
    <div className="mx-2 my-1 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/50 p-3 text-center">
      <div className="flex justify-center mb-1.5">
        <PlatformLogo platformId={platformId} size={22} />
      </div>
      <div className="text-[11.5px] font-medium text-neutral-700">
        {platform.name} not live yet
      </div>
      <div className="text-[10.5px] text-neutral-500 mt-0.5">
        No tools to show. Switch platform from the topbar.
      </div>
    </div>
  );
}

export function SidebarContent({
  onNavigate,
  variant = "legacy",
  collapsed = false,
}: {
  onNavigate?: () => void;
  variant?: "legacy" | "console";
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const language = usePreferencesStore((state) => state.language);
  const currentPlan = usePlan();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const isDemo = isDemoBusinessSelected(selectedBusinessId, businesses);
  const t = getTranslations(language);
  const layer1Items = getLayer1Items(language);
  const layer3Items = getLayer3Items(language);
  const { activePlatformId } = usePlatformContext();
  const platform = platformsRegistry[activePlatformId];
  const layer2Items = getPlatformLayer2Items(activePlatformId, language);
  const activeLayer1 = layer1Items.find((item) => isItemActive(item, pathname));
  const activeLayer3 = layer3Items.find((item) => isItemActive(item, pathname));
  const activeLayer = activeLayer1 ? "L1" : activeLayer3 ? "L3" : "L2";
  const dimLayer2 = activeLayer === "L1";
  const isConsole = variant === "console";
  const currentProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const scopedLayer2Href = (item: ShellNavItem) =>
    activePlatformId === "meta" && item.href.startsWith("/platforms/meta")
      ? buildMetaScopedHref(item.href, {
          businessId: selectedBusinessId,
          providerAccountId: currentProviderAccountId,
        })
      : item.href;

  return (
    <div
      className={cn(
        "h-full shrink-0 border-r flex flex-col",
        isConsole
          ? cn(
              collapsed ? "w-[56px]" : "w-[196px]",
              "border-[var(--adc-b1)] bg-[var(--adc-s1)] transition-[width] duration-150",
            )
          : "w-60 border-neutral-200 bg-white",
      )}
      data-shell-sidebar
      data-shell-sidebar-variant={variant}
    >
      {!isConsole ? (
        <div className="px-3 py-2.5 border-b border-neutral-200 flex items-center gap-2">
          <BrandLogo
            className="gap-2"
            markClassName="h-7 w-7"
            textClassName="text-[13px] font-semibold text-neutral-900 leading-tight"
            size={28}
          />
        </div>
      ) : null}

      <nav className={cn("flex-1 overflow-y-auto space-y-0.5", isConsole ? "py-3" : "py-2")}>
        <div
          className={cn(
            "px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold",
            collapsed ? "sr-only" : "",
          )}
        >
          {t.navigation.workspace}
        </div>
        <div className="px-2 space-y-0.5">
          {layer1Items.map((item) => (
            <L1NavItem
              key={item.id}
              item={item}
              active={activeLayer === "L1" && isItemActive(item, pathname)}
              locked={isLocked(item, currentPlan, isDemo)}
              isConsole={isConsole}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <div className="my-2 mx-3 border-t border-neutral-200" />

        <div className="px-0">
          <div
            className={cn(
              "px-2 pt-1 pb-1 flex items-center gap-1.5",
              collapsed ? "justify-center" : "",
              dimLayer2 ? "opacity-60" : ""
            )}
          >
            <span
              className={cn(
                collapsed ? "sr-only" : "",
                "text-[10px] uppercase tracking-wider text-neutral-400 font-semibold"
              )}
            >
              Platform
            </span>
            {!collapsed ? (
              <span className="text-neutral-300">·</span>
            ) : null}
            <PlatformLogo platformId={activePlatformId} size={14} />
            <span
              className={cn(
                collapsed ? "sr-only" : "",
                "text-[10.5px] font-semibold text-neutral-700"
              )}
            >
              {platform.name}
            </span>
            {dimLayer2 && !collapsed ? (
              <span className="ml-auto text-[10px] text-neutral-400 italic">last viewed</span>
            ) : null}
          </div>
          <div className="space-y-0.5">
            {platform.status === "soon" || layer2Items.length === 0 ? (
              <SoonPlatformEmpty
                platformId={activePlatformId}
                collapsed={collapsed}
              />
            ) : (
              layer2Items.map((item) => (
                <L2NavItem
                  key={item.id}
                  item={item}
                  href={scopedLayer2Href(item)}
                  active={!dimLayer2 && activeLayer === "L2" && isItemActive(item, pathname)}
                  dimmed={dimLayer2}
                  locked={isLocked(item, currentPlan, isDemo)}
                  accent={platform.accent}
                  isConsole={isConsole}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))
            )}
          </div>
        </div>

        <div className="my-2 mx-3 border-t border-neutral-200" />

        <div
          className={cn(
            "px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold",
            collapsed ? "sr-only" : "",
          )}
        >
          {t.navigation.manage}
        </div>
        <div className="px-2 space-y-0.5">
          {layer3Items.map((item) => (
            <L1NavItem
              key={item.id}
              item={item}
              active={activeLayer === "L3" && isItemActive(item, pathname)}
              locked={isLocked(item, currentPlan, isDemo)}
              isConsole={isConsole}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>
    </div>
  );
}
