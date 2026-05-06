import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
  validateMetaAddToExistingPayloadShape,
  validateMetaLaunchPayloadShape,
  type LaunchpadIssue,
  type MetaAddToExistingPayload,
  type MetaLaunchPayload,
} from "@/lib/launchpad/meta";

const GRAPH_API_VERSION = "v22.0";

export interface MetaLaunchPixel {
  id: string;
  name: string | null;
  active: boolean;
  lastFiredTime: string | null;
}

export interface MetaLaunchValidationResult {
  ok: boolean;
  payload: MetaLaunchPayload;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
  pixels: MetaLaunchPixel[];
}

export interface MetaAddToExistingTargetValidation {
  campaignId: string | null;
  adsetId: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adsetStatus: string | null;
  providerAccountId: string | null;
}

export interface MetaAddToExistingCreativeStatus {
  creativeId: string;
  creativeName: string | null;
  effectiveStatus: string | null;
}

export interface MetaAddToExistingValidationResult {
  ok: boolean;
  payload: MetaAddToExistingPayload;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
  target: MetaAddToExistingTargetValidation | null;
  creatives: MetaAddToExistingCreativeStatus[];
}

function sanitizeMetaMessage(message: string) {
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function accountNumericId(providerAccountId: string) {
  return providerAccountId.trim().replace(/^act_/, "");
}

export async function resolveMetaLaunchWriteContext(
  businessId: string,
): Promise<
  | { ok: true; ctx: MetaAdsWriteContext }
  | { ok: false; blocker: LaunchpadIssue }
> {
  const integration = await getIntegration(businessId, "meta").catch(() => null);
  if (integration?.status !== "connected" || !integration.access_token) {
    return {
      ok: false,
      blocker: {
        code: "meta_not_connected",
        message: "Meta integration is not connected.",
      },
    };
  }
  const providerAccountId = integration.provider_account_id ?? null;
  if (!providerAccountId) {
    return {
      ok: false,
      blocker: {
        code: "meta_account_unresolved",
        message: "Meta ad account is not assigned.",
      },
    };
  }
  return {
    ok: true,
    ctx: {
      businessId,
      providerAccountId,
      accessToken: integration.access_token,
    },
  };
}

async function graphGet(ctx: MetaAdsWriteContext, path: string, fields?: string) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  url.searchParams.set("access_token", ctx.accessToken);
  if (fields) url.searchParams.set("fields", fields);
  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error)
      ? String(payload.error.message ?? "Meta API request failed.")
      : "Meta API request failed.";
    throw new Error(sanitizeMetaMessage(message));
  }
  return payload;
}

async function readBillingStatus(
  ctx: MetaAdsWriteContext,
): Promise<LaunchpadIssue | null> {
  const payload = await graphGet(
    ctx,
    `act_${accountNumericId(ctx.providerAccountId)}`,
    "account_status",
  );
  const status = isRecord(payload) ? Number(payload.account_status) : NaN;
  if (status === 1) return null;
  return {
    code: "billing_not_ok",
    message: "Meta ad account billing status is not active.",
  };
}

async function readPixels(ctx: MetaAdsWriteContext): Promise<MetaLaunchPixel[]> {
  const payload = await graphGet(
    ctx,
    `act_${accountNumericId(ctx.providerAccountId)}/adspixels`,
    "id,name,is_unavailable,last_fired_time",
  );
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  return data
    .filter(isRecord)
    .map((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      const unavailable = row.is_unavailable === true;
      return {
        id,
        name: typeof row.name === "string" ? row.name : null,
        active: Boolean(id) && !unavailable,
        lastFiredTime:
          typeof row.last_fired_time === "string" ? row.last_fired_time : null,
      };
    })
    .filter((row) => row.id);
}

async function readLatestCreativeStatuses(input: {
  businessId: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return new Map<string, string | null>();
  const sql = getDb();
  const rows = (await sql`
    SELECT target.creative_id, latest.effective_status
    FROM unnest(${input.creativeIds}::text[]) AS target(creative_id)
    LEFT JOIN LATERAL (
      SELECT effective_status
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND creative_id = target.creative_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) latest ON TRUE
  `) as Array<{ creative_id: string; effective_status: string | null }>;
  return new Map(
    rows.map((row) => [row.creative_id, row.effective_status ?? null]),
  );
}

async function readLatestCreativeStatusesWithNames(input: {
  businessId: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return [];
  const sql = getDb();
  const rows = (await sql`
    SELECT
      target.creative_id,
      COALESCE(latest.creative_name, dim.creative_name) AS creative_name,
      latest.effective_status
    FROM unnest(${input.creativeIds}::text[]) AS target(creative_id)
    LEFT JOIN LATERAL (
      SELECT creative_name, effective_status
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND creative_id = target.creative_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_name
      FROM meta_creative_dimensions
      WHERE business_id = ${input.businessId}
        AND creative_id = target.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim ON TRUE
  `) as Array<{
    creative_id: string;
    creative_name: string | null;
    effective_status: string | null;
  }>;
  return rows.map((row) => ({
    creativeId: row.creative_id,
    creativeName: row.creative_name ?? null,
    effectiveStatus: row.effective_status ?? null,
  }));
}

async function readAddToExistingTarget(input: {
  businessId: string;
  targetCampaignId: string;
  targetAdsetId: string;
}): Promise<MetaAddToExistingTargetValidation | null> {
  if (!input.targetCampaignId || !input.targetAdsetId) return null;
  const sql = getDb();
  const rows = (await sql`
    SELECT
      campaign.campaign_id,
      campaign.campaign_name_current,
      campaign.campaign_name_historical,
      adset.adset_id,
      adset.adset_name_current,
      adset.adset_name_historical,
      adset.adset_status,
      adset.provider_account_id
    FROM meta_adset_dimensions adset
    LEFT JOIN meta_campaign_dimensions campaign
      ON campaign.business_id = adset.business_id
      AND campaign.provider_account_id = adset.provider_account_id
      AND campaign.campaign_id = adset.campaign_id
    WHERE adset.business_id = ${input.businessId}
      AND adset.campaign_id = ${input.targetCampaignId}
      AND adset.adset_id = ${input.targetAdsetId}
    ORDER BY adset.updated_at DESC
    LIMIT 1
  `) as Array<{
    campaign_id: string | null;
    campaign_name_current: string | null;
    campaign_name_historical: string | null;
    adset_id: string | null;
    adset_name_current: string | null;
    adset_name_historical: string | null;
    adset_status: string | null;
    provider_account_id: string | null;
  }>;
  const row = rows[0];
  if (!row?.adset_id) return null;
  return {
    campaignId: row.campaign_id ?? input.targetCampaignId,
    adsetId: row.adset_id,
    campaignName: row.campaign_name_current ?? row.campaign_name_historical ?? null,
    adsetName: row.adset_name_current ?? row.adset_name_historical ?? null,
    adsetStatus: row.adset_status ?? null,
    providerAccountId: row.provider_account_id ?? null,
  };
}

export async function validateMetaLaunchRequest(input: {
  businessId: string;
  payload: unknown;
}): Promise<MetaLaunchValidationResult> {
  const payload = normalizeMetaLaunchPayload(input.payload);
  const shape = validateMetaLaunchPayloadShape(payload);
  const blockers = [...shape.blockers];
  const warnings = [...shape.warnings];
  let pixels: MetaLaunchPixel[] = [];

  const ctxResult = await resolveMetaLaunchWriteContext(input.businessId);
  if (!ctxResult.ok) {
    blockers.push(ctxResult.blocker);
  } else {
    try {
      const billingBlocker = await readBillingStatus(ctxResult.ctx);
      if (billingBlocker) blockers.push(billingBlocker);
    } catch (error) {
      blockers.push({
        code: "billing_check_failed",
        message: sanitizeMetaMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }

    try {
      pixels = await readPixels(ctxResult.ctx);
      const activePixelIds = new Set(
        pixels.filter((pixel) => pixel.active).map((pixel) => pixel.id),
      );
      const requestedPixelIds = Array.from(
        new Set(payload.adSets.map((adSet) => adSet.pixelId).filter(Boolean)),
      );
      if (requestedPixelIds.length === 0) {
        blockers.push({
          code: "pixel_required",
          message: "At least one active pixel is required.",
        });
      }
      requestedPixelIds.forEach((pixelId) => {
        if (!activePixelIds.has(pixelId)) {
          blockers.push({
            code: "pixel_not_active",
            message: `Pixel ${pixelId} is missing or inactive.`,
          });
        }
      });
    } catch (error) {
      blockers.push({
        code: "pixel_check_failed",
        message: sanitizeMetaMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  const statuses = await readLatestCreativeStatuses({
    businessId: input.businessId,
    creativeIds: payload.creativeIds,
  });
  payload.creativeIds.forEach((creativeId) => {
    const status = statuses.get(creativeId);
    const normalized = status?.trim().toUpperCase() ?? "";
    if (normalized === "REJECTED" || normalized === "DISAPPROVED") {
      blockers.push({
        code: "creative_rejected",
        message: `Creative ${creativeId} is rejected and cannot be launched.`,
      });
    }
  });

  return {
    ok: blockers.length === 0,
    payload,
    blockers,
    warnings,
    pixels,
  };
}

export async function validateMetaAddToExistingRequest(input: {
  businessId: string;
  payload: unknown;
}): Promise<MetaAddToExistingValidationResult> {
  const payload = normalizeMetaAddToExistingPayload(input.payload);
  const shape = validateMetaAddToExistingPayloadShape(payload);
  const blockers = [...shape.blockers];
  const warnings = [...shape.warnings];

  const target = await readAddToExistingTarget({
    businessId: input.businessId,
    targetCampaignId: payload.targetCampaignId,
    targetAdsetId: payload.targetAdsetId,
  });
  if (payload.targetAdsetId && !target) {
    blockers.push({
      code: "target_adset_not_found",
      message: "Target ad set was not found for this business and campaign.",
    });
  } else if (target) {
    const status = target.adsetStatus?.trim().toUpperCase() ?? "";
    if (status !== "ACTIVE") {
      blockers.push({
        code: "target_adset_not_active",
        message: "Target ad set must be ACTIVE.",
      });
    }
  }

  const creatives = await readLatestCreativeStatusesWithNames({
    businessId: input.businessId,
    creativeIds: payload.creativeIds,
  });
  const byCreativeId = new Map(creatives.map((creative) => [creative.creativeId, creative]));
  payload.creativeIds.forEach((creativeId) => {
    const status = byCreativeId.get(creativeId)?.effectiveStatus;
    const normalized = status?.trim().toUpperCase() ?? "";
    if (normalized === "REJECTED" || normalized === "DISAPPROVED") {
      blockers.push({
        code: "creative_rejected",
        message: `Creative ${creativeId} is rejected and cannot be launched.`,
      });
    }
  });

  return {
    ok: blockers.length === 0,
    payload,
    blockers,
    warnings,
    target,
    creatives,
  };
}
