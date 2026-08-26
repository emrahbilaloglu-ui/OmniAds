import { NextResponse } from "next/server";

import { buildDevPreviewSharePayload } from "@/app/dev-preview-share/fixture";
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
    { error: "not_found", message: "Preview route is unavailable." },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

export function GET() {
  if (process.env.NODE_ENV === "production") {
    return unavailable();
  }

  const share = toPublicShare(buildDevPreviewSharePayload("buyer"));
  return new NextResponse("\ufeff" + buildPublicCreativeShareCsv(share), {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="creative-preview.csv"',
    },
  });
}
