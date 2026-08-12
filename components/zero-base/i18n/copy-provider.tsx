"use client";

/**
 * Language for zero-base client surfaces.
 *
 * Server pages resolve the language they already resolve (user row, then
 * cookie) and pass it down; client components read it from context. A component
 * with no provider above it falls back to the cookie, and then to English —
 * explicitly, so a missing provider renders real copy rather than blank keys.
 *
 * A deliberate limit, recorded rather than worked around: this makes the
 * zero-base surfaces *renderable* in Turkish. It does not by itself add Turkish
 * to `LANGUAGE_OPTIONS`, because that list is gated on the legacy console
 * dictionary shipping Turkish too. Offering a language that only half the
 * product can render is the silent-drop bug `66753e017` removed, and adding TR
 * to the picker before the legacy dictionary exists would reintroduce it.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { DEFAULT_LANGUAGE, readLanguageCookie, type AppLanguage } from "@/lib/i18n";
import { zeroBaseCopy, type ZeroBaseCopy } from "@/lib/zero-base/copy";

const LanguageContext = createContext<AppLanguage | null>(null);

export function ZeroBaseCopyProvider({
  language,
  children,
}: {
  language: AppLanguage;
  children: ReactNode;
}) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

/** The active language: provider, then cookie, then the explicit default. */
export function useZeroBaseLanguage(): AppLanguage {
  const provided = useContext(LanguageContext);
  const [cookieLanguage, setCookieLanguage] = useState<AppLanguage | null>(null);

  useEffect(() => {
    if (provided) return;
    // Read after mount: the cookie is not available during server render, and
    // reading it during render would produce a hydration mismatch.
    setCookieLanguage(readLanguageCookie());
  }, [provided]);

  return provided ?? cookieLanguage ?? DEFAULT_LANGUAGE;
}

/** Copy for the active language. */
export function useCopy(): ZeroBaseCopy {
  return zeroBaseCopy(useZeroBaseLanguage());
}
