"use client";

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
    const googleError = searchParams.get("error");
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
        throw new Error(payload?.message ?? "Could not sign in.");
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
      const destination = resolvePostLoginDestination({
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
      setError(message);
      logClientAuthEvent("login_failed", { email, message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSurface titleOnBrandLine title={t.signIn} description="Sign in to your workspace.">
      <div className="ad-auth-form">
        <label className="ad-auth-label" htmlFor="email">
          {t.email}
          <input
            id="email"
            type="email"
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
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="ad-auth-input"
          />
        </label>
        {error ? <p className="ad-auth-alert ad-auth-alert-danger">{error}</p> : null}
        <button type="button" className="ad-auth-primary" onClick={handleLogin} disabled={loading}>
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
      </div>
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
