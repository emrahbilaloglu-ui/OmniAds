import {
  Activity,
  Database,
  FileText,
  Globe,
  Home,
  Layers,
  Megaphone,
  PieChart,
  Plug,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PlanId } from "@/lib/pricing/plans";
import type { AppLanguage } from "@/lib/i18n";
import { getTranslations } from "@/lib/i18n";

export type ShellLayer = "L1" | "L2" | "L3";
export type PlatformId =
  | "meta"
  | "klaviyo"
  | "google"
  | "tiktok"
  | "pinterest"
  | "snapchat";
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
    status: "beta",
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
    { id: "overview", label: t.overview, href: "/overview", icon: Home, group: "Workspace" },
    { id: "reports", label: t.reports, href: "/reports", icon: PieChart, group: "Workspace", requiredPlan: "pro" },
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
      activeHrefs: ["/insights", "/insights/analytics", "/insights/ai-visibility", "/insights/seo"],
    },
  ];
}

export function getPlatformLayer2Items(
  platformId: PlatformId,
  language: AppLanguage
): ShellNavItem[] {
  const t = getTranslations(language).navigation;
  switch (platformId) {
    case "meta":
      return [
        { id: "pulse", label: t.pulse, href: "/platforms/meta", icon: Activity, exact: true },
        { id: "creatives", label: t.creatives, href: "/platforms/meta/creatives", icon: Layers },
        { id: "copies", label: t.copies, href: "/platforms/meta/copies", icon: FileText },
        {
          id: "landing-pages",
          label: t.landingPages,
          href: "/platforms/meta/landing-pages",
          icon: Globe,
        },
        { id: "launchpad", label: t.launchpad, href: "/platforms/meta/launchpad", icon: Rocket },
        {
          id: "audiences",
          label: t.audiences,
          href: "/platforms/meta/audiences",
          icon: Target,
          subStatus: "soon",
        },
      ];
    case "klaviyo":
      return [
        { id: "flows", label: t.flows, href: "/platforms/klaviyo/flows", icon: Activity },
        { id: "campaigns", label: t.campaigns, href: "/platforms/klaviyo/campaigns", icon: Megaphone },
        { id: "templates", label: t.templates, href: "/platforms/klaviyo/templates", icon: Layers },
        { id: "segments", label: t.segments, href: "/platforms/klaviyo/segments", icon: Target },
      ];
    case "google":
      return [
        {
          id: "pulse",
          label: t.pulse,
          href: "/platforms/google",
          icon: Activity,
          activeHrefs: ["/platforms/google", "/platforms/google/pulse"],
          exact: true,
        },
        {
          id: "launchpad",
          label: t.launchpad,
          href: "/platforms/google/launchpad",
          icon: Rocket,
        },
        { id: "ads", label: t.ads, href: "/platforms/google/ads", icon: Layers },
        {
          id: "keywords",
          label: t.keywords,
          href: "/platforms/google/keywords",
          icon: Search,
          subStatus: "soon",
        },
        {
          id: "audiences",
          label: t.audiences,
          href: "/platforms/google/audiences",
          icon: Target,
          subStatus: "soon",
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
    { id: "integrations", label: t.integrations, href: "/integrations", icon: Plug, group: "Manage" },
    { id: "team", label: t.team, href: "/team", icon: Users, group: "Manage", requiredPlan: "scale" },
    { id: "settings", label: t.settings, href: "/settings", icon: Settings, group: "Manage" },
  ];
}

export function getPlatformFirstHref(platformId: PlatformId, language: AppLanguage = "en") {
  return getPlatformLayer2Items(platformId, language)[0]?.href ?? `/platforms/${platformId}`;
}

export function getAllShellNavItems(language: AppLanguage): ShellNavItem[] {
  return [
    ...getLayer1Items(language),
    ...platformOrder.flatMap((platformId) => getPlatformLayer2Items(platformId, language)),
    ...getLayer3Items(language),
  ];
}

export function getNavItems(language: AppLanguage): ShellNavItem[] {
  return getAllShellNavItems(language);
}
