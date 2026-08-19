import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  describeLaunchpadHandoffRefusal,
  mintLaunchpadCopyHandoff,
  type LaunchpadCopyHandoffCandidate,
} from "@/lib/meta/launchpad-handoff";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { isReviewerEmail } from "@/lib/reviewer-access";

export const dynamic = "force-dynamic";

/**
 * Mints a Copies -> Launchpad handoff.
 *
 * WHAT THE BODY IS ALLOWED TO SAY
 * -------------------------------
 * The body names a CREATIVE, a WINDOW and one ALTERNATE LINE. It asserts
 * nothing else, and the alternate is not taken on the caller's word: this route
 * re-reads the served copy for that creative in that window and requires the
 * requested line to be one Meta actually served. Without that check the drawer
 * would be a way to put arbitrary ad text into a draft that claims Meta's own
 * served lines as its source.
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT a decision handoff, and it does not pretend to be one. A copies row
 * is a warehouse aggregate, which the canonical contract classes as discovery
 * evidence only, and it carries no `decisionId` and no `sourceSnapshotId`. So
 * the envelope this mints has `origin: "copy"`,
 * `sourceAuthorityStatus: "warehouse_discovery"`, `authorizedAction: null`,
 * `actionEligible: false` and `exactAdExecutionEligible: false` — and
 * `consumeLaunchpadHandoff` re-checks all five against the origin. No decision
 * id is fabricated anywhere in this path.
 *
 * NO PROVIDER WRITE happens here. The creatives read this performs is a read.
 */

interface CopyHandoffRequestBody {
  businessId?: unknown;
  providerAccountId?: unknown;
  creativeId?: unknown;
  alternateText?: unknown;
  start?: unknown;
  end?: unknown;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDate(value: unknown): string | null {
  const raw = readString(value);
  return raw && ISO_DATE.test(raw) ? raw : null;
}

function servedLines(row: MetaCreativeApiRow): string[] {
  return [
    ...(row.copy_variants ?? []),
    ...(row.headline_variants ?? []),
    ...(row.description_variants ?? []),
  ]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
}

function assetTypeForLine(
  rows: readonly MetaCreativeApiRow[],
  line: string,
): string | null {
  const has = (pick: (row: MetaCreativeApiRow) => unknown) =>
    rows.some((row) => {
      const list = pick(row);
      return (
        Array.isArray(list) &&
        list.some(
          (value) => typeof value === "string" && value.trim() === line,
        )
      );
    });
  if (has((row) => row.copy_variants)) return "primary_text";
  if (has((row) => row.headline_variants)) return "headline";
  if (has((row) => row.description_variants)) return "description";
  return null;
}

export async function POST(request: NextRequest) {
  let body: CopyHandoffRequestBody;
  try {
    body = (await request.json()) as CopyHandoffRequestBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "A JSON body is required." },
      { status: 400 },
    );
  }

  const businessId = readString(body.businessId);
  const providerAccountId = readString(body.providerAccountId);
  const creativeId = readString(body.creativeId);
  const alternateText = typeof body.alternateText === "string" ? body.alternateText : "";
  const start = readDate(body.start);
  const end = readDate(body.end);
  if (
    !businessId ||
    !providerAccountId ||
    !creativeId ||
    !alternateText.trim() ||
    !start ||
    !end ||
    start > end
  ) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message:
          "businessId, providerAccountId, creativeId, alternateText and an ISO start/end window are required.",
      },
      { status: 400 },
    );
  }

  // Collaborator, not guest: a handoff is the opening move of a draft that only
  // a collaborator may ever launch.
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  if (isReviewerEmail(access.session.user.email)) {
    return NextResponse.json(
      {
        error: "reviewer_read_only",
        message:
          "Reviewer access is read-only, so no launch handoff can be created.",
      },
      { status: 403 },
    );
  }

  // "Demo businesses have zero Meta write authority even if a presentation
  // defect supplies an action." An unreadable demo flag refuses too — a write
  // path must not proceed on an unproven claim that this workspace is real.
  const writeAuthority = await readLaunchpadWriteAuthority(businessId);
  if (writeAuthority !== "live") {
    return NextResponse.json(
      {
        error:
          writeAuthority === "demo"
            ? "demo_business_read_only"
            : "demo_status_unverified",
        message:
          writeAuthority === "demo"
            ? "Demo workspaces have zero Meta write authority, so no launch handoff can be created."
            : "This workspace could not be confirmed as a live workspace, so no launch handoff was created.",
      },
      { status: writeAuthority === "demo" ? 403 : 503 },
    );
  }

  // A URL-supplied account is never authority; it is a request that has to
  // survive the assignment check.
  let assignments: Awaited<ReturnType<typeof getProviderAccountAssignments>>;
  try {
    assignments = await getProviderAccountAssignments(businessId, "meta");
  } catch {
    return NextResponse.json(
      {
        error: "provider_account_scope_unverified",
        message:
          "The provider-account assignment source is unavailable, so no handoff was created.",
      },
      { status: 503 },
    );
  }
  if (!assignments?.account_ids.includes(providerAccountId)) {
    return NextResponse.json(
      {
        error: "provider_account_not_assigned",
        message: "The requested Meta account is not assigned to this business.",
      },
      { status: 403 },
    );
  }

  let payload: { status?: string; rows?: MetaCreativeApiRow[] } | null;
  try {
    payload = (await getMetaCreativesApiPayload({
      request,
      requestStartedAt: Date.now(),
      businessId,
      providerAccountId,
      mediaMode: "metadata",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      start,
      end,
      debugPreview: false,
      debugThumbnail: false,
      debugPerf: false,
      snapshotBypass: false,
      snapshotWarm: false,
      enableCopyRecovery: true,
      enableCreativeBasicsFallback: true,
      enableCreativeDetails: true,
      enableThumbnailBackfill: false,
      enableCardThumbnailBackfill: false,
      enableImageHashLookup: false,
      enableMediaRecovery: false,
      enableMediaCache: false,
      enableDeepAudit: false,
      perAccountSampleLimit: 5,
    })) as { status?: string; rows?: MetaCreativeApiRow[] } | null;
  } catch {
    payload = null;
  }
  // An unreadable copy source is not an empty one. Refusing here keeps a failed
  // read from being reported as "that line was never served".
  if (!payload || payload.status !== "ok" || !Array.isArray(payload.rows)) {
    return NextResponse.json(
      {
        error: "copy_source_unavailable",
        message:
          "The served copy for this account and window could not be read, so no handoff was created.",
      },
      { status: 503 },
    );
  }

  const creativeRows = payload.rows.filter(
    (row) => (row.creative_id ?? "").trim() === creativeId,
  );
  const candidate: LaunchpadCopyHandoffCandidate = {
    copyId: `copy:${creativeId}`,
    providerAccountId,
    assetType: assetTypeForLine(creativeRows, alternateText.trim()),
    sourceText:
      creativeRows.map((row) => row.copy_text).find((text) => typeof text === "string" && text.trim()) ??
      null,
    alternates: [...new Set(creativeRows.flatMap(servedLines))],
    campaignIds: creativeRows.map((row) => row.campaign_id ?? ""),
    adIds: creativeRows.map((row) => row.id),
    creativeIds: [creativeId],
  };

  const minted = await mintLaunchpadCopyHandoff({
    businessId,
    providerAccountId,
    candidate,
    requestedAlternateText: alternateText,
    window: { startDate: start, endDate: end },
    createdByUserId: access.session.user.id,
  });
  if (!minted.ok) {
    return NextResponse.json(
      {
        error: minted.refusal,
        message: describeLaunchpadHandoffRefusal(minted.refusal),
      },
      { status: minted.refusal === "persist_failed" ? 503 : 409 },
    );
  }

  return NextResponse.json({
    handoff: minted.reference,
    mode: minted.envelope.mode,
    expiresAt: minted.envelope.expiresAt,
    // Stated, not implied: a copy handoff carries no execution authority at all.
    authorizedAction: null,
    actionEligible: false,
    exactAdExecutionEligible: false,
    evidenceWindow: minted.envelope.evidenceWindow,
  });
}
