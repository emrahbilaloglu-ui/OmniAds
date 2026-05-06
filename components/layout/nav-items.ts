import {
  LayoutDashboard,
  Target,
  Facebook,
  Search,
  Music2,
  Image,
  Ghost,
  Palette,
  Mail,
  Globe,
  FileText,
  BarChart3,
  LineChart,
  BrainCircuit,
  SearchCheck,
  Plug,
  Users,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { PlanId } from "@/lib/pricing/plans";
import type { AppLanguage } from "@/lib/i18n";
import { getTranslations } from "@/lib/i18n";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  group?: string;
  requiredPlan?: PlanId;
}

export function getNavItems(language: AppLanguage): NavItem[] {
  const t = getTranslations(language).navigation;
  return [
    { label: t.overview, href: "/overview", icon: LayoutDashboard, group: "Main" },
    { label: t.commercialTruth, href: "/commercial-truth", icon: Target, group: "Main", requiredPlan: "growth" },
    { label: t.meta, href: "/platforms/meta", icon: Facebook, group: "Platforms", requiredPlan: "growth" },
    { label: t.googleAds, href: "/google-ads", icon: Search, group: "Platforms", requiredPlan: "growth" },
    { label: t.tikTok, href: "/platforms/tiktok", icon: Music2, group: "Platforms", requiredPlan: "pro" },
    { label: t.pinterest, href: "/platforms/pinterest", icon: Image, group: "Platforms", requiredPlan: "pro" },
    { label: t.snapchat, href: "/platforms/snapchat", icon: Ghost, group: "Platforms", requiredPlan: "pro" },
    { label: t.klaviyo, href: "/platforms/klaviyo", icon: Mail, group: "Platforms", requiredPlan: "pro" },
    { label: t.analytics, href: "/analytics", icon: LineChart, group: "Platforms", requiredPlan: "growth" },
    { label: t.geoIntelligence, href: "/geo-intelligence", icon: BrainCircuit, group: "Platforms", requiredPlan: "pro" },
    { label: t.seoIntelligence, href: "/seo-intelligence", icon: SearchCheck, group: "Platforms", requiredPlan: "pro" },
    { label: t.creatives, href: "/creatives", icon: Palette, group: "Assets", requiredPlan: "growth" },
    { label: t.landingPages, href: "/landing-pages", icon: Globe, group: "Assets", requiredPlan: "growth" },
    { label: t.copies, href: "/copies", icon: FileText, group: "Assets", requiredPlan: "growth" },
    { label: t.reports, href: "/reports", icon: BarChart3, group: "Manage", requiredPlan: "pro" },
    { label: t.integrations, href: "/integrations", icon: Plug, group: "Manage" },
    { label: t.team, href: "/team", icon: Users, group: "Manage", requiredPlan: "scale" },
    { label: t.settings, href: "/settings", icon: Settings, group: "Manage" },
  ];
}
