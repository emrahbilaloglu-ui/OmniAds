"use client";

import { useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";
import { DEFAULT_LANGUAGE, syncLanguageCookie } from "@/lib/i18n";
import { sanitizeNextPath } from "@/lib/auth-routing";

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
      title="Applying language preference..."
      description="Redirecting you to the right workspace route."
    >
      <div className="h-2 rounded-full bg-neutral-100" />
    </AuthSurface>
  );
}
