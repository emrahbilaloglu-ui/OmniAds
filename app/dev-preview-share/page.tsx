import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  PublicSharePage,
  PublicShareUnavailable,
} from "@/components/zero-base/creative/public-share-page";
import {
  buildDevPreviewSharePayload,
  resolveDevPreviewShareAudience,
} from "@/app/dev-preview-share/fixture";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: "Public share preview",
  robots: { index: false, follow: false },
};

export default async function DevPreviewSharePage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string; state?: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const resolved = await searchParams;
  if (resolved.state === "gone") {
    return <PublicShareUnavailable />;
  }

  const audience = resolveDevPreviewShareAudience(resolved.audience);
  const payload = buildDevPreviewSharePayload(audience);
  const share = toPublicShare(
    resolved.state === "empty" ? { ...payload, creatives: [] } : payload,
  );
  const visibleShare =
    resolved.state === "real"
      ? {
          ...share,
          creatives: share.creatives.filter((creative) => creative.format === "catalog"),
        }
      : share;

  return (
    <PublicSharePage
      csvHref={visibleShare.allowCsv ? "/dev-preview-share/csv" : null}
      messagesHref="/dev-preview-share/messages"
      share={visibleShare}
    />
  );
}
