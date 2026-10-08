import { NextRequest, NextResponse } from "next/server";
import { requireAuthedRequest } from "@/lib/access";
import { getDb } from "@/lib/db";
import { verifyBusinessDeletionTicket } from "@/lib/business-deletion-ticket";
import { businessDeletionFailureMessage } from "@/lib/business-deletion-jobs";
import { resolveRequestLanguage } from "@/lib/request-language";

/** POST keeps the read capability out of URLs/access logs. The session-bound
 * receipt proves prior authorized DELETE even after memberships/job are gone. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ businessId: string }> }) {
  const auth = await requireAuthedRequest(request);
  if ("error" in auth) return auth.error;
  const { businessId } = await params;
  const body = await request.json().catch(() => null);
  if (!verifyBusinessDeletionTicket(body?.monitorTicket, request.cookies.get("omniads_session")?.value ?? "",
    businessId, auth.session.sessionId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tr = (await resolveRequestLanguage(request)) === "tr";
  try {
    const [row] = await getDb().query<{ status: string | null; error_code: string | null; error_tables: string[] | null }>(
      `SELECT j.status,j.error_code,j.error_tables FROM businesses b
       LEFT JOIN business_deletion_jobs j ON j.business_ref_id=b.id WHERE b.id=$1::uuid`, [businessId]);
    const headers = { "Cache-Control": "private, no-store" };
    // Root removal is the last write after owned-absence/guard restoration.
    // Its FK-cascaded job disappears in the SAME transaction.
    if (!row) return NextResponse.json({ status: "ok" }, { headers });
    if (row.status === "queued" || row.status === "running") return NextResponse.json({ status: row.status }, { headers });
    return NextResponse.json({ status: "failed", error: row.error_code ?? "delete_failed",
      message: businessDeletionFailureMessage(row.error_code ?? "delete_failed", tr, row.error_tables ?? []) }, { headers });
  } catch {
    return NextResponse.json({ error: "status_unavailable", message: tr ? "Silme durumu doğrulanamadı. Listeyi yenileyin; iş arka planda devam ediyor olabilir."
      : "Deletion status could not be confirmed. Refresh the list; the background job may still be running." }, { status: 503 });
  }
}
