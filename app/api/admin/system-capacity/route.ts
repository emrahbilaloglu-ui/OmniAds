import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAdminSystemCapacity } from "@/lib/admin-system-capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const capacity = await getAdminSystemCapacity();
    return NextResponse.json(capacity, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    console.error("[admin/system-capacity GET]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 },
    );
  }
}
