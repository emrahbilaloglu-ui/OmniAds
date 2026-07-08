import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  readMetaCampaignLabels,
  writeMetaCampaignLabels,
  type MetaCampaignLabelInput,
} from "@/lib/meta/campaign-labels";
import { requestMetaSnapshotRefreshForBusiness } from "@/lib/meta/snapshot-refresh";

export const dynamic = "force-dynamic";

type WriteBody = {
  businessId?: unknown;
  labels?: unknown;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseCampaignIds(value: string | null) {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeBodyLabels(value: unknown): MetaCampaignLabelInput[] | null {
  if (!Array.isArray(value)) return null;
  const labels: MetaCampaignLabelInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    labels.push({
      campaignId: stringValue(row.campaignId),
      kind: row.kind as MetaCampaignLabelInput["kind"],
      testDimension: row.testDimension as MetaCampaignLabelInput["testDimension"],
      source: row.source as MetaCampaignLabelInput["source"],
      providerAccountId: stringValue(row.providerAccountId) || null,
      campaignName: stringValue(row.campaignName) || null,
    });
  }
  return labels;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const campaignIds = parseCampaignIds(searchParams.get("campaignIds"));

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const labels = await readMetaCampaignLabels({
    businessId: access.membership.businessId,
    campaignIds,
  });

  return NextResponse.json(
    { ok: true, businessId: access.membership.businessId, labels },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as WriteBody | null;
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_body", "A JSON body is required.");
  }

  const businessId = stringValue(body.businessId);
  const labels = normalizeBodyLabels(body.labels);
  if (!businessId || !labels) {
    return jsonError(400, "missing_params", "businessId and labels are required.");
  }
  if (labels.length === 0 || labels.length > 200) {
    return jsonError(400, "invalid_labels", "labels must contain 1 to 200 rows.");
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "campaign_labels_update");
  if (reviewerBlocked) return reviewerBlocked;

  try {
    const written = await writeMetaCampaignLabels({
      businessId: access.membership.businessId,
      labeledBy: access.session.user.id,
      labels,
    });
    const decisionSnapshotRefresh = await requestMetaSnapshotRefreshForBusiness({
      businessId: access.membership.businessId,
      reason: "campaign_labels_updated",
    });
    return NextResponse.json(
      {
        ok: true,
        businessId: access.membership.businessId,
        labels: written,
        decisionSnapshotRefresh,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      400,
      "invalid_label",
      error instanceof Error ? error.message : "Campaign label is invalid.",
    );
  }
}
