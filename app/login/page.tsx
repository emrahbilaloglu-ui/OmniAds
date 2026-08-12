"use client";

import { resolveSignInError } from "@/lib/auth-google-errors";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { resolvePostLoginDestination } from "@/lib/auth-routing";
import { replaceAuthenticatedWorkspace } from "@/lib/client-auth-state";
import { AuthSurface } from "@/components/auth/auth-surface";
import {
  getLanguageFromCookieValue,
  getPreferredLanguage,
  getTranslations,
  LANGUAGE_COOKIE_NAME,
} from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { useZeroBaseUi } from "@/components/zero-base/rollout-provider";
import { LoginFailurePanel } from "@/components/zero-base/auth/auth-states";
import { loginFailureCopy, loginFailureFromResponse, type LoginFailureState } from "@/lib/zero-base/auth-states";
import { resolveCanonicalPostLoginDestination } from "@/lib/zero-base/auth-routing";

function getLanguageCookie() {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LANGUAGE_COOKIE_NAME}=`))
    ?.split("=")[1];
}

interface LoginResponse {
  user?: {
    id: string;
    language?: "en" | "tr";
  };
  businesses?: Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezoneSource?: "shopify" | "ga4" | null;
    currency: string;
    // The endpoint already returns this (it passes listUserBusinesses through
    // unfiltered); the client type simply omitted it. Type-only widening —
    // the auth endpoints are unchanged.
    membershipStatus?: "active" | "invited" | "pending";
    isDemoBusiness?: boolean;
    industry?: string;
    platform?: string;
  }>;
  activeBusinessId?: string | null;
  authenticated?: boolean;
  message?: string;
}

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguishes validation from bad credentials from rate-limiting from
  // being offline. One "Could not sign in." for all four leaves the user with
  // no idea whether to fix something, wait, or check their connection.
  const [failureState, setFailureState] = useState<LoginFailureState | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const { canonical } = useZeroBaseUi();
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);
  const t = getTranslations(language).login;

  useEffect(() => {
    setLanguage(getLanguageFromCookieValue(getLanguageCookie()));
  }, [setLanguage]);

  useEffect(() => {
    const inviteEmail = searchParams.get("email");
    if (inviteEmail) {
      setEmail(inviteEmail);
      return;
    }
    const googleError = resolveSignInError(searchParams.get("error"));
    if (googleError) {
      setError(googleError);
    }
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    async function restoreExistingSession() {
      let response: Response | null = null;
      try {
        response = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        return;
      }
      if (!response?.ok) return;
      const payload = (await response.json().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        return null;
      })) as LoginResponse | null;
      if (!payload?.authenticated || !payload.user?.id) return;
      setLanguage(
        getPreferredLanguage({
          userLanguage: payload.user.language,
          cookieLanguage: getLanguageCookie(),
        })
      );

      replaceAuthenticatedWorkspace({
        userId: payload.user.id,
        businesses: (payload.businesses ?? []).map((business) => ({
          id: business.id,
          name: business.name,
          timezone: business.timezone,
          timezoneSource: business.timezoneSource ?? null,
          currency: business.currency,
          isDemoBusiness: business.isDemoBusiness,
          industry: business.industry,
          platform: business.platform,
        })),
        activeBusinessId: payload.activeBusinessId ?? null,
      });

      const destination = resolvePostLoginDestination({
        businesses: payload.businesses ?? [],
        activeBusinessId: payload.activeBusinessId ?? null,
        nextPath: searchParams.get("next"),
      });
      logClientAuthEvent("login_page_redirect_existing_session", {
        destination,
        userId: payload.user.id,
      });
      router.replace(destination);
      router.refresh();
    }

    void restoreExistingSession();
    return () => controller.abort();
  }, [router, searchParams]);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    setFailureState(null);
    setRetryAfterSeconds(null);

    if (!email.trim() || !password) {
      setFailureState("field_validation");
      setError(loginFailureCopy("field_validation"));
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await res
        .json()
        .catch(() => null)) as LoginResponse | null;
      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const state = loginFailureFromResponse({
          status: res.status,
          code: (payload as { error?: string } | null)?.error ?? null,
        });
        setFailureState(state);
        setRetryAfterSeconds(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
        // The server's own message stays available for legacy rendering; the
        // canonical panel uses the state's copy.
        throw new Error(payload?.message ?? loginFailureCopy(state));
      }
      const inviteToken = searchParams.get("invite");
      if (inviteToken) {
        const acceptRes = await fetch(`/api/invite/${inviteToken}`, {
          method: "POST",
        });
        const acceptPayload = (await acceptRes.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (!acceptRes.ok) {
          throw new Error(
            acceptPayload?.message ??
              "Signed in, but invite could not be accepted.",
          );
        }
      }
      if (payload?.user?.id) {
        setLanguage(
          getPreferredLanguage({
            userLanguage: payload.user.language,
            cookieLanguage: getLanguageCookie(),
          })
        );
        replaceAuthenticatedWorkspace({
          userId: payload.user.id,
          businesses: (payload.businesses ?? []).map((business) => ({
            id: business.id,
            name: business.name,
            timezone: business.timezone,
            timezoneSource: business.timezoneSource ?? null,
            currency: business.currency,
            isDemoBusiness: business.isDemoBusiness,
            industry: business.industry,
            platform: business.platform,
          })),
          activeBusinessId: payload.activeBusinessId ?? null,
        });
      }
      // Canonical routing is authorization-gated: `next` is honoured only
      // after we know the actor can reach it. Legacy keeps its own resolver so
      // nothing changes with rollout off.
      const destination = canonical
        ? resolveCanonicalPostLoginDestination({
            businesses: (payload?.businesses ?? []).map((business) => ({
              id: business.id,
              membershipStatus: business.membershipStatus,
            })),
            lastCanonicalBusinessId: payload?.activeBusinessId ?? null,
            next: searchParams.get("next"),
          })
        : resolvePostLoginDestination({
            businesses: payload?.businesses ?? [],
            activeBusinessId: payload?.activeBusinessId ?? null,
            nextPath: searchParams.get("next"),
          });
      logClientAuthEvent("login_succeeded", {
        destination,
        userId: payload?.user?.id ?? null,
        membershipCount: payload?.businesses?.length ?? 0,
        activeBusinessId: payload?.activeBusinessId ?? null,
      });
      router.push(destination);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not sign in.";
      // A thrown fetch never reached the server, so nothing was submitted —
      // which is a materially different thing to tell the user.
      setFailureState((current) => {
        if (current) return current;
        const offline = loginFailureFromResponse({ networkError: true });
        setError(loginFailureCopy(offline));
        return offline;
      });
      if (!message.startsWith("Could not reach")) setError(message);
      logClientAuthEvent("login_failed", { email, message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSurface titleOnBrandLine title={t.signIn} description="Sign in to your workspace.">
      {/* A real <form>. These inputs used to sit in a bare <div> with a
          type="button" submit, so pressing Enter after typing a password did
          nothing on every auth screen in the product. */}
      <form
        className="ad-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleLogin();
        }}
      >
        <label className="ad-auth-label" htmlFor="email">
          {t.email}
          <input
            id="email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="ad-auth-input"
          />
        </label>
        <label className="ad-auth-label" htmlFor="password">
          {t.password}
          <input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="ad-auth-input"
          />
        </label>
        {error ? (
          canonical && failureState ? (
            <LoginFailurePanel state={failureState} retryAfterSeconds={retryAfterSeconds} />
          ) : (
            <p className="ad-auth-alert ad-auth-alert-danger" role="alert" aria-live="assertive">
              {error}
            </p>
          )
        ) : null}
        <button type="submit" className="ad-auth-primary" disabled={loading}>
          {loading ? t.signingIn : t.signIn}
        </button>
        <button
          type="button"
          className="ad-auth-secondary"
          onClick={() => {
            const url = nextParam
              ? `/api/oauth/sign-with-google/start?next=${encodeURIComponent(nextParam)}`
              : "/api/oauth/sign-with-google/start";
            window.location.href = url;
          }}
          disabled={loading}
        >
          Continue with Google
        </button>
        <div className="ad-auth-row">
          <Link href="/forgot-password">Forgot password?</Link>
          <Link href={nextParam ? `/signup?next=${encodeURIComponent(nextParam)}` : "/signup"}>
            Create account
          </Link>
        </div>
      </form>
    </AuthSurface>
  );
}

function LoginPageFallback() {
  return (
    <AuthSurface
      title="Loading sign in..."
      description="Preparing authentication flow."
    >
      <div className="h-2 rounded-full bg-[var(--adc-s3,#ededea)]" />
    </AuthSurface>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPageFallback />}>
      <LoginPageClient />
    </Suspense>
  );
}
