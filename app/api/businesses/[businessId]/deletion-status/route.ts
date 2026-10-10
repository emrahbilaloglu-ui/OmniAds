import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { verifyBusinessDeletionTicket } from "@/lib/business-deletion-ticket";
import { businessDeletionFailureMessage, enqueueBusinessDeletion } from "@/lib/business-deletion-jobs";
import { resolveRequestLanguage } from "@/lib/request-language";

/** Cleanup is application-owner information. An old ordinary-user ticket
 * cannot grant it; the current superadmin authorization is mandatory. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ businessId: string }> }) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  if (!auth.session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { businessId } = await params;
  const body = await request.json().catch(() => null);
  if(body?.action==="retry"){
    try { const job=await enqueueBusinessDeletion(businessId);
      return NextResponse.json({status:job.status},{status:202,headers:{"Cache-Control":"private, no-store"}}); }
    catch {return NextResponse.json({error:"retry_unavailable"},{status:503});}
  }
  if (!verifyBusinessDeletionTicket(body?.monitorTicket, request.cookies.get("omniads_session")?.value ?? "",
    businessId, auth.session.sessionId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return readOwnerStatus(request, businessId, true);
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ businessId: string }> }) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const { businessId } = await params;
  return readOwnerStatus(request, businessId);
}
async function readOwnerStatus(request: NextRequest, businessId: string, acceptedReceipt = false) {
  const tr = (await resolveRequestLanguage(request)) === "tr";
  try {
    const [row] = await getDb().query<{ status: string | null; error_code: string | null; error_tables: string[] | null; hidden_at: string | null }>(
      `SELECT j.status,j.error_code,j.error_tables,j.hidden_at FROM businesses b
       LEFT JOIN business_deletion_jobs j ON j.business_ref_id=b.id WHERE b.id=$1::uuid`, [businessId]);
    const headers = { "Cache-Control": "private, no-store" };
    // Root removal is the last write after owned-absence/guard restoration.
    // Its FK-cascaded job disappears in the SAME transaction.
    if (!row) return NextResponse.json({ status: "ok" }, { headers });
    if (!row.status && !acceptedReceipt) return NextResponse.json({ status: "not_requested" }, { headers });
    if (row.status === "queued" || row.status === "running") return NextResponse.json({ status: row.status }, { headers });
    return NextResponse.json({ status: "failed", error: row.error_code ?? "delete_failed",
      message: businessDeletionFailureMessage(row.error_code ?? "delete_failed", tr, row.error_tables ?? [],Boolean(row.hidden_at)) }, { headers });
  } catch {
    return NextResponse.json({ error: "status_unavailable", message: tr ? "Silme durumu doğrulanamadı. Listeyi yenileyin; iş arka planda devam ediyor olabilir."
      : "Deletion status could not be confirmed. Refresh the list; the background job may still be running." }, { status: 503 });
  }
}
