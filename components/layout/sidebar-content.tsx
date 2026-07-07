"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  locked: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const Icon = item.icon;
  const className = cn(
    "flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-md text-[13px] cursor-pointer",
    active
      ? "bg-blue-50 text-blue-700 font-semibold"
      : "text-neutral-600 hover:bg-neutral-50"
  );
  const content = (
    <>
      <span className={cn("w-4 h-4 grid place-items-center", active ? "text-blue-600" : "text-neutral-500")}>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span>{item.label}</span>
      {renderL1Trail(item, locked)}
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
    <Link href={item.href} className={className} onClick={onNavigate} data-l1={item.id}>
      {content}
    </Link>
  );
}

function L2NavItem({
  item,
  active,
  dimmed,
  locked,
  accent,
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  dimmed: boolean;
  locked: boolean;
  accent: PlatformAccent;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const Icon = item.icon;
  const className = cn(
    "flex items-center gap-2 pr-2 py-1.5 rounded-r-md text-[13px] cursor-pointer",
    active
      ? L2_ACTIVE_ACCENT_CLASSES[accent]
      : "text-neutral-700 hover:bg-neutral-50 border-l-[3px] border-l-transparent pl-[7px]",
    dimmed ? "opacity-50" : ""
  );
  const content = (
    <>
      <span className={cn("w-4 h-4 grid place-items-center", active ? "" : "text-neutral-500")}>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span>{item.label}</span>
      {item.subStatus ? (
        <span className="ml-auto">
          <SubStatusBadge status={item.subStatus} />
        </span>
      ) : locked ? (
        <span className="ml-auto inline-flex items-center text-neutral-400">
          <Lock className="h-3 w-3" />
        </span>
      ) : item.badge != null ? (
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
    <Link href={item.href} className={className} onClick={onNavigate} data-l2={item.id}>
      {content}
    </Link>
  );
}

function SoonPlatformEmpty({ platformId }: { platformId: keyof typeof platformsRegistry }) {
  const platform = platformsRegistry[platformId];
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

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
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

  return (
    <div className="w-60 shrink-0 border-r border-neutral-200 bg-white h-full flex flex-col" data-shell-sidebar>
      <div className="px-3 py-2.5 border-b border-neutral-200 flex items-center gap-2">
        <BrandLogo
          className="gap-2"
          markClassName="h-7 w-7"
          textClassName="text-[13px] font-semibold text-neutral-900 leading-tight"
          size={28}
        />
      </div>

      <nav className="flex-1 overflow-y-auto py-2 space-y-0.5">
        <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
          {t.navigation.workspace}
        </div>
        <div className="px-2 space-y-0.5">
          {layer1Items.map((item) => (
            <L1NavItem
              key={item.id}
              item={item}
              active={activeLayer === "L1" && isItemActive(item, pathname)}
              locked={isLocked(item, currentPlan, isDemo)}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <div className="my-2 mx-3 border-t border-neutral-200" />

        <div className="px-0">
          <div className={cn("px-2 pt-1 pb-1 flex items-center gap-1.5", dimLayer2 ? "opacity-60" : "")}>
            <span className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
              Platform
            </span>
            <span className="text-neutral-300">·</span>
            <PlatformLogo platformId={activePlatformId} size={14} />
            <span className="text-[10.5px] font-semibold text-neutral-700">{platform.name}</span>
            {dimLayer2 ? <span className="ml-auto text-[10px] text-neutral-400 italic">last viewed</span> : null}
          </div>
          <div className="space-y-0.5">
            {platform.status === "soon" || layer2Items.length === 0 ? (
              <SoonPlatformEmpty platformId={activePlatformId} />
            ) : (
              layer2Items.map((item) => (
                <L2NavItem
                  key={item.id}
                  item={item}
                  active={!dimLayer2 && activeLayer === "L2" && isItemActive(item, pathname)}
                  dimmed={dimLayer2}
                  locked={isLocked(item, currentPlan, isDemo)}
                  accent={platform.accent}
                  onNavigate={onNavigate}
                />
              ))
            )}
          </div>
        </div>

        <div className="my-2 mx-3 border-t border-neutral-200" />

        <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
          {t.navigation.manage}
        </div>
        <div className="px-2 space-y-0.5">
          {layer3Items.map((item) => (
            <L1NavItem
              key={item.id}
              item={item}
              active={activeLayer === "L3" && isItemActive(item, pathname)}
              locked={isLocked(item, currentPlan, isDemo)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>
    </div>
  );
}
