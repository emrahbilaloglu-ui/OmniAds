"use client";

import { GoogleWorkspaceScreen } from "@/components/google-ads/GoogleWorkspaceScreen";

/**
 * Google Ads — Overview.
 *
 * The route's render chain is
 * `GoogleWorkspaceScreen` → `GoogleAdsIntelligenceDashboard`.
 *
 * `GoogleWorkspaceScreen` is only the connection gate: it decides whether a
 * business is selected and whether Google is reachable, and holds no figures of
 * its own. Every read that could date this surface — the campaign queries and
 * the `/api/google-ads/status` read whose `freshness.scopes` supply the as-of —
 * lives in `GoogleAdsIntelligenceDashboard`, so the Tier-0 `useTierZeroFreshness`
 * call belongs there and is made exactly once, by it.
 *
 * Reporting a second time from this file would be worse than not reporting: the
 * gate knows nothing about the age of the data, and as the outer component its
 * effect runs last, so its "ready, age unknown" would overwrite the dashboard's
 * measured reading on every mount.
 */
export default function GooglePlatformPage() {
  return <GoogleWorkspaceScreen panel="summary" title="Overview" />;
}
