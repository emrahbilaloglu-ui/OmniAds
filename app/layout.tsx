import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/providers/query-provider";
import { RouteRecoveryListener } from "@/components/layout/route-recovery-listener";
import { getSessionFromCookies } from "@/lib/auth";
import { getLanguageFromCookieValue, getPreferredLanguage, LANGUAGE_COOKIE_NAME } from "@/lib/i18n";
import { logStartupError } from "@/lib/startup-diagnostics";
import { ledgerFontVariables } from "@/lib/design/fonts";
import { ZeroBaseRolloutProvider } from "@/components/zero-base/rollout-provider";
import {
  isZeroBaseUiEnabledForInternal,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";
import {
  NO_FLASH_SCRIPT,
  THEME_ATTRIBUTE,
  THEME_COOKIE_NAME,
  parseThemePreference,
  resolveThemeForServer,
} from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
});

const appBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl),
  title: "Adsecute",
  description: "Multi-platform ad management dashboard",
  icons: {
    icon: "/adsecute-mark.svg",
    shortcut: "/adsecute-mark.svg",
    apple: "/adsecute-mark.svg",
  },
  openGraph: {
    title: "Adsecute",
    description: "Multi-platform ad management dashboard",
    images: ["/adsecute-mark.svg"],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  let session = null;
  try {
    session = await getSessionFromCookies();
  } catch (error: unknown) {
    logStartupError("root_layout_session_lookup_failed", error);
  }
  const language = getPreferredLanguage({
    userLanguage: session?.user.language,
    cookieLanguage: getLanguageFromCookieValue(cookieStore.get(LANGUAGE_COOKIE_NAME)?.value),
  });

  // Resolved server-side so the first paint is already correct. `system` is
  // the one case the server cannot know, and it resolves to null here — the
  // element then carries no attribute and the inline script settles it from
  // matchMedia before paint. Guessing a default instead is exactly what causes
  // the white flash on a dark-mode device.
  const themePreference = parseThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value);
  const serverTheme = resolveThemeForServer(themePreference);

  // Read once, on the server, and handed down as inert data. Auth screens are
  // client components and cannot read the environment themselves; exposing the
  // flag via NEXT_PUBLIC_* would make it client-forgeable, which the plan
  // forbids even for presentation.
  const zeroBaseUi = {
    canonical: isZeroBaseUiEnabledForInternal(readZeroBaseRolloutConfig()),
  };

  return (
    <html
      lang={language}
      suppressHydrationWarning
      {...(serverTheme ? { [THEME_ATTRIBUTE]: serverTheme } : {})}
    >
      <head>
        {/* Runs only for a `system` preference; a resolved one is already on
            <html> above, so there is nothing to correct. */}
        {serverTheme === null ? (
          <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
        ) : null}
      </head>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable} ${ledgerFontVariables} antialiased`}
      >
        {/* Keyboard users had to tab through the entire header on every page.
            Visible only when focused, so it changes nothing visually. */}
        <a href="#main-content" className="ad-skip-link">
          Skip to main content
        </a>
        <ZeroBaseRolloutProvider value={zeroBaseUi}>
          <QueryProvider>
            <RouteRecoveryListener />
            {children}
          </QueryProvider>
        </ZeroBaseRolloutProvider>
      </body>
    </html>
  );
}
