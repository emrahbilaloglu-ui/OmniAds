/**
 * Ledger presentation for the public marketing surfaces (WP-25).
 *
 * The rule that shapes this module: **presentation only.** Typography, tokens,
 * spacing and focus treatment are in scope; pricing, security, legal and AI
 * claims are not. A snapshot of every page's copy is captured before the change
 * and asserted equal after, so "we only restyled it" is a proven statement
 * rather than an intention.
 *
 * Two leakage directions are guarded:
 *
 * - **Product tokens must not reach marketing.** The workspace shell's tokens
 *   assume a signed-in surface with a rail, a context bar and a theme cookie.
 *   A public page inheriting them renders as a broken app to someone who has
 *   never logged in.
 * - **The workspace shell must not reach marketing.** No rail, no context bar,
 *   no business scope: these pages must work with no session at all.
 */

/** The Ledger tokens marketing may use. Deliberately a small subset. */
export const MARKETING_ALLOWED_TOKENS = [
  "--ledger-bg-canvas",
  "--ledger-bg-surface",
  "--ledger-ink-primary",
  "--ledger-ink-secondary",
  "--ledger-ink-tertiary",
  "--ledger-border-control",
  "--ledger-accent-action",
  "--ledger-radius-card",
  "--ledger-radius-control",
  "--font-adc-sans",
  "--font-adc-mono",
] as const;

/**
 * Product-only surfaces that must never appear on a public page.
 *
 * Each implies a signed-in context: a workspace rail, a business scope, or an
 * operator console.
 */
export const PRODUCT_ONLY_MARKERS = [
  'data-adc-ui="zero-base"',
  "data-ops-shell",
  "ZeroBaseShell",
  "WorkspaceContextProvider",
  "requireBusinessPageContext",
  "components/zero-base/shell",
] as const;

/** The attribute that scopes marketing styling. Nothing else opts in. */
export const MARKETING_ROOT_ATTRIBUTE = "data-adc-marketing";

/**
 * Whether a source file leaks a product-only surface into a public page.
 *
 * Returns the markers found, so a failure names which one rather than only
 * that something is wrong.
 */
export function findProductOnlyLeaks(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  return PRODUCT_ONLY_MARKERS.filter((marker) => code.includes(marker));
}

/**
 * Whether a page can render without a session.
 *
 * A public page that calls a session guard is not public. The check is on the
 * guards themselves rather than on the word "session", because reading a
 * language cookie is fine and reading an auth cookie to gate rendering is not.
 */
export const SESSION_GUARDS = [
  "getSessionFromCookies",
  "requireBusinessAccess",
  "requireBusinessPageContext",
  "isSuperadmin",
] as const;

/**
 * A **soft forward** is not a gate.
 *
 * The root page reads the session to send an already-signed-in visitor to
 * their workspace, and falls straight through for everyone else
 * (`if (!session) return;`). That is legitimate and must not be flagged — the
 * failure mode this test exists to catch is a page that refuses to render
 * without a session, not one that is polite to people who have one.
 */
export function hasAnonymousFallthrough(source: string): boolean {
  return /if \(!session\)\s*return;?/.test(source);
}

export function findSessionGuards(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  const found = SESSION_GUARDS.filter((guard) => code.includes(guard));
  // Only `getSessionFromCookies` can appear in a soft forward; the business and
  // admin guards redirect unconditionally and are never acceptable here.
  if (
    found.length === 1 &&
    found[0] === "getSessionFromCookies" &&
    hasAnonymousFallthrough(code)
  ) {
    return [];
  }
  return found;
}

/**
 * Languages the marketing surfaces genuinely support.
 *
 * Only EN and TR, and only where a page already carries both. Marking a page
 * bilingual because the product is would promise a translation that does not
 * exist.
 */
export const MARKETING_LANGUAGES = ["en", "tr"] as const;
export type MarketingLanguage = (typeof MARKETING_LANGUAGES)[number];

export function supportsLanguage(source: string, language: MarketingLanguage): boolean {
  if (language === "en") return true;
  // TR support is real only when the file actually branches on it.
  return /language === "tr"|lang === "tr"|\btr\b\s*:/.test(source);
}
