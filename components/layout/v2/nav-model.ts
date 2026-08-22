import type { LucideIcon } from "lucide-react";
import type { AppLanguage } from "@/lib/i18n";
import { getTranslations } from "@/lib/i18n";
import type { PlanId } from "@/lib/pricing/plans";
import {
  dashboardHrefForRouteFamily,
  dashboardScreenForPath,
  normalizeDashboardPath,
} from "@/lib/dashboard-v2/screen-registry";
import {
  getLayer1Items,
  getLayer3Items,
  getPlatformLayer2Items,
  platformsRegistry,
  type PlatformId,
  type PlatformStatus,
  type ShellNavItem,
} from "@/components/layout/nav-items";

/**
 * Dashboard v2 sidebar model (design decision D2): a single rail that groups the
 * whole route inventory into HOME / PLATFORMS / GROWTH / WORKSPACE, with the
 * platform switcher inlined as an expandable tree instead of a topbar control.
 *
 * The route inventory itself stays owned by `nav-items.ts` so both models agree
 * on hrefs, plan gates and active-route matching.
 */

export interface RailLink {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  requiredPlan?: PlanId;
  activeHrefs?: string[];
  exact?: boolean;
}

export interface RailPlatform {
  id: PlatformId;
  label: string;
  href: string;
  logoSrc: string;
  status: PlatformStatus;
  /** Rendered as the nested child tree under the platform row. */
  children: RailLink[];
  /** Every route that should light the platform row up. */
  routePrefix: string;
}

export interface RailModel {
  home: RailLink[];
  platforms: RailPlatform[];
  growth: RailLink[];
  workspace: RailLink[];
  labels: { platforms: string; growth: string; workspace: string };
}

function toRailLink(item: ShellNavItem): RailLink {
  return {
    id: item.id,
    label: item.label,
    href: item.href,
    icon: item.icon,
    requiredPlan: item.requiredPlan,
    activeHrefs: item.activeHrefs,
    exact: item.exact,
  };
}

/**
 * Meta is the only platform the design draws expanded, because it is the only
 * one with a Layer-2 inventory deep enough to need a tree. Every other platform
 * renders as a single row that opens its own first surface.
 */
/** Platforms the design renders with their sub-navigation always open in the rail. */
const EXPANDED_PLATFORMS: PlatformId[] = ["meta", "google"];

export function getRailModel(language: AppLanguage, options: { showKlaviyo?: boolean } = {}): RailModel {
  const t = getTranslations(language).navigation;
  const layer1 = getLayer1Items(language);
  const layer3 = getLayer3Items(language);

  const home = layer1.filter((item) => item.id === "overview").map(toRailLink);
  const growth = ["insights", "reports", "commercial-truth"]
    .map((id) => layer1.find((item) => item.id === id))
    .filter((item): item is ShellNavItem => Boolean(item))
    .map(toRailLink);

  const visiblePlatformIds: PlatformId[] = [
    "meta",
    "google",
    ...(options.showKlaviyo ? (["klaviyo"] as PlatformId[]) : []),
  ];
  const platforms: RailPlatform[] = visiblePlatformIds.map((platformId) => {
    const registry = platformsRegistry[platformId];
    const layer2 = getPlatformLayer2Items(platformId, language);
    const expanded = EXPANDED_PLATFORMS.includes(platformId);
    return {
      id: platformId,
      label: registry.name,
      href: layer2[0]?.href ?? `/platforms/${platformId}`,
      logoSrc: registry.logoSrc,
      status: registry.status,
      children: expanded ? layer2.map(toRailLink) : [],
      routePrefix: `/platforms/${platformId}`,
    };
  });

  return {
    home,
    platforms,
    growth,
    workspace: layer3.map(toRailLink),
    labels: {
      platforms: t.platforms,
      growth: t.growth,
      workspace: t.workspace,
    },
  };
}

export function isRailLinkActive(link: RailLink, pathname: string) {
  if (
    link.id === "insights" &&
    dashboardScreenForPath(pathname)?.screen === "insights"
  ) {
    return true;
  }
  const current = normalizeDashboardPath(pathname);
  const candidates = [link.href, ...(link.activeHrefs ?? [])].map((href) =>
    normalizeDashboardPath(dashboardHrefForRouteFamily(href, pathname)),
  );
  if (link.exact) return candidates.some((href) => current === href);
  return candidates.some(
    (href) => current === href || current.startsWith(`${href}/`),
  );
}

export function isPlatformFamilyActive(platform: RailPlatform, pathname: string) {
  const screen = dashboardScreenForPath(pathname)?.screen;
  if (platform.id === "meta" && screen) {
    // The design's own `metaFam` is the first four; the vendored leaf ledger
    // also carries L-C-META-INTEL and L-C-META-HIST, which is what D3 follows.
    // Leaving them out here meant the whole Meta group collapsed to inactive
    // the moment an operator opened either one — the rail claimed they had left
    // Meta while they were reading a Meta surface.
    return [
      "meta",
      "meta-intelligence",
      "creative",
      "launchpad",
      "automation",
      "meta-history",
    ].includes(screen);
  }
  if (platform.id === "google" && screen) return screen.startsWith("google");
  if (platform.id === "klaviyo" && screen) return screen === "klaviyo";
  const current = normalizeDashboardPath(pathname);
  const prefix = normalizeDashboardPath(
    dashboardHrefForRouteFamily(platform.routePrefix, pathname),
  );
  return current === prefix || current.startsWith(`${prefix}/`);
}

/** Flattened jump targets for the ⌘K palette. */
export function getRailJumpTargets(model: RailModel) {
  const targets: Array<{ id: string; label: string; href: string; group: string; icon?: LucideIcon }> = [];
  for (const link of model.home) {
    targets.push({ ...link, group: "Home" });
  }
  for (const platform of model.platforms) {
    if (platform.status === "soon") continue;
    targets.push({
      id: `platform-${platform.id}`,
      label: platform.label,
      href: platform.href,
      group: model.labels.platforms,
    });
    for (const child of platform.children) {
      targets.push({
        ...child,
        id: `${platform.id}-${child.id}`,
        label: `${platform.label} · ${child.label}`,
        group: model.labels.platforms,
      });
    }
  }
  for (const link of model.growth) {
    targets.push({ ...link, group: model.labels.growth });
  }
  for (const link of model.workspace) {
    targets.push({ ...link, group: model.labels.workspace });
  }
  return targets;
}
