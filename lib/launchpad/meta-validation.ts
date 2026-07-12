import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
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
  sourceAdId: string | null;
  providerAccountId: string | null;
}

export interface MetaBulkResumePreflightTarget {
  adId: string;
  creativeId: string | null;
  providerAccountId: string | null;
}

export interface MetaBulkResumePreflightResult {
  ok: boolean;
  blockers: Array<LaunchpadIssue & { adId?: string }>;
}

export interface MetaAddToExistingValidationResult {
  ok: boolean;
  payload: MetaAddToExistingPayload;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
  target: MetaAddToExistingTargetValidation | null;
  targets: MetaAddToExistingTargetValidation[];
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

export function normalizeMetaLaunchProviderAccountId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const numericId = trimmed.replace(/^act_/i, "");
  return /^\d+$/.test(numericId) ? `act_${numericId}` : trimmed;
}

export function metaLaunchAccountBlockerHttpStatus(code: string): 400 | 403 | 503 {
  if (code === "provider_account_not_assigned") return 403;
  if (code === "provider_account_scope_unavailable") return 503;
  return 400;
}

export async function resolveAssignedMetaLaunchAccount(input: {
  businessId: string;
  providerAccountId: string | null | undefined;
}): Promise<
  | { ok: true; providerAccountId: string }
  | { ok: false; blocker: LaunchpadIssue }
> {
  const providerAccountId = normalizeMetaLaunchProviderAccountId(
    input.providerAccountId,
  );
  if (!providerAccountId) {
    return {
      ok: false,
      blocker: {
        code: "provider_account_id_required",
        message: "providerAccountId is required for every Meta Launchpad action.",
      },
    };
  }

  let assignments;
  try {
    assignments = await getProviderAccountAssignments(input.businessId, "meta");
  } catch {
    return {
      ok: false,
      blocker: {
        code: "provider_account_scope_unavailable",
        message: "Meta account assignments are unavailable right now.",
      },
    };
  }
  const assigned = new Set(
    (assignments?.account_ids ?? []).map(normalizeMetaLaunchProviderAccountId),
  );
  if (!assigned.has(providerAccountId)) {
    return {
      ok: false,
      blocker: {
        code: "provider_account_not_assigned",
        message: "providerAccountId is not assigned to this business.",
      },
    };
  }
  return { ok: true, providerAccountId };
}

export async function resolveMetaLaunchWriteContext(
  businessId: string,
  requestedProviderAccountId: string | null | undefined,
): Promise<
  | { ok: true; ctx: MetaAdsWriteContext }
  | { ok: false; blocker: LaunchpadIssue }
> {
  const account = await resolveAssignedMetaLaunchAccount({
    businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!account.ok) return account;

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
  return {
    ok: true,
    ctx: {
      businessId,
      providerAccountId: account.providerAccountId,
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
  providerAccountId: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) {
    return new Map<string, { found: boolean; status: string | null }>();
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT
      target.creative_id,
      COALESCE(latest.creative_id, dimension.creative_id) AS resolved_creative_id,
      latest.effective_status
    FROM unnest(${input.creativeIds}::text[]) AS target(creative_id)
    LEFT JOIN LATERAL (
      SELECT creative_id, effective_status
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND creative_id = target.creative_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_id
      FROM meta_creative_dimensions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND creative_id = target.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dimension ON TRUE
  `) as Array<{
    creative_id: string;
    resolved_creative_id: string | null;
    effective_status: string | null;
  }>;
  return new Map(
    rows.map((row) => [
      row.creative_id,
      {
        found: Boolean(row.resolved_creative_id),
        status: row.effective_status ?? null,
      },
    ]),
  );
}

async function readLatestCreativeStatusesWithNames(input: {
  businessId: string;
  providerAccountId: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return [];
  const sql = getDb();
  const rows = (await sql`
    SELECT
      target.creative_id,
      COALESCE(latest.creative_name, dim.creative_name) AS creative_name,
      latest.effective_status,
      COALESCE(latest.ad_id, dim.ad_id) AS source_ad_id,
      COALESCE(latest.provider_account_id, dim.provider_account_id) AS provider_account_id
    FROM unnest(${input.creativeIds}::text[]) AS target(creative_id)
    LEFT JOIN LATERAL (
      SELECT creative_name, effective_status, ad_id, provider_account_id
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND creative_id = target.creative_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_name, ad_id, provider_account_id
      FROM meta_creative_dimensions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND creative_id = target.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim ON TRUE
  `) as Array<{
    creative_id: string;
    creative_name: string | null;
    effective_status: string | null;
    source_ad_id: string | null;
    provider_account_id: string | null;
  }>;
  return rows.map((row) => ({
    creativeId: row.creative_id,
    creativeName: row.creative_name ?? null,
    effectiveStatus: row.effective_status ?? null,
    sourceAdId: row.source_ad_id ?? null,
    providerAccountId: row.provider_account_id ?? null,
  }));
}

async function readAddToExistingTarget(input: {
  businessId: string;
  providerAccountId: string;
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
      AND adset.provider_account_id = ${input.providerAccountId}
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
  providerAccountId: string;
  payload: unknown;
}): Promise<MetaLaunchValidationResult> {
  const payload = normalizeMetaLaunchPayload(input.payload);
  const shape = validateMetaLaunchPayloadShape(payload);
  const blockers = [...shape.blockers];
  const warnings = [...shape.warnings];
  let pixels: MetaLaunchPixel[] = [];

  const ctxResult = await resolveMetaLaunchWriteContext(
    input.businessId,
    input.providerAccountId,
  );
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
    providerAccountId: input.providerAccountId,
    creativeIds: payload.creativeIds,
  });
  payload.creativeIds.forEach((creativeId) => {
    const creative = statuses.get(creativeId);
    if (!creative?.found) {
      blockers.push({
        code: "creative_not_found_in_account",
        message: `Creative ${creativeId} is not available in the selected Meta ad account.`,
      });
      return;
    }
    const status = creative.status;
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
  providerAccountId: string;
  payload: unknown;
}): Promise<MetaAddToExistingValidationResult> {
  const payload = normalizeMetaAddToExistingPayload(input.payload);
  const shape = validateMetaAddToExistingPayloadShape(payload);
  const blockers = [...shape.blockers];
  const warnings = [...shape.warnings];

  const targetResults = await Promise.all(
    payload.targets.map((target) =>
      readAddToExistingTarget({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        targetCampaignId: target.targetCampaignId,
        targetAdsetId: target.targetAdsetId,
      }),
    ),
  );
  const targets = targetResults.filter(
    (target): target is MetaAddToExistingTargetValidation => Boolean(target),
  );
  payload.targets.forEach((requestedTarget, index) => {
    const target = targetResults[index] ?? null;
    if (requestedTarget.targetAdsetId && !target) {
      blockers.push({
        code: "target_adset_not_found",
        message: `Target ${index + 1} ad set was not found for this business and campaign.`,
      });
      return;
    }
    if (target) {
      const status = target.adsetStatus?.trim().toUpperCase() ?? "";
      if (status !== "ACTIVE") {
        blockers.push({
          code: "target_adset_not_active",
          message: `Target ${index + 1} ad set must be ACTIVE.`,
        });
      }
      if (!target.providerAccountId) {
        blockers.push({
          code: "target_account_unresolved",
          message: `Target ${index + 1} ad set account could not be resolved.`,
        });
      } else if (
        normalizeMetaLaunchProviderAccountId(target.providerAccountId) !==
        normalizeMetaLaunchProviderAccountId(input.providerAccountId)
      ) {
        blockers.push({
          code: "target_account_mismatch",
          message: `Target ${index + 1} does not belong to the selected Meta ad account.`,
        });
      }
    }
  });

  const creatives = await readLatestCreativeStatusesWithNames({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    creativeIds: payload.creativeIds,
  });
  const byCreativeId = new Map(creatives.map((creative) => [creative.creativeId, creative]));
  const submittedCreativeById = new Map(
    payload.creatives.map((creative) => [creative.creativeId, creative]),
  );
  payload.creativeIds.forEach((creativeId) => {
    const creative = byCreativeId.get(creativeId);
    if (!creative?.providerAccountId) {
      blockers.push({
        code: "creative_not_found_in_account",
        message: `Creative ${creativeId} is not available in the selected Meta ad account.`,
      });
    } else if (
      normalizeMetaLaunchProviderAccountId(creative.providerAccountId) !==
      normalizeMetaLaunchProviderAccountId(input.providerAccountId)
    ) {
      blockers.push({
        code: "creative_account_mismatch",
        message: `Creative ${creativeId} does not belong to the selected Meta ad account.`,
      });
    }
    const status = creative?.effectiveStatus;
    const normalized = status?.trim().toUpperCase() ?? "";
    if (normalized === "REJECTED" || normalized === "DISAPPROVED") {
      blockers.push({
        code: "creative_rejected",
        message: `Creative ${creativeId} is rejected and cannot be launched.`,
      });
    }
    const sourceAdId =
      submittedCreativeById.get(creativeId)?.sourceAdId?.trim() ||
      creative?.sourceAdId?.trim() ||
      "";
    if (!sourceAdId) {
      blockers.push({
        code: "source_ad_required",
        message: `Creative ${creativeId} needs a source Meta ad before it can be added to an existing ad set.`,
      });
    }
  });

  if (payload.copyMode === "reuse_creative") {
    const sourceAccounts = new Set(
      creatives
        .map((creative) => creative.providerAccountId?.trim())
        .filter((account): account is string => Boolean(account)),
    );
    const targetAccounts = new Set(
      targets
        .map((target) => target.providerAccountId?.trim())
        .filter((account): account is string => Boolean(account)),
    );
    const hasCrossAccountSelection =
      sourceAccounts.size > 0 &&
      targetAccounts.size > 0 &&
      Array.from(sourceAccounts).some((sourceAccount) => !targetAccounts.has(sourceAccount));
    if (hasCrossAccountSelection) {
      blockers.push({
        code: "cross_account_duplicate_not_supported",
        message:
          "Duplicate mode cannot use a creative from another Meta ad account. Choose Recreate exact ad for cross-account launches.",
      });
    }
  }

  return {
    ok: blockers.length === 0,
    payload,
    blockers,
    warnings,
    target: targets[0] ?? null,
    targets,
    creatives,
  };
}

const NON_RESUMABLE_EFFECTIVE_STATUSES = new Set([
  "ARCHIVED",
  "DELETED",
  "DISAPPROVED",
  "PENDING_REVIEW",
  "PREAPPROVED",
  "WITH_ISSUES",
]);

function readProviderString(
  payload: Record<string, unknown> | null,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readPromotedObjectField(
  promotedObject: Record<string, unknown> | null,
  snakeKey: string,
  camelKey: string,
) {
  const value = promotedObject?.[snakeKey] ?? promotedObject?.[camelKey];
  return typeof value === "string" ? value.trim() : "";
}

export async function validateMetaBulkResumePreflight(input: {
  ctx: MetaAdsWriteContext;
  targets: MetaBulkResumePreflightTarget[];
}): Promise<MetaBulkResumePreflightResult> {
  const blockers: MetaBulkResumePreflightResult["blockers"] = [];
  const accountState = new Map<
    string,
    { ctx: MetaAdsWriteContext; activePixelIds: Set<string> }
  >();

  for (const providerAccountId of Array.from(
    new Set(
      input.targets
        .map((target) => target.providerAccountId?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  )) {
    const ctx = { ...input.ctx, providerAccountId };
    try {
      const billingBlocker = await readBillingStatus(ctx);
      if (billingBlocker) blockers.push(billingBlocker);
      const pixels = await readPixels(ctx);
      accountState.set(providerAccountId, {
        ctx,
        activePixelIds: new Set(
          pixels.filter((pixel) => pixel.active).map((pixel) => pixel.id),
        ),
      });
    } catch (error) {
      blockers.push({
        code: "account_preflight_failed",
        message: sanitizeMetaMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  for (const target of input.targets) {
    const providerAccountId = target.providerAccountId?.trim() ?? "";
    const state = accountState.get(providerAccountId);
    if (!providerAccountId || !state) {
      blockers.push({
        code: "target_account_unresolved",
        message: `Ad ${target.adId} account could not be verified.`,
        adId: target.adId,
      });
      continue;
    }

    try {
      const adPayload = await graphGet(
        state.ctx,
        target.adId,
        "id,account_id,status,effective_status,creative{id},adset_id",
      );
      if (!isRecord(adPayload) || readProviderString(adPayload, "id") !== target.adId) {
        blockers.push({
          code: "ad_live_state_unresolved",
          message: `Ad ${target.adId} live state could not be verified.`,
          adId: target.adId,
        });
        continue;
      }
      const liveAccountId = readProviderString(adPayload, "account_id").replace(
        /^act_/,
        "",
      );
      if (
        liveAccountId &&
        liveAccountId !== providerAccountId.replace(/^act_/, "")
      ) {
        blockers.push({
          code: "target_account_mismatch",
          message: `Ad ${target.adId} belongs to a different Meta account.`,
          adId: target.adId,
        });
      }
      const effectiveStatus = (
        readProviderString(adPayload, "effective_status") ||
        readProviderString(adPayload, "status")
      ).toUpperCase();
      if (NON_RESUMABLE_EFFECTIVE_STATUSES.has(effectiveStatus)) {
        blockers.push({
          code: "creative_not_resumable",
          message: `Ad ${target.adId} is ${effectiveStatus.toLowerCase()} and cannot be resumed.`,
          adId: target.adId,
        });
      }
      const liveCreativeId = readProviderString(
        isRecord(adPayload.creative) ? adPayload.creative : null,
        "id",
      );
      if (
        target.creativeId &&
        (!liveCreativeId || liveCreativeId !== target.creativeId)
      ) {
        blockers.push({
          code: "creative_identity_mismatch",
          message: `Ad ${target.adId} no longer references the expected creative.`,
          adId: target.adId,
        });
      }

      const adsetId = readProviderString(adPayload, "adset_id");
      if (!adsetId) {
        blockers.push({
          code: "parent_adset_unresolved",
          message: `Ad ${target.adId} parent ad set could not be verified.`,
          adId: target.adId,
        });
        continue;
      }
      const adsetPayload = await graphGet(
        state.ctx,
        adsetId,
        "id,status,effective_status,promoted_object",
      );
      const adsetStatus = readProviderString(
        isRecord(adsetPayload) ? adsetPayload : null,
        "status",
      ).toUpperCase();
      const adsetEffectiveStatus = readProviderString(
        isRecord(adsetPayload) ? adsetPayload : null,
        "effective_status",
      ).toUpperCase();
      if (adsetStatus !== "ACTIVE" || adsetEffectiveStatus !== "ACTIVE") {
        blockers.push({
          code: "parent_adset_not_active",
          message: `Ad ${target.adId} parent ad set must be fully active before the ad can be resumed.`,
          adId: target.adId,
        });
      }
      const promotedObject =
        isRecord(adsetPayload) && isRecord(adsetPayload.promoted_object)
          ? adsetPayload.promoted_object
          : null;
      const pixelId = readPromotedObjectField(
        promotedObject,
        "pixel_id",
        "pixelId",
      );
      if (!pixelId || !state.activePixelIds.has(pixelId)) {
        blockers.push({
          code: "pixel_not_active",
          message: `Ad ${target.adId} conversion pixel is missing or inactive.`,
          adId: target.adId,
        });
      }
    } catch (error) {
      blockers.push({
        code: "ad_live_preflight_failed",
        message: sanitizeMetaMessage(
          error instanceof Error ? error.message : String(error),
        ),
        adId: target.adId,
      });
    }
  }

  return { ok: blockers.length === 0, blockers };
}
