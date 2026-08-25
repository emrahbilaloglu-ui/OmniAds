"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { carryDateWindowParams } from "@/lib/dashboard/date-window-url";
import {
  dashboardHrefForRouteFamily,
  normalizeDashboardPath,
} from "@/lib/dashboard-v2/screen-registry";
import { PLAN_LABELS, type PlanId } from "@/lib/pricing/plans";
import { usePlan } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";
import {
  getRailModel,
  isPlatformFamilyActive,
  isRailLinkActive,
  type RailLink,
  type RailPlatform,
} from "./nav-model";
import {
  useConfirmedShellBusinessId,
  useGoogleAdvisorCount,
  useMetaActionNowCount,
} from "./use-shell-signals";

const REFERENCE_RAIL_ICON_PATHS: Record<string, string> = {
  overview: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  "creative-studio":
    "M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
  launchpad:
    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0 M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
  automation:
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4",
  "google-overview": "M3 3v18h18 M7 16v-5 M12 16V8 M17 16v-3",
  "google-advisor": "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  "google-search": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  "google-products":
    "M20.59 13.41 12 22l-8.59-8.59A2 2 0 0 1 3 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.41.59L22 12z M7 7h.01",
  "google-assets":
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21",
  "google-plan":
    "M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  insights:
    "M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z",
  reports: "M21.21 15.89A10 10 0 1 1 8 2.83 M22 12A10 10 0 0 0 12 2v10z",
  "commercial-truth":
    "M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3 M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5",
  integrations:
    "M12 22v-5 M9 8V2 M15 8V2 M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};

function useLocked() {
  const currentPlan = usePlan();
  // Same business the rail's links and badges use, so entitlement cannot be
  // decided for one workspace while the links point at another.
  const confirmedBusinessId = useConfirmedShellBusinessId();
  const businesses = useAppStore((state) => state.businesses);
  const isDemo = isDemoBusinessSelected(confirmedBusinessId, businesses);
  return (requiredPlan?: PlanId) =>
    !isDemo &&
    requiredPlan !== undefined &&
    planRank(currentPlan) < planRank(requiredPlan);
}

export function buildRailScopedHref({
  href,
  pathname,
  businessId,
  providerAccountId,
}: {
  href: string;
  pathname: string;
  businessId: string | null;
  providerAccountId: string | null;
}) {
  const familyHref = dashboardHrefForRouteFamily(href, pathname);
  const currentPath = normalizeDashboardPath(pathname);
  const currentProvider =
    currentPath.startsWith("/platforms/meta") ||
    currentPath.startsWith("/app/meta") ||
    currentPath.startsWith("/app/creative")
      ? "meta"
      : currentPath.startsWith("/platforms/google") ||
          currentPath.startsWith("/app/google")
        ? "google"
        : null;
  if (href.startsWith("/platforms/meta")) {
    return buildMetaScopedHref(
      familyHref,
      {
        businessId,
        providerAccountId:
          currentProvider === "meta" ? providerAccountId : null,
      },
      currentProvider === "meta" ? {} : { providerAccountId: null },
    );
  }
  if (href.startsWith("/platforms/google")) {
    return buildMetaScopedHref(
      familyHref,
      {
        providerAccountId:
          currentProvider === "google" ? providerAccountId : null,
      },
      currentProvider === "google" ? {} : { providerAccountId: null },
    );
  }
  return familyHref;
}

function activateRailNavigation(
  event: KeyboardEvent<HTMLDivElement>,
  navigate: () => void,
) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  navigate();
}

function RailIcon({ link, size }: { link: RailLink; size: number }) {
  const referencePath = REFERENCE_RAIL_ICON_PATHS[link.id];
  if (!referencePath) {
    const Icon = link.icon;
    return <Icon style={{ width: size, height: size }} className="shrink-0" strokeWidth={2} />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <path d={referencePath} />
    </svg>
  );
}

function RailRow({
  link,
  href,
  lockedDestination,
  active,
  locked,
  onNavigate,
  className,
  iconSize = 16,
}: {
  link: RailLink;
  href: string;
  lockedDestination: string;
  active: boolean;
  locked: boolean;
  onNavigate?: () => void;
  className?: string;
  iconSize?: number;
}) {
  const router = useRouter();
  const navigate = () => {
    onNavigate?.();
    router.push(locked && link.requiredPlan ? lockedDestination : href);
  };

  return (
    <div
      role="link"
      tabIndex={0}
      className={cn("adv-rail-item", className)}
      data-active={active}
      data-nav={link.id}
      title={
        locked && link.requiredPlan
          ? `Upgrade to ${PLAN_LABELS[link.requiredPlan]} to unlock`
          : undefined
      }
      data-plan-entitlement-hint={
        locked && link.requiredPlan
          ? `Upgrade to ${PLAN_LABELS[link.requiredPlan]} to unlock`
          : undefined
      }
      onClick={navigate}
      onKeyDown={(event) => activateRailNavigation(event, navigate)}
    >
      <RailIcon link={link} size={iconSize} />
      <span>{link.label}</span>
    </div>
  );
}

function PlatformBlock({
  platform,
  pathname,
  onNavigate,
  counts,
  scopedHref,
}: {
  platform: RailPlatform;
  pathname: string;
  onNavigate?: () => void;
  counts: Readonly<Record<string, number | null>>;
  scopedHref: (href: string) => string;
}) {
  const router = useRouter();
  const navigateTo = (href: string) => {
    onNavigate?.();
    router.push(scopedHref(href));
  };
  const familyActive = isPlatformFamilyActive(platform, pathname);
  const hasChildren = platform.children.length > 0;
  // A platform with children uses the parent row purely as the family header —
  // the highlighted row is always the child the route resolves to.
  const parentActive = !hasChildren && familyActive;

  const row = (
    <>
      <span className="adv-rail-logo">
        <Image
          src={platform.logoSrc}
          alt={platform.label}
          width={13}
          height={13}
          unoptimized
          className="h-[13px] w-[13px] object-contain"
        />
      </span>
      <span>{platform.label}</span>
      {platform.status === "beta" ? (
        <span className="adv-rail-badge" data-tone="beta">
          Beta
        </span>
      ) : (
        <span className="adv-rail-dot" aria-label="Live" />
      )}
    </>
  );

  return (
    <>
      <div
        role="link"
        tabIndex={0}
        className={cn(
          "adv-rail-item adv-rail-item--platform",
          hasChildren && "adv-rail-item--parent",
        )}
        data-active={parentActive}
        data-family={hasChildren ? familyActive : undefined}
        data-platform={platform.id}
        onClick={() => navigateTo(platform.href)}
        onKeyDown={(event) =>
          activateRailNavigation(event, () => navigateTo(platform.href))
        }
      >
        {row}
      </div>
      {hasChildren ? (
        <div className="adv-rail-children">
          {platform.children.map((child) => {
            const active = isRailLinkActive(child, pathname);
            const count = counts[child.id] ?? null;
            const showCount = count !== null && count > 0;
            return (
              <div
                key={child.id}
                role="link"
                tabIndex={0}
                className="adv-rail-child"
                data-active={active}
                data-nav={`${platform.id}-${child.id}`}
                onClick={() => navigateTo(child.href)}
                onKeyDown={(event) =>
                  activateRailNavigation(event, () => navigateTo(child.href))
                }
              >
                <RailIcon link={child} size={15} />
                <span>{child.label}</span>
                {showCount ? (
                  <span className="adv-rail-count">{count}</span>
                ) : null}
              </div>
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
  onClose,
  narrow = false,
  returnFocusTo,
}: {
  userName: string;
  open?: boolean;
  onNavigate?: () => void;
  /** Asks the owner to close the drawer. Absent on the desktop rail. */
  onClose?: () => void;
  /** True when the rail is presenting as a drawer rather than as a rail. */
  narrow?: boolean;
  /** The control that opened it, so focus can be handed back. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const language = usePreferencesStore((state) => state.language);
  const isLocked = useLocked();
  const plan = usePlan();
  const actionNowCount = useMetaActionNowCount();
  const googleAdvisorCount = useGoogleAdvisorCount();
  /**
   * No rail link is minted from a business the shell has not confirmed.
   *
   * This read `selectedBusinessId` straight out of the persisted store. Between
   * localStorage rehydration and AuthBootstrap that is the *previous* session's
   * workspace, so every Meta link in the rail was stamped
   * `?businessId=<previous workspace>` while the switcher above already named
   * the current one — and following one of those links landed the operator on
   * the "This link names a different workspace" refusal. `null` mints no
   * parameter at all, which leaves the destination on the session's own
   * business instead of asserting a stale one.
   */
  const confirmedBusinessId = useConfirmedShellBusinessId();
  const currentProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  useBusinessIntegrationsBootstrap(confirmedBusinessId, {
    providers: ["klaviyo"],
  });
  const klaviyoDomain = useIntegrationsStore((state) =>
    confirmedBusinessId
      ? state.domainsByBusinessId[confirmedBusinessId]?.klaviyo
      : undefined,
  );
  /**
   * design 3284 / 2864 / 4321: Klaviyo joins the rail only once it is live —
   * "these stay out of the sidebar until the integration is live". The only
   * evidence for that is a stored connection that has actually synced. Being on
   * the Klaviyo route is not evidence, so it does not put the entry back.
   */
  const klaviyoSnapshotReady = Boolean(
    klaviyoDomain?.connection.status === "connected" &&
    klaviyoDomain.connection.lastSyncAt,
  );
  const model = getRailModel(language, { showKlaviyo: klaviyoSnapshotReady });

  // A window stated on this URL travels with the navigation. A server-rendered
  // surface cannot read the shell's stored range, so without this the operator
  // picks a window, follows a rail link, and the next screen answers for a
  // different one while the control above it still names theirs.
  const scopedHref = (href: string) =>
    carryDateWindowParams(
      buildRailScopedHref({
        href,
        pathname,
        businessId: confirmedBusinessId,
        providerAccountId: currentProviderAccountId,
      }),
      searchParams,
    );
  const lockedDestination = scopedHref("/settings");

  /**
   * Keep Tab inside the drawer, close on Escape, and hand focus back.
   *
   * The rail is a `position: fixed` panel below 1023px and nothing was holding
   * either end of that: Tab walked straight out onto the page behind it, and
   * closing left focus on `<body>` so the next Tab restarted at the top of the
   * document. This is the same contract `CommandPalette` now honours, for the
   * same reason — the zero-base shell's drawer gets it from a dialog primitive,
   * and the shell every route actually renders has to be given it.
   */
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!narrow || !open) return;
    const first = railRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const panel = railRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;
      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null || node === document.activeElement);
      if (stops.length === 0) return;
      const head = stops[0]!;
      const tail = stops[stops.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
        return;
      }
      if (event.shiftKey && active === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Back to the control that opened it, but only if focus is still inside
      // the drawer: a navigation that closed it has already moved on.
      const opener = returnFocusTo?.current;
      const active = document.activeElement;
      if (opener && (!active || active === document.body || railRef.current?.contains(active))) {
        opener.focus();
      }
    };
  }, [narrow, open, onClose, returnFocusTo]);

  return (
    // Named: a page body may carry its own complementary aside, and two
    // unnamed ones are indistinguishable in a landmark list.
    <aside
      ref={railRef}
      className="adv-rail"
      aria-label="Workspace navigation"
      data-open={open}
      data-shell-sidebar="v2"
      /*
       * A drawer, when it is one.
       *
       * Below 1023px the rail is `position: fixed` and translated off-screen by
       * `transform` — which hides it from the eye and from nothing else. A
       * closed drawer stayed in the tab order, so a keyboard user on a phone
       * tabbed through every product, module and sub-item of an invisible
       * panel before reaching the page. `inert` takes it out of the tab order,
       * the accessibility tree and pointer events in one attribute, and only
       * while it is both narrow and closed.
       */
      {...(narrow && !open ? { inert: true } : {})}
      {...(narrow && open
        ? { role: "dialog" as const, "aria-modal": true as const }
        : {})}
    >
      <div className="adv-rail-head">
        <span className="adv-rail-mark">
          <Image
            src="/adsecute-mark.svg"
            alt="Adsecute"
            width={18}
            height={18}
            className="h-[18px] w-[18px] brightness-0 invert"
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
            href={scopedHref(link.href)}
            lockedDestination={lockedDestination}
            active={isRailLinkActive(link, pathname)}
            locked={isLocked(link.requiredPlan)}
            onNavigate={onNavigate}
          />
        ))}

        <div className="adv-rail-group">{model.labels.platforms}</div>
        {model.platforms.map((platform) => (
          <PlatformBlock
            key={platform.id}
            platform={platform}
            pathname={pathname}
            onNavigate={onNavigate}
            counts={
              platform.id === "meta"
                ? { pulse: actionNowCount }
                : platform.id === "google"
                  ? { "google-advisor": googleAdvisorCount }
                  : {}
            }
            scopedHref={scopedHref}
          />
        ))}

        <div className="adv-rail-group">{model.labels.growth}</div>
        {model.growth.map((link) => (
          <RailRow
            key={link.id}
            link={link}
            href={scopedHref(link.href)}
            lockedDestination={lockedDestination}
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
            href={scopedHref(link.href)}
            lockedDestination={lockedDestination}
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
  return (
    <div className="adv-rail-foot">
      <span className="adv-rail-avatar">{initials(userName)}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold text-[var(--adv-rail-ink)]">
          {shortName(userName)}
        </span>
        <span className="block text-[11px] text-[var(--adv-rail-ink-3)]">
          {PLAN_LABELS[plan]} plan
        </span>
      </span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="#747c8b"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ml-auto h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      >
        <path d="M7 15l5 5 5-5 M7 9l5-5 5 5" />
      </svg>
    </div>
  );
}
