"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { clearAuthScopedClientState } from "@/lib/client-auth-state";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { PLAN_LABELS, type PlanId } from "@/lib/pricing/plans";
import { usePlan } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";
import {
  getRailModel,
  isPlatformFamilyActive,
  isRailLinkActive,
  type RailLink,
  type RailPlatform,
} from "./nav-model";
import { useMetaActionNowCount } from "./use-shell-signals";

function useLocked() {
  const currentPlan = usePlan();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const isDemo = isDemoBusinessSelected(selectedBusinessId, businesses);
  return (requiredPlan?: PlanId) =>
    !isDemo &&
    requiredPlan !== undefined &&
    planRank(currentPlan) < planRank(requiredPlan);
}

function RailIcon({ icon: Icon, size }: { icon: RailLink["icon"]; size: number }) {
  return <Icon style={{ width: size, height: size }} className="shrink-0" strokeWidth={2} />;
}

/**
 * The design's rail carries no plan chips — growth and workspace rows are icon
 * plus label, full stop. A gated row keeps its lock signal the way the design
 * dims an unavailable platform: reduced opacity plus the upgrade tooltip.
 */
const LOCKED_ROW_STYLE = { opacity: 0.55 } as const;

function RailRow({
  link,
  active,
  locked,
  onNavigate,
  className,
  iconSize = 16,
}: {
  link: RailLink;
  active: boolean;
  locked: boolean;
  onNavigate?: () => void;
  className?: string;
  iconSize?: number;
}) {
  const router = useRouter();

  if (locked && link.requiredPlan) {
    return (
      <button
        type="button"
        className={cn("adv-rail-item", className)}
        title={`Upgrade to ${PLAN_LABELS[link.requiredPlan]} to unlock`}
        onClick={() => router.push("/settings")}
        data-nav={link.id}
        style={LOCKED_ROW_STYLE}
      >
        <RailIcon icon={link.icon} size={iconSize} />
        <span>{link.label}</span>
      </button>
    );
  }

  return (
    <Link
      href={link.href}
      className={cn("adv-rail-item", className)}
      data-active={active}
      data-nav={link.id}
      onClick={onNavigate}
    >
      <RailIcon icon={link.icon} size={iconSize} />
      <span>{link.label}</span>
    </Link>
  );
}

function PlatformBlock({
  platform,
  pathname,
  onNavigate,
  actionNowCount,
  scopedHref,
}: {
  platform: RailPlatform;
  pathname: string;
  onNavigate?: () => void;
  actionNowCount: number | null;
  scopedHref: (href: string) => string;
}) {
  const isLocked = useLocked();
  const familyActive = isPlatformFamilyActive(platform, pathname);
  const soon = platform.status === "soon";
  const hasChildren = platform.children.length > 0;
  // A platform with children uses the parent row purely as the family header —
  // the highlighted row is always the child the route resolves to.
  const parentActive = !hasChildren && familyActive;

  const row = (
    <>
      <span className="adv-rail-logo">
        <Image
          src={platform.logoSrc}
          alt=""
          width={13}
          height={13}
          className="h-[13px] w-[13px] object-contain"
          aria-hidden="true"
        />
      </span>
      <span>{platform.label}</span>
      {platform.status === "beta" ? (
        <span className="adv-rail-badge" data-tone="beta">
          Beta
        </span>
      ) : soon ? (
        <span className="adv-rail-badge">Soon</span>
      ) : (
        <span className="adv-rail-dot" aria-label="Live" />
      )}
    </>
  );

  return (
    <>
      <Link
        href={soon ? `/platforms/${platform.id}` : scopedHref(platform.href)}
        className={cn(
          "adv-rail-item adv-rail-item--platform",
          hasChildren && "adv-rail-item--parent",
        )}
        data-active={parentActive}
        data-family={hasChildren ? familyActive : undefined}
        data-platform={platform.id}
        onClick={onNavigate}
        style={soon ? { opacity: 0.55 } : undefined}
      >
        {row}
      </Link>
      {hasChildren ? (
        <div className="adv-rail-children">
          {platform.children.map((child) => {
            const locked = isLocked(child.requiredPlan);
            const active = isRailLinkActive(child, pathname);
            const showCount =
              child.id === "pulse" && actionNowCount !== null && actionNowCount > 0;
            return (
              <Link
                key={child.id}
                href={scopedHref(child.href)}
                className="adv-rail-child"
                data-active={active}
                data-nav={`${platform.id}-${child.id}`}
                onClick={onNavigate}
                aria-disabled={locked || undefined}
                title={
                  locked && child.requiredPlan
                    ? `Upgrade to ${PLAN_LABELS[child.requiredPlan]} to unlock`
                    : undefined
                }
                style={locked ? LOCKED_ROW_STYLE : undefined}
              >
                <RailIcon icon={child.icon} size={15} />
                <span>{child.label}</span>
                {showCount ? (
                  <span
                    className="adv-rail-count"
                    title={`${actionNowCount} decisions in Action Now`}
                  >
                    {actionNowCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

export function AppRail({
  userName,
  open = false,
  onNavigate,
}: {
  userName: string;
  open?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "";
  const language = usePreferencesStore((state) => state.language);
  const model = getRailModel(language);
  const isLocked = useLocked();
  const plan = usePlan();
  const actionNowCount = useMetaActionNowCount();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);

  const scopedHref = (href: string) =>
    href.startsWith("/platforms/meta")
      ? buildMetaScopedHref(href, {
          businessId: selectedBusinessId,
          providerAccountId: null,
        })
      : href;

  return (
    <aside className="adv-rail" data-open={open} data-shell-sidebar="v2">
      <div className="adv-rail-head ad-console-brand">
        <span className="adv-rail-mark">
          <Image
            src="/adsecute-mark.svg"
            alt=""
            width={18}
            height={18}
            className="h-[18px] w-[18px] brightness-0 invert"
            aria-hidden="true"
          />
        </span>
        <span className="adv-rail-wordmark">Adsecute</span>
        <span className="adv-rail-version">v2</span>
      </div>

      <nav className="adv-rail-nav" aria-label="Primary">
        {model.home.map((link) => (
          <RailRow
            key={link.id}
            link={link}
            active={isRailLinkActive(link, pathname)}
            locked={isLocked(link.requiredPlan)}
            onNavigate={onNavigate}
          />
        ))}

        <div className="adv-rail-group ad-console-platform">{model.labels.platforms}</div>
        {model.platforms.map((platform) => (
          <PlatformBlock
            key={platform.id}
            platform={platform}
            pathname={pathname}
            onNavigate={onNavigate}
            actionNowCount={platform.id === "meta" ? actionNowCount : null}
            scopedHref={scopedHref}
          />
        ))}

        <div className="adv-rail-group">{model.labels.growth}</div>
        {model.growth.map((link) => (
          <RailRow
            key={link.id}
            link={link}
            active={isRailLinkActive(link, pathname)}
            locked={isLocked(link.requiredPlan)}
            onNavigate={onNavigate}
          />
        ))}

        <div className="adv-rail-group">{model.labels.workspace}</div>
        {model.workspace.map((link) => (
          <RailRow
            key={link.id}
            link={link}
            active={isRailLinkActive(link, pathname)}
            locked={isLocked(link.requiredPlan)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <RailAccount userName={userName} plan={plan} />
    </aside>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "–";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

function shortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[1]![0]}.`;
}

function RailAccount({ userName, plan }: { userName: string; plan: PlanId }) {
  const router = useRouter();

  async function handleSignOut() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Cache-Control": "no-store" },
    }).catch(() => null);
    if (!response?.ok) {
      logClientAuthEvent("logout_failed", { userName });
      return;
    }
    clearAuthScopedClientState();
    logClientAuthEvent("logout_completed", { userName });
    window.location.assign("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="adv-rail-foot" aria-label="Account menu">
          <span className="adv-rail-avatar">{initials(userName)}</span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-semibold text-[var(--adv-rail-ink)]">
              {shortName(userName)}
            </span>
            <span className="block text-[11px] text-[var(--adv-rail-ink-3)]">
              {PLAN_LABELS[plan]} plan
            </span>
          </span>
          <ChevronsUpDown
            className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--adv-rail-ink-3)]"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel className="text-sm font-medium">{userName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/settings")}>
          Settings &amp; billing
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/integrations")}>
          Integrations
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/select-business")}>
          Manage businesses
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onClick={handleSignOut}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
