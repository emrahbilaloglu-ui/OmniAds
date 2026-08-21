import { NextResponse } from "next/server";

import { normalizeCreativeShareToken } from "@/lib/creative-share-link";
import { getCreativeShareSnapshot } from "@/lib/creative-share-store";
import { buildPublicCreativeShareCsv } from "@/lib/zero-base/creative/public-share-csv";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function unavailable() {
  return NextResponse.json(
    { error: "not_found", message: "Share link not found, revoked, expired, or not downloadable." },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const token = normalizeCreativeShareToken((await context.params).token);
  if (!token) return unavailable();

  const payload = await getCreativeShareSnapshot(token).catch(() => null);
  if (!payload) return unavailable();
  const share = toPublicShare(payload);
  if (!share.allowCsv) return unavailable();

  return new NextResponse("\ufeff" + buildPublicCreativeShareCsv(share), {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="creative-snapshot.csv"',
    },
  });
}
