export interface PublicRouteRedirect {
  destination: string;
  businessId: string | null;
}

/**
 * Business-scoped `/c/:businessId/...` URLs still resolve here, because they
 * carry a business to switch to before anything renders.
 *
 * The dashboard paths — `/overview`, `/team`, `/platforms/**`, `/insights/**`,
 * `/integrations`, `/reports`, `/commercial-truth`, `/settings` — used to
 * resolve here too, each mapped to a canonical `/app/**` twin. That map ran in
 * the proxy, ahead of every page, and it read no configuration at all. So
 * `ZERO_BASE_UI_MODE=off` — documented as the rollback, and correctly honoured
 * by the pages and by the API routes — could not roll anything back: the
 * browser was redirected before a page was ever reached. The map is gone, and
 * those paths now serve the screens that live at them.
 */
export function resolvePublicRouteRedirect(pathname: string): PublicRouteRedirect | null {
  const scoped = pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
  if (scoped) {
    const businessId = decodeURIComponent(scoped[1]!);
    const rest = scoped[2] || "/home";
    return { destination: `/app${rest}`, businessId };
  }

  return null;
}
