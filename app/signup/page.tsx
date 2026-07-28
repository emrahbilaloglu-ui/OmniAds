"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { resolvePostLoginDestination } from "@/lib/auth-routing";
import { replaceAuthenticatedWorkspace } from "@/lib/client-auth-state";
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

interface SignupResponse {
  authenticated?: boolean;
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
  message?: string;
}

function SignupPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite") ?? "";
  const inviteEmail = searchParams.get("email") ?? "";
  const nextParam = searchParams.get("next");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);
  const t = getTranslations(language).signup;

  useEffect(() => {
    setLanguage(getLanguageFromCookieValue(getLanguageCookie()));
  }, [setLanguage]);

  useEffect(() => {
    const controller = new AbortController();
    async function restoreExistingSession() {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        signal: controller.signal,
      }).catch(() => null);
      if (!response?.ok) return;
      const payload = (await response
        .json()
        .catch(() => null)) as SignupResponse | null;
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
      router.replace(destination);
      router.refresh();
    }

    void restoreExistingSession();
    return () => controller.abort();
  }, [router, searchParams]);

  async function handleSignup() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          inviteToken: inviteToken || undefined,
        }),
      });
      const payload = (await res
        .json()
        .catch(() => null)) as SignupResponse | null;
      if (!res.ok)
        throw new Error(payload?.message ?? "Could not create account.");
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
      logClientAuthEvent("signup_succeeded", {
        destination,
        userId: payload?.user?.id ?? null,
        membershipCount: payload?.businesses?.length ?? 0,
      });
      router.push(destination);
      router.refresh();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not create account.";
      setError(message);
      logClientAuthEvent("signup_failed", { email, message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSurface
      titleOnBrandLine
      title="Create your account"
      description={inviteToken ? t.inviteSubtitle : "Create your account first; business setup happens after sign up."}
    >
      <form
        className="ad-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSignup();
        }}
      >
        <label className="ad-auth-label">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="ad-auth-input"
            placeholder="Full name"
          />
        </label>
        <label className="ad-auth-label">
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="ad-auth-input"
            placeholder="you@company.com"
            disabled={Boolean(inviteEmail)}
          />
        </label>
        <label className="ad-auth-label">
          Password
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="ad-auth-input"
            placeholder="Password (min 8 chars)"
          />
        </label>
        {error ? (
          <p className="ad-auth-alert ad-auth-alert-danger" role="alert" aria-live="assertive">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ad-auth-primary" disabled={loading}>
          {loading ? t.creating : "Create account"}
        </button>
        <button
          type="button"
          className="ad-auth-secondary"
          onClick={() => {
            const href = nextParam
              ? `/api/oauth/sign-with-google/start?next=${encodeURIComponent(nextParam)}`
              : "/api/oauth/sign-with-google/start";
            window.location.href = href;
          }}
          disabled={loading}
        >
          Continue with Google
        </button>
        <div className="ad-auth-row">
          <span />
          <Link href={nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : "/login"}>
            Sign in
          </Link>
        </div>
      </form>
    </AuthSurface>
  );
}

function SignupPageFallback() {
  return (
    <AuthSurface
      title="Loading sign up..."
      description="Preparing invite and auth context."
    >
      <div className="h-2 rounded-full bg-[var(--adc-s3,#ededea)]" />
    </AuthSurface>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<SignupPageFallback />}>
      <SignupPageClient />
    </Suspense>
  );
}
