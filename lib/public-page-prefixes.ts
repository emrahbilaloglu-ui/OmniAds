/**
 * The pages a person with no session may reach.
 *
 * Extracted from `proxy.ts` so there is one list rather than two. The
 * compatibility layer needs the same answer the edge gate gives: if a legacy
 * path is public today, sending an anonymous visitor to `/login` because the
 * canonical UI was switched on would break a surface that has never needed an
 * account. `/select-language` is exactly that case — it is reachable before
 * signing in, and its canonical home is `/me/language`, which is not.
 *
 * A prefix list, not an exact list: `/share/creative/<token>` and
 * `/invite/<token>` are public in the same way their parents are.
 */
export const PUBLIC_PAGE_PREFIXES: readonly string[] = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/share",
  "/about",
  "/privacy",
  "/terms",
  "/ai-transparency",
  "/contact",
  "/security",
  "/product",
  "/pricing",
  "/demo",
  "/select-language",
  "/shopify/connect",
];

export function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
