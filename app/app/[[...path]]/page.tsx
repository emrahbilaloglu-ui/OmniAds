import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>> | undefined;
type PageProps = {
  params: Promise<{ path?: string[] }>;
  searchParams?: Search;
};

type RoutedPage = (props: {
  params: Promise<Record<string, string>>;
  searchParams?: Search;
}) => React.ReactNode | Promise<React.ReactNode>;

const pages = {
  home: () => import("@/app/c/[businessId]/home/page"),
  "meta/decisions": () => import("@/app/c/[businessId]/meta/decisions/page"),
  "meta/intelligence": () => import("@/app/c/[businessId]/meta/intelligence/page"),
  "meta/launchpad": () => import("@/app/c/[businessId]/meta/launchpad/page"),
  "meta/automation": () => import("@/app/c/[businessId]/meta/automation/page"),
  "meta/history": () => import("@/app/c/[businessId]/meta/history/page"),
  "creative/performance": () => import("@/app/c/[businessId]/creative/performance/page"),
  "creative/briefs": () => import("@/app/c/[businessId]/creative/briefs/page"),
  "creative/inbox": () => import("@/app/c/[businessId]/creative/inbox/page"),
  "creative/copies": () => import("@/app/c/[businessId]/creative/copies/page"),
  "creative/landing-pages": () => import("@/app/c/[businessId]/creative/landing-pages/page"),
  "creative/shares": () => import("@/app/c/[businessId]/creative/shares/page"),
  "google/overview": () => import("@/app/c/[businessId]/google/overview/page"),
  "google/advisor": () => import("@/app/c/[businessId]/google/advisor/page"),
  "google/search": () => import("@/app/c/[businessId]/google/search/page"),
  "google/products": () => import("@/app/c/[businessId]/google/products/page"),
  "google/assets-audiences": () => import("@/app/c/[businessId]/google/assets-audiences/page"),
  "google/plan": () => import("@/app/c/[businessId]/google/plan/page"),
  "analytics/ga4-shopify": () => import("@/app/c/[businessId]/analytics/ga4-shopify/page"),
  "analytics/landing-pages": () => import("@/app/c/[businessId]/analytics/landing-pages/page"),
  "analytics/seo": () => import("@/app/c/[businessId]/analytics/seo/page"),
  "analytics/geo": () => import("@/app/c/[businessId]/analytics/geo/page"),
  reports: () => import("@/app/c/[businessId]/reports/page"),
  "reports/new": () => import("@/app/c/[businessId]/reports/new/page"),
  "manage/integrations": () => import("@/app/c/[businessId]/manage/integrations/page"),
  "manage/team": () => import("@/app/c/[businessId]/manage/team/page"),
  "manage/business": () => import("@/app/c/[businessId]/manage/business/page"),
  "manage/plan": () => import("@/app/c/[businessId]/manage/plan/page"),
};

export default async function SessionScopedPage({ params, searchParams }: PageProps) {
  const session = await getSessionFromCookies();
  if (!session) redirect(`/login?next=${encodeURIComponent("/app/home")}`);
  if (!session.activeBusinessId) redirect("/select-business");

  const segments = (await params).path ?? ["home"];
  const path = segments.join("/") || "home";
  const businessId = session.activeBusinessId;

  const exact = pages[path as keyof typeof pages];
  if (exact) {
    const Page = (await exact()).default as unknown as RoutedPage;
    return Page({ params: Promise.resolve({ businessId }), searchParams });
  }

  if (segments[0] === "creative" && segments.length === 2) {
    const Page = (await import("@/app/c/[businessId]/creative/[creativeId]/page")).default as RoutedPage;
    return Page({
      params: Promise.resolve({ businessId, creativeId: segments[1]! }),
      searchParams,
    });
  }

  if (segments[0] === "reports" && segments[1] && segments.length <= 3) {
    const reportId = segments[1];
    if (segments.length === 2) {
      const Page = (await import("@/app/c/[businessId]/reports/[reportId]/page")).default as RoutedPage;
      return Page({ params: Promise.resolve({ businessId, reportId }), searchParams });
    }
    if (segments[2] === "edit") {
      const Page = (await import("@/app/c/[businessId]/reports/[reportId]/edit/page")).default as RoutedPage;
      return Page({ params: Promise.resolve({ businessId, reportId }), searchParams });
    }
    if (segments[2] === "print") {
      const Page = (await import("@/app/c/[businessId]/reports/[reportId]/print/page")).default as RoutedPage;
      return Page({ params: Promise.resolve({ businessId, reportId }), searchParams });
    }
  }

  if (
    segments[0] === "manage" &&
    segments[1] === "integrations" &&
    segments[2] === "callback" &&
    segments[3]
  ) {
    const Page = (await import("@/app/c/[businessId]/manage/integrations/callback/[provider]/page")).default as unknown as RoutedPage;
    return Page({
      params: Promise.resolve({ businessId, provider: segments[3] }),
      searchParams,
    });
  }

  notFound();
}
