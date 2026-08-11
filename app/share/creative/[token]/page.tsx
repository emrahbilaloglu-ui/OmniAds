import type { Metadata } from "next";

import {
  PublicSharePage,
  PublicShareUnavailable,
} from "@/components/zero-base/creative/public-share-page";
import { getCreativeShareSnapshot } from "@/lib/creative-share-store";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Page metadata is deliberately constant.
 *
 * Deriving a title from the share would publish the workspace's own words to
 * anyone who fetches the page — including link unfurlers and crawlers — and
 * would also differ between a live token and a dead one, which is a way of
 * telling a stranger that a dead link was once real.
 */
export const metadata: Metadata = {
  title: "Shared creatives",
  robots: { index: false, follow: false },
};

/**
 * The public creative share — no auth, and no workspace identity.
 *
 * Everything the page renders comes from `toPublicShare`, which drops the
 * internal ids, the workspace name and the contact address rather than merely
 * not rendering them. The route itself never touches those fields.
 *
 * Every failure — expired, revoked, rotated away, malformed, never existed —
 * returns the same composition. `getCreativeShareSnapshot` already collapses
 * them into a single null, and the page keeps them collapsed: telling a
 * stranger which one occurred confirms the link was once real.
 */
export default async function ShareCreativePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const payload = await getCreativeShareSnapshot(token, { recordOpen: true }).catch(() => null);
  if (!payload) return <PublicShareUnavailable />;

  return <PublicSharePage share={toPublicShare(payload)} />;
}
