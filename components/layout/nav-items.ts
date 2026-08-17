import {
  Activity,
  ClipboardList,
  Database,
  Home,
  Layers,
  Lightbulb,
  Package,
  PieChart,
  Plug,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PlanId } from "@/lib/pricing/plans";
import type { AppLanguage } from "@/lib/i18n";
import { getTranslations } from "@/lib/i18n";

export type ShellLayer = "L1" | "L2" | "L3";
export type PlatformId =
  "meta" | "klaviyo" | "google" | "tiktok" | "pinterest" | "snapchat";
export type PlatformStatus = "live" | "beta" | "soon";
export type PlatformAccent = "blue" | "violet" | "emerald" | "slate";
export type Layer2SubStatus = "coming" | "soon";

export interface ShellNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  requiredPlan?: PlanId;
  badge?: number | string;
  subStatus?: Layer2SubStatus;
  activeHrefs?: string[];
  exact?: boolean;
  group?: string;
}

export interface PlatformRegistryItem {
  id: PlatformId;
  name: string;
  status: PlatformStatus;
  accent: PlatformAccent;
  logoSrc: string;
}

export const platformOrder: PlatformId[] = [
  "meta",
  "klaviyo",
  "google",
  "tiktok",
  "pinterest",
  "snapchat",
];

export const platformsRegistry: Record<PlatformId, PlatformRegistryItem> = {
  meta: {
    id: "meta",
    name: "Meta",
    status: "live",
    accent: "blue",
    logoSrc: "/platform-logos/Meta.png",
  },
  // Registry metadata only — the design's BETA badge and logo. Whether Klaviyo
  // appears in the rail at all is decided by `getRailModel`'s `showKlaviyo`,
  // which the shell drives from the stored connection (design 3284).
  klaviyo: {
    id: "klaviyo",
    name: "Klaviyo",
    status: "beta",
    accent: "violet",
    logoSrc: "/platform-logos/Klaviyo.svg",
  },
  google: {
    id: "google",
    name: "Google Ads",
    status: "live",
    accent: "emerald",
    logoSrc: "/platform-logos/googleAds.svg",
  },
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    status: "soon",
    accent: "slate",
    logoSrc: "/platform-logos/tiktok.svg",
  },
  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    status: "soon",
    accent: "slate",
    logoSrc: "/platform-logos/Pinterest.svg",
  },
  snapchat: {
    id: "snapchat",
    name: "Snapchat",
    status: "soon",
    accent: "slate",
    logoSrc: "/platform-logos/snapchat.svg",
  },
};

export function getLayer1Items(language: AppLanguage): ShellNavItem[] {
  const t = getTranslations(language).navigation;
  return [
    {
      id: "overview",
      label: t.overview,
      href: "/overview",
      icon: Home,
      group: "Workspace",
    },
    {
      id: "reports",
      label: t.reports,
      href: "/reports",
      icon: PieChart,
      group: "Workspace",
      requiredPlan: "pro",
    },
    {
      id: "commercial-truth",
      label: t.commercialTruth,
      href: "/commercial-truth",
      icon: Database,
      group: "Workspace",
      requiredPlan: "growth",
    },
    {
      id: "insights",
      label: t.insights,
      href: "/insights/analytics",
      icon: Sparkles,
      group: "Workspace",
      requiredPlan: "pro",
      activeHrefs: [
        "/insights",
        "/insights/analytics",
        "/insights/ai-visibility",
        "/insights/seo",
      ],
    },
  ];
}

export function getPlatformLayer2Items(
  platformId: PlatformId,
  language: AppLanguage,
): ShellNavItem[] {
  const t = getTranslations(language).navigation;
  switch (platformId) {
    case "meta":
      return [
        {
          id: "pulse",
          label: t.pulse,
          href: "/platforms/meta",
          icon: Activity,
          exact: true,
          activeHrefs: ["/platforms/meta/history"],
        },
        {
          id: "creative-studio",
          label: t.creativeStudio,
          href: "/platforms/meta/creatives",
          icon: Layers,
          activeHrefs: [
            "/platforms/meta/copies",
            "/platforms/meta/landing-pages",
            "/platforms/meta/creative-inbox",
            "/platforms/meta/audiences",
          ],
        },
        {
          id: "launchpad",
          label: t.launchpad,
          href: "/platforms/meta/launchpad",
          icon: Rocket,
        },
        {
          id: "automation",
          label: t.automation,
          href: "/platforms/meta/automation",
          icon: ShieldCheck,
        },
      ];
    case "klaviyo":
      // One screen, no Layer-2. The design's four Klaviyo pills are decoration
      // inside the single Lifecycle screen — they carry no handler and no route,
      // so there is nothing here to navigate to.
      return [];
    case "google":
      // Google Ads is a routed workspace in v2: the design gives each analysis
      // surface its own screen and rail entry, mirroring the Meta platform block.
      return [
        {
          id: "google-overview",
          label: "Overview",
          href: "/platforms/google",
          icon: Activity,
          activeHrefs: ["/platforms/google", "/platforms/google/pulse"],
          exact: true,
        },
        {
          id: "google-advisor",
          label: "Advisor",
          href: "/platforms/google/advisor",
          icon: Lightbulb,
        },
        {
          id: "google-search",
          label: "Search",
          href: "/platforms/google/search",
          icon: Search,
          activeHrefs: ["/platforms/google/keywords"],
        },
        {
          id: "google-products",
          label: "Products",
          href: "/platforms/google/products",
          icon: Package,
        },
        {
          id: "google-assets",
          label: "Assets & Audiences",
          href: "/platforms/google/assets",
          icon: Layers,
          activeHrefs: ["/platforms/google/audiences"],
        },
        {
          id: "google-plan",
          label: "Plan & Activity",
          href: "/platforms/google/plan",
          icon: ClipboardList,
          activeHrefs: ["/platforms/google/launchpad"],
        },
      ];
    case "tiktok":
    case "pinterest":
    case "snapchat":
      return [];
  }
}

export function getLayer3Items(language: AppLanguage): ShellNavItem[] {
  const t = getTranslations(language).navigation;
  return [
    {
      id: "integrations",
      label: t.integrations,
      href: "/integrations",
      icon: Plug,
      group: "Manage",
    },
    {
      id: "team",
      label: t.team,
      href: "/team",
      icon: Users,
      group: "Manage",
      requiredPlan: "scale",
    },
    {
      id: "settings",
      label: t.settings,
      href: "/settings",
      icon: Settings,
      group: "Manage",
    },
  ];
}

export function getPlatformFirstHref(
  platformId: PlatformId,
  language: AppLanguage = "en",
) {
  return (
    getPlatformLayer2Items(platformId, language)[0]?.href ??
    `/platforms/${platformId}`
  );
}

export function getAllShellNavItems(language: AppLanguage): ShellNavItem[] {
  return [
    ...getLayer1Items(language),
    ...platformOrder.flatMap((platformId) =>
      getPlatformLayer2Items(platformId, language),
    ),
    ...getLayer3Items(language),
  ];
}

export function getNavItems(language: AppLanguage): ShellNavItem[] {
  return getAllShellNavItems(language);
}
