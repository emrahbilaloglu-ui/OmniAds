import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { resolveCanonicalFallback } from "@/lib/zero-base/canonical-fallback";
import { readZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";
import { RolledBackSurface } from "@/components/zero-base/rolled-back-surface";

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
  "creative/audiences": () => import("@/app/c/[businessId]/creative/audiences/page"),
  "creative/shares": () => import("@/app/c/[businessId]/creative/shares/page"),
  "google/overview": () => import("@/app/c/[businessId]/google/overview/page"),
  "google/advisor": () => import("@/app/c/[businessId]/google/advisor/page"),
  "google/search": () => import("@/app/c/[businessId]/google/search/page"),
  "google/products": () => import("@/app/c/[businessId]/google/products/page"),
  "google/assets-audiences": () => import("@/app/c/[businessId]/google/assets-audiences/page"),
  "google/plan": () => import("@/app/c/[businessId]/google/plan/page"),
  klaviyo: () => import("@/app/c/[businessId]/klaviyo/page"),
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

/**
 * The query string, rebuilt for the one hop the rollback may take.
 *
 * A rolled-back workspace should land on the legacy screen looking at the same
 * thing it asked for — the same window, the same filter — so the search travels
 * with it. Repeated keys are preserved: `?kind=a&kind=b` is two values, and
 * flattening it would change the question.
 */
function serializeSearch(
  raw: Record<string, string | string[] | undefined> | undefined,
): string {
  if (!raw) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params.toString();
}

export default async function SessionScopedPage({ params, searchParams }: PageProps) {
  const session = await getSessionFromCookies();
  if (!session) redirect(`/login?next=${encodeURIComponent("/app/home")}`);
  if (!session.activeBusinessId) redirect("/select-business");

  const segments = (await params).path ?? ["home"];
  const path = segments.join("/") || "home";
  const businessId = session.activeBusinessId;

  /**
   * The rollback lever, applied where BOTH families pass through.
   *
   * `/c/:businessId/**` is rewritten into `/app/**` by
   * `resolvePublicRouteRedirect` before any page renders, so this dispatcher is
   * the one place that sees every request to the canonical UI. Deciding here
   * means `/c` and `/app` cannot disagree about the rollout mode, and it needs
   * no second router: `resolveCanonicalFallback` inverts the table
   * `compatibility.ts` already owns.
   *
   * Ordered AFTER the session and the active business are resolved, because the
   * allowlist decision needs a business and because a redirect that ran first
   * would answer "does this business exist" with a `Location` header. Ordered
   * BEFORE dispatch, so a rolled-back workspace never renders a canonical body
   * at all.
   *
   * Nothing here grants anything. Every page below still performs its own
   * authorization, and the legacy destination performs its own.
   */
  const rollout = readZeroBaseRolloutConfig();
  const search = serializeSearch(await searchParams);
  const rollback = (appTemplatePath: string, routeParams?: Record<string, string>) =>
    resolveCanonicalFallback({
      appPath: appTemplatePath,
      config: rollout,
      businessId,
      params: routeParams,
      search,
    });

  const exact = pages[path as keyof typeof pages];
  if (exact) {
    const fallback = rollback(path);
    if (fallback.kind === "legacy") redirect(fallback.destination);
    if (fallback.kind === "rolled-back") {
      return <RolledBackSurface appPath={path} reason={fallback.reason} />;
    }
    const Page = (await exact()).default as unknown as RoutedPage;
    return Page({ params: Promise.resolve({ businessId }), searchParams });
  }

  if (segments[0] === "creative" && segments.length === 2) {
    const fallback = rollback("creative/[creativeId]", { creativeId: segments[1]! });
    if (fallback.kind === "legacy") redirect(fallback.destination);
    if (fallback.kind === "rolled-back") {
      return <RolledBackSurface appPath="creative/[creativeId]" reason={fallback.reason} />;
    }
    const Page = (await import("@/app/c/[businessId]/creative/[creativeId]/page")).default as RoutedPage;
    return Page({
      params: Promise.resolve({ businessId, creativeId: segments[1]! }),
      searchParams,
    });
  }

  if (segments[0] === "reports" && segments[1] && segments.length <= 3) {
    const reportId = segments[1];
    const template =
      segments.length === 2
        ? "reports/[reportId]"
        : `reports/[reportId]/${segments[2]}`;
    const fallback = rollback(template, { reportId });
    if (fallback.kind === "legacy") redirect(fallback.destination);
    if (fallback.kind === "rolled-back") {
      return <RolledBackSurface appPath={template} reason={fallback.reason} />;
    }
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
    const fallback = rollback("manage/integrations/callback/[provider]", {
      provider: segments[3],
    });
    if (fallback.kind === "legacy") redirect(fallback.destination);
    if (fallback.kind === "rolled-back") {
      return (
        <RolledBackSurface
          appPath="manage/integrations/callback/[provider]"
          reason={fallback.reason}
        />
      );
    }
    const Page = (await import("@/app/c/[businessId]/manage/integrations/callback/[provider]/page")).default as unknown as RoutedPage;
    return Page({
      params: Promise.resolve({ businessId, provider: segments[3] }),
      searchParams,
    });
  }

  notFound();
}
