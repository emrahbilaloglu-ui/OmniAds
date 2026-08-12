"use client";

import { useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";
import { DEFAULT_LANGUAGE, syncLanguageCookie } from "@/lib/i18n";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { PUBLIC_LANGUAGE_SELECTOR_LIMITATION } from "@/lib/zero-base/auth-states";

function resolveDestination(nextPath: string | null) {
  const sanitized = sanitizeNextPath(nextPath);
  if (
    !sanitized ||
    sanitized === "/" ||
    sanitized.startsWith("/login") ||
    sanitized.startsWith("/signup") ||
    sanitized.startsWith("/select-language") ||
    sanitized.startsWith("/select-business")
  ) {
    return "/overview";
  }
  return sanitized;
}

export default function SelectLanguagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = useMemo(
    () => resolveDestination(searchParams.get("next")),
    [searchParams],
  );

  useEffect(() => {
    syncLanguageCookie(DEFAULT_LANGUAGE);
    router.replace(destination);
    router.refresh();
  }, [destination, router]);

  return (
    <AuthSurface
      eyebrow="Workspace preference"
      title="Taking you to your workspace"
      /* This route is not a selector and never was: it writes the default
         language and redirects. Calling it "Applying language preference"
         implied the user had chosen something and it had been honoured. */
      description="Language selection is not available here."
    >
      <p className="ad-auth-alert ad-auth-alert-caution" data-language-limitation="">
        {PUBLIC_LANGUAGE_SELECTOR_LIMITATION}
      </p>
    </AuthSurface>
  );
}
