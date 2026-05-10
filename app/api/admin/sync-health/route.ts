import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-logger";
import {
  cleanupGoogleAdsPartitionOrchestration,
  forceReplayGoogleAdsPoisonedPartitions,
  releaseGoogleAdsPoisonedPartitions,
  replayGoogleAdsDeadLetterPartitions,
} from "@/lib/google-ads/warehouse";
import { getAdminOperationsHealth } from "@/lib/admin-operations-health";
import { runGoogleAdsRepairCycle, runMetaRepairCycle } from "@/lib/sync/provider-repair-engine";
import {
  enqueueGoogleAdsScheduledWork,
  refreshGoogleAdsSyncStateForBusiness,
  runGoogleAdsTargetedRepair,
} from "@/lib/sync/google-ads-sync";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import {
  cleanupMetaPartitionOrchestration,
  getMetaAuthoritativeBusinessOpsSnapshot,
  replayMetaDeadLetterPartitions,
} from "@/lib/meta/warehouse";
import { enqueueMetaScheduledWork, refreshMetaSyncStateForBusiness } from "@/lib/sync/meta-sync";
import type { MetaWarehouseScope } from "@/lib/meta/warehouse-types";

const GOOGLE_ADS_RECOVERY_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "ad_group_daily",
  "ad_daily",
  "keyword_daily",
  "search_term_daily",
  "asset_group_daily",
  "asset_daily",
  "audience_daily",
  "geo_daily",
  "device_daily",
  "product_daily",
];

const META_RECOVERY_SCOPES: MetaWarehouseScope[] = [
  "account_daily",
  "adset_daily",
  "creative_daily",
  "ad_daily",
];

type SyncRecoveryRequestBody = {
  provider?: string;
  action?:
    | "cleanup"
    | "replay_dead_letter"
    | "reschedule"
    | "refresh_state"
    | "release_quarantine"
    | "force_manual_replay"
    | "targeted_repair"
    | "repair_cycle"
    | "repair_integrity_windows";
  businessId?: string;
  scope?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const adminSession = auth.session;

    const data = await getAdminOperationsHealth();
    return NextResponse.json(data.syncHealth);
  } catch (err) {
    console.error("[admin/sync-health GET]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let adminSession: Awaited<ReturnType<typeof requireAdmin>>["session"] | null = null;
  let body: SyncRecoveryRequestBody | null = null;
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    adminSession = auth.session;

    body = (await request.json().catch(() => null)) as SyncRecoveryRequestBody | null;

    if (!body?.provider || !body?.action || !body?.businessId) {
      return NextResponse.json(
        { error: "provider, action and businessId are required." },
        { status: 400 }
      );
    }

    async function logRecovery(outcome: "completed" | "rejected", meta?: Record<string, unknown>) {
      await logAdminAction({
        adminId: adminSession!.user.id,
        action: "sync.recovery",
        targetType: "business",
        targetId: body!.businessId,
        meta: {
          provider: body!.provider,
          requestedAction: body!.action,
          outcome,
          ...meta,
        },
      });
    }

    if (body.provider !== "google_ads" && body.provider !== "meta") {
      return NextResponse.json(
        { error: "Only google_ads and meta recovery actions are supported in this endpoint." },
        { status: 400 }
      );
    }

    if (body.provider === "meta") {
      if (body.action === "cleanup") {
        const result = await cleanupMetaPartitionOrchestration({
          businessId: body.businessId,
        });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result, authoritative });
      }

      if (body.action === "replay_dead_letter") {
        const scope =
          body.scope && META_RECOVERY_SCOPES.includes(body.scope as MetaWarehouseScope)
            ? (body.scope as MetaWarehouseScope)
            : null;
        const result = await replayMetaDeadLetterPartitions({
          businessId: body.businessId,
          scope,
          recoveryKinds: ["replayable_transient"],
        });
        const scheduled = await enqueueMetaScheduledWork(body.businessId);
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", {
          scope,
          outcome: result.outcome,
          replayedCount: result.changedCount,
          matchedCount: result.matchedCount,
          skippedActiveLeaseCount: result.skippedActiveLeaseCount,
          scheduled,
        });
        return NextResponse.json({
          ok: true,
          action: body.action,
          provider: body.provider,
          replayedCount: result.changedCount,
          matchedCount: result.matchedCount,
          skippedActiveLeaseCount: result.skippedActiveLeaseCount,
          result: result.partitions,
          outcome: result.outcome,
          scheduled,
          authoritative,
        });
      }

      if (body.action === "refresh_state") {
        await refreshMetaSyncStateForBusiness({ businessId: body.businessId });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed");
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, authoritative });
      }

      if (body.action === "reschedule") {
        const result = await enqueueMetaScheduledWork(body.businessId);
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result, authoritative });
      }

      if (body.action === "repair_cycle" || body.action === "repair_integrity_windows") {
        const result = await runMetaRepairCycle(body.businessId, {
          enqueueScheduledWork: body.action === "repair_cycle",
          queueWarehouseRepairs: true,
        });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({
          ok: true,
          action: body.action,
          provider: body.provider,
          result,
          authoritative,
        });
      }
    }

    if (body.action === "cleanup") {
      const result = await cleanupGoogleAdsPartitionOrchestration({
        businessId: body.businessId,
      });
      await logRecovery("completed", { result });
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result });
    }

    if (body.action === "replay_dead_letter") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await replayGoogleAdsDeadLetterPartitions({
        businessId: body.businessId,
        scope,
        recoveryKinds: ["replayable_transient", "unknown"],
      });
      const scheduled = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        scheduled,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
        scheduled,
      });
    }

    if (body.action === "refresh_state") {
      await refreshGoogleAdsSyncStateForBusiness({ businessId: body.businessId });
      await logRecovery("completed");
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider });
    }

    if (body.action === "release_quarantine") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await releaseGoogleAdsPoisonedPartitions({
        businessId: body.businessId,
        scope,
      });
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        releasedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        releasedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
      });
    }

    if (body.action === "force_manual_replay") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await forceReplayGoogleAdsPoisonedPartitions({
        businessId: body.businessId,
        scope,
      });
      const scheduled = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        scheduled,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
        scheduled,
      });
    }

    if (body.action === "reschedule") {
      const result = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", { result });
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result });
    }

    if (body.action === "targeted_repair") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      if (!scope || !body.startDate || !body.endDate) {
        return NextResponse.json(
          { error: "scope, startDate and endDate are required for targeted_repair." },
          { status: 400 }
        );
      }

      const result = await runGoogleAdsTargetedRepair({
        businessId: body.businessId,
        scope,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      await logRecovery("completed", {
        scope,
        startDate: body.startDate,
        endDate: body.endDate,
        result,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        result,
      });
    }

    if (body.action === "repair_cycle" || body.action === "repair_integrity_windows") {
      const result = await runGoogleAdsRepairCycle(body.businessId, {
        enqueueScheduledWork: body.action === "repair_cycle",
        queueWarehouseRepairs: true,
      });
      await logRecovery("completed", { result });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        result,
      });
    }

    await logRecovery("rejected");
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    if (adminSession?.user.id && body?.provider && body?.action && body?.businessId) {
      await logAdminAction({
        adminId: adminSession.user.id,
        action: "sync.recovery",
        targetType: "business",
        targetId: body.businessId,
        meta: {
          provider: body.provider,
          requestedAction: body.action,
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => null);
    }
    console.error("[admin/sync-health POST]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}
