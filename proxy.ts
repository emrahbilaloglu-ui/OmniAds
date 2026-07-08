import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "omniads_session";
const LANGUAGE_COOKIE = "adsecute_locale";

const PUBLIC_PAGE_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/share",
  "/about",
  "/privacy",
  "/terms",
  "/ai-transparency",
  "/contact",
  "/security",
  "/product",
  "/pricing",
  "/demo",
  "/select-language",
  "/shopify/connect",
];
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
  "/api/creatives/share",
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

function getBearerToken(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(AUTH_COOKIE)?.value);
  const hasLanguage = Boolean(request.cookies.get(LANGUAGE_COOKIE)?.value);

  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname) || isAllowedInternalApiRequest(request)) {
      return NextResponse.next();
    }
    if (!hasSession) {
      return NextResponse.json(
        { error: "auth_error", message: "Authentication required." },
        { status: 401 },
      );
    }
    return NextResponse.next();
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
