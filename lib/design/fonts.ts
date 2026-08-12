/**
 * Local zero-base fonts.
 *
 * `next/font/local` self-hosts these at build time from the vendored files, so
 * there is no runtime Google Fonts request and no third-party connection on
 * first paint. The legacy `next/font/google` families in `app/layout.tsx` are
 * left alone; both sets of variables coexist and the canonical root picks the
 * Ledger pair.
 *
 * Schibsted Grotesk is one variable file, declared across its real `wght`
 * axis (400–900) rather than as four pinned instances — see
 * `public/fonts/zero-base/LICENSES.md`.
 */
import localFont from "next/font/local";

export const ledgerSans = localFont({
  src: [
    {
      path: "../../public/fonts/zero-base/schibsted-grotesk-variable.woff2",
      weight: "400 700",
      style: "normal",
    },
  ],
  variable: "--font-adc-sans",
  display: "swap",
  // Keeps the pre-swap layout close to the real thing, so the fallback frame
  // does not visibly reflow when the face lands.
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: false,
});

export const ledgerMono = localFont({
  src: [
    {
      path: "../../public/fonts/zero-base/fragment-mono-400.woff2",
      weight: "400",
      style: "normal",
    },
  ],
  variable: "--font-adc-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  adjustFontFallback: false,
});

/** Applied to `<body>` so the variables exist for the canonical root to use. */
export const ledgerFontVariables = `${ledgerSans.variable} ${ledgerMono.variable}`;
