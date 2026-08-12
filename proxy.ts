import { NextRequest, NextResponse } from "next/server";

import { isPublicPagePath } from "@/lib/public-page-prefixes";
import { resolvePublicRouteRedirect } from "@/lib/zero-base/public-routes";

const AUTH_COOKIE = "omniads_session";
const LANGUAGE_COOKIE = "adsecute_locale";

const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/demo-login",
  "/api/auth/password-reset",
  "/api/build-info",
  "/api/healthz",
  "/api/release-authority",
  "/api/invite",
  "/api/webhooks/shopify",
  "/api/ai/cron",
  "/api/sync/cron",
  "/api/oauth/sign-with-google",
  "/api/oauth/sign-with-facebook",
  "/api/oauth/shopify/callback",
  "/api/oauth/shopify/context",
  "/api/oauth/shopify/start",
];

const INTERNAL_CRON_SECRET_API_PREFIXES = [
  "/api/sync/refresh",
] as const;

const CREATIVE_SHARE_PAGE_PREFIX = "/share/creative/";
const CREATIVE_SHARE_API_PREFIX = "/api/creatives/share/";

function getBearerToken(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

// One list, shared with the compatibility layer: a legacy path that is public
// here must stay public when the canonical UI is switched on.
const isPublicPage = isPublicPagePath;

function isPublicCreativeShareRead(request: NextRequest): boolean {
  if (request.method !== "GET") return false;
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith(CREATIVE_SHARE_API_PREFIX)) return false;
  const token = pathname.slice(CREATIVE_SHARE_API_PREFIX.length);
  return Boolean(token) && !token.includes("/");
}

function isPublicApi(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return isPublicCreativeShareRead(request) || PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function withCreativeShareNoStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

function isAllowedInternalApiRequest(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const bearerToken = getBearerToken(request)?.trim();
  if (!cronSecret || !bearerToken || bearerToken !== cronSecret) {
    return false;
  }

  const { pathname } = request.nextUrl;
  return INTERNAL_CRON_SECRET_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * THIS IS NOT AUTHENTICATION.
 *
 * `hasSession` below is a presence check: any request carrying a non-empty
 * `omniads_session` cookie passes, whatever the value. A real session is a
 * random token, hashed and looked up in the `sessions` table with an expiry
 * check (lib/auth.ts findSessionByToken) — something this proxy deliberately
 * does not do, because it would put a database round-trip in front of every
 * request and would still be the wrong place to make the decision.
 *
 * So this is a coarse routing gate: it decides whether to redirect a browser to
 * /login, and it turns away requests with no cookie at all. AUTHORITY BELONGS TO
 * THE ROUTE HANDLER. A route with no check of its own is not protected by
 * anything here — `Cookie: omniads_session=x` is the whole of its security.
 *
 * `/api/db-test` was that route: it ran CREATE TABLE / INSERT / DROP TABLE
 * against the production database and returned information_schema columns, with
 * no identity check anywhere. It has been deleted, and
 * app/api/route-authority.test.ts now fails if any route starts relying on this
 * function alone.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(AUTH_COOKIE)?.value);
  const hasLanguage = Boolean(request.cookies.get(LANGUAGE_COOKIE)?.value);

  if (pathname.startsWith("/api/")) {
    if (isPublicApi(request) || isAllowedInternalApiRequest(request)) {
      const response = NextResponse.next();
      return isPublicCreativeShareRead(request)
        ? withCreativeShareNoStore(response)
        : response;
    }
    if (!hasSession) {
      return NextResponse.json(
        { error: "auth_error", message: "Authentication required." },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  const publicRoute = resolvePublicRouteRedirect(pathname);
  if (publicRoute && hasSession) {
    const destination = publicRoute.businessId
      ? `/switch-business/${encodeURIComponent(publicRoute.businessId)}?next=${encodeURIComponent(`${publicRoute.destination}${request.nextUrl.search}`)}`
      : `${publicRoute.destination}${request.nextUrl.search}`;
    const response = NextResponse.redirect(new URL(destination, request.url));
    if (!hasLanguage) {
      response.cookies.set(LANGUAGE_COOKIE, "en", {
        path: "/",
        maxAge: 31536000,
        sameSite: "lax",
      });
    }
    return response;
  }

  if (
    pathname !== "/" &&
    !isPublicPage(pathname) &&
    !pathname.startsWith("/_next") &&
    !pathname.includes(".")
  ) {
    if (!hasSession) {
      const loginUrl = new URL("/login", request.url);
      const nextPath = `${pathname}${request.nextUrl.search}`;
      if (nextPath !== "/") {
        loginUrl.searchParams.set("next", nextPath);
      }
      return NextResponse.redirect(loginUrl);
    }
    if (hasSession && !hasLanguage) {
      const response = NextResponse.next();
      response.cookies.set(LANGUAGE_COOKIE, "en", {
        path: "/",
        maxAge: 31536000,
        sameSite: "lax",
      });
      return response;
    }
  }

  const response = NextResponse.next();
  return pathname.startsWith(CREATIVE_SHARE_PAGE_PREFIX)
    ? withCreativeShareNoStore(response)
    : response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
