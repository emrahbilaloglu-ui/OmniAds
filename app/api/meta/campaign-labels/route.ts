import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * D074 compatibility tombstone.
 *
 * The route name is kept for one migration window so old clients receive an
 * explicit, non-retryable answer instead of a misleading 404. Campaign role is
 * now inferred server-side; this endpoint never reads or writes the historical
 * `meta_campaign_labels` tables.
 */
function retired() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "campaign_labels_retired",
        message:
          "Manual campaign labels are retired. Campaign roles are inferred automatically.",
      },
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET() {
  return retired();
}

export async function PUT() {
  return retired();
}
