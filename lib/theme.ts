/**
 * Theme preference and first-paint resolution.
 *
 * The user's choice is `system | light | dark`; what actually renders is only
 * ever `light | dark`. Those are separate values and conflating them is what
 * produces a theme toggle that forgets it was following the OS.
 *
 * The preference is stored in a plain cookie, not localStorage, because the
 * server has to know it *before* the first byte of HTML — that is the entire
 * mechanism by which the dark theme does not flash white on load. A
 * `system` preference is the one case the server genuinely cannot resolve, so
 * it emits no theme attribute and a tiny inline script settles it from
 * `matchMedia` before paint.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE_NAME = "adc_theme";
export const THEME_ATTRIBUTE = "data-adc-theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** Anything unrecognised falls back to `system` rather than guessing. */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  const candidate = value?.trim().toLowerCase();
  return PREFERENCES.find((preference) => preference === candidate) ?? DEFAULT_THEME_PREFERENCE;
}

/**
 * Resolves what to render. Returns null for `system` on the server, where the
 * OS preference is genuinely unknown — callers must not substitute a guess.
 */
export function resolveThemeForServer(preference: ThemePreference): ResolvedTheme | null {
  return preference === "system" ? null : preference;
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** One year: a theme choice should outlive a session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function themeCookieAttributes(preference: ThemePreference): string {
  return [
    `${THEME_COOKIE_NAME}=${preference}`,
    "Path=/",
    `Max-Age=${THEME_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ].join("; ");
}

/** Mirrors `syncLanguageCookie`: a no-op on the server, a write in the browser. */
export function syncThemeCookie(preference: ThemePreference) {
  if (typeof document === "undefined") return;
  document.cookie = themeCookieAttributes(preference);
}

/**
 * Inline script for the document head.
 *
 * It runs only when the preference is `system` — a resolved preference is
 * already on the server-rendered element, so there is nothing to correct and
 * no script to run. Kept deliberately tiny and dependency-free because it
 * executes before paint and blocks it.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE_NAME}=([^;]*)/);var p=m?decodeURIComponent(m[1]):"system";if(p==="light"||p==="dark"){return}var d=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.setAttribute("${THEME_ATTRIBUTE}",d?"dark":"light")}catch(e){}})();`;
