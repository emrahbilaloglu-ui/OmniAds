import { NextRequest, NextResponse } from "next/server";
import type {
  MetaDecisionsWorkspaceBanner,
  MetaDecisionsWorkspacePayload,
  MetaLanePayload,
  MetaPulsePayload,
  MetaWindowKey,
} from "@/components/meta/redesign/types";
import { findMembership } from "@/lib/access";
import { getSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isReviewerEmail } from "@/lib/reviewer-access";

export const dynamic = "force-dynamic";

type UpstreamName = "account-pulse" | "lane-classify";
// The upstream account-pulse / lane-classify routes can be slow to respond on a cold
// dev compile (each route module compiles on first hit, 2-9s under webpack), which used
// to abort the whole workspace to a 504 → the Decisions page rendered an empty shell.
// Give dev generous headroom; keep prod tighter but above the old 8s so a slow warm
// query no longer blanks the page. (The right long-term fix is to drop the HTTP
// self-fetch for in-process calls — tracked in the redesign plan.)
const WORKSPACE_UPSTREAM_TIMEOUT_MS =
  process.env.NODE_ENV === "production" ? 15_000 : 45_000;

class UpstreamError extends Error {
  constructor(
    readonly source: UpstreamName,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`Meta decisions workspace upstream failed: ${source}`);
  }
}

function forwardedHeaders(request: NextRequest) {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function workspaceParams(source: URLSearchParams) {
  const params = new URLSearchParams();
  for (const key of ["businessId", "window", "status_filter", "startDate", "endDate"]) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  return params;
}

async function readInternalJson<T>(
  request: NextRequest,
  source: UpstreamName,
  pathname: string,
  params: URLSearchParams,
): Promise<T> {
  const url = new URL(pathname, request.nextUrl.origin);
  url.search = params.toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKSPACE_UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: forwardedHeaders(request),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UpstreamError(source, 504, {
        error: "upstream_timeout",
        timeoutMs: WORKSPACE_UPSTREAM_TIMEOUT_MS,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: "invalid_json", raw };
    }
  }
  if (!response.ok) {
    throw new UpstreamError(source, response.status, payload);
  }
  return payload as T;
}

function isTrackingBlocked(pulse: MetaPulsePayload) {
  return (
    pulse.trackingAnomalyActive === true ||
    pulse.trackingHealth.status === "blocked" ||
    pulse.trackingHealth.status === "degraded"
  );
}

function isMetaWritesKillSwitchEngaged() {
  const value = process.env.META_ADS_WRITE_KILL_SWITCH?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function workspaceViewer(
  request: NextRequest,
  businessId: string,
): Promise<MetaDecisionsWorkspacePayload["viewer"]> {
  const session = await getSessionFromRequest(request).catch(() => null);
  if (!session) return null;
  const membership = await findMembership({
    userId: session.user.id,
    businessId,
  }).catch(() => null);
  const role = membership?.status === "active" ? membership.role : null;
  const reviewer = isReviewerEmail(session.user.email);
  const readOnly = reviewer || role === "guest";
  return {
    role,
    isReviewer: reviewer,
    readOnly,
    readOnlyReason: reviewer
      ? "You have read-only access: all evidence is visible, write controls are downgraded to review."
      : role === "guest"
        ? "Your workspace role is Guest: all evidence is visible, write controls are downgraded to review."
        : null,
  };
}

function queueGroups(lanes: MetaLanePayload): MetaDecisionsWorkspacePayload["queue"]["groups"] {
  return [
    { key: "action", label: "Action Now", count: lanes.counts.actionNow },
    { key: "watching", label: "Watching", count: lanes.counts.watching },
    { key: "healthy", label: "Healthy", count: lanes.counts.healthy },
    { key: "nonSales", label: "Non-sales", count: lanes.counts.nonSales },
    { key: "archive", label: "Archive", count: lanes.counts.archive },
  ];
}

function actionStates(lanes: MetaLanePayload): MetaDecisionsWorkspacePayload["queue"]["actionStates"] {
  const recommendations = [...lanes.actionNow, ...lanes.watching, ...lanes.nonSales];
  return recommendations.reduce<MetaDecisionsWorkspacePayload["queue"]["actionStates"]>(
    (acc, rec) => {
      if (rec.actionKind === "execute_pause") acc.executablePause += 1;
      else if (rec.actionKind === "execute_bid") acc.executableBid += 1;
      else if (rec.actionKind === "execute_resume") acc.executableResume += 1;
      else if (rec.actionKind === "route_launchpad_duplicate" || rec.actionKind === "route_launchpad_rebuild") {
        acc.launchpadRoutes += 1;
      } else if (rec.actionKind === "review_drill") {
        acc.reviewOnly += 1;
      } else {
        acc.missingActionKind += 1;
      }
      return acc;
    },
    {
      executablePause: 0,
      executableBid: 0,
      executableResume: 0,
      launchpadRoutes: 0,
      reviewOnly: 0,
      missingActionKind: 0,
    },
  );
}

type DecisionDigest = MetaDecisionsWorkspacePayload["digest"];

type LabelFlipDigestRow = {
  rec_id: string;
  scope_id: string;
  title: string | null;
  snapshot_date: string | null;
  previous_label: string | null;
  current_label: string | null;
};

type ActionDigestRow = {
  id: string;
  action: string;
  status: "success" | "silent_failure";
  target: string | null;
  actor: string | null;
  occurred_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

type AnomalyDigestRow = {
  id: string;
  title: string | null;
  status: "open" | "resolved";
  occurred_at: string | null;
};

type DeferralDigestRow = {
  rec_id: string;
  title: string | null;
  due_at: string | null;
  detail: string | null;
};

function emptyDecisionDigest(snapshotDate: string | null): DecisionDigest {
  return {
    snapshotDate,
    unavailableReason: null,
    labelFlips: { count: 0, publishedCount: 0, items: [] },
    actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
    anomalies: { openedCount: 0, items: [] },
    deferrals: { dueCount: 0, items: [] },
  };
}

function normalizeDigestLabel(value: string | null | undefined) {
  const label = value?.trim();
  return label ? label.replace(/_/g, " ") : "unknown";
}

function digestSince(snapshotDate: string | null, fallbackEndDate: string | null) {
  const source = snapshotDate ?? fallbackEndDate;
  if (!source) return null;
  const date = new Date(`${source.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function readDecisionDigest(input: {
  businessId: string;
  snapshotDate: string | null;
  endDate: string | null;
}): Promise<DecisionDigest> {
  const digest = emptyDecisionDigest(input.snapshotDate);
  try {
    const sql = getDb();
    const since = digestSince(input.snapshotDate, input.endDate);
    const [labelRows, actionRows, anomalyRows, deferralRows] = await Promise.all([
      sql`
        WITH target_date AS (
          SELECT COALESCE(
            ${input.snapshotDate}::date,
            (SELECT MAX(snapshot_date) FROM meta_decision_snapshots_daily WHERE business_id = ${input.businessId})
          ) AS snapshot_date
        ),
        latest AS (
          SELECT snapshot.*
          FROM meta_decision_snapshots_daily snapshot
          JOIN target_date ON target_date.snapshot_date = snapshot.snapshot_date
          WHERE snapshot.business_id = ${input.businessId}
            AND COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
        )
        SELECT
          latest.rec_id,
          latest.scope_id,
          latest.snapshot_date::text AS snapshot_date,
          COALESCE(
            NULLIF(latest.evidence->>'title', ''),
            NULLIF(latest.evidence->>'name', ''),
            NULLIF(latest.evidence->>'scope_name', ''),
            latest.scope_id
          ) AS title,
          COALESCE(NULLIF(previous.decision_label, ''), previous.decision_state) AS previous_label,
          COALESCE(NULLIF(latest.decision_label, ''), latest.decision_state) AS current_label
        FROM latest
        JOIN LATERAL (
          SELECT previous_snapshot.*
          FROM meta_decision_snapshots_daily previous_snapshot
          WHERE previous_snapshot.business_id = latest.business_id
            AND previous_snapshot.scope_type = latest.scope_type
            AND previous_snapshot.scope_id = latest.scope_id
            AND previous_snapshot.rec_type = latest.rec_type
            AND previous_snapshot.snapshot_date < latest.snapshot_date
          ORDER BY previous_snapshot.snapshot_date DESC
          LIMIT 1
        ) previous ON TRUE
        WHERE COALESCE(NULLIF(previous.decision_label, ''), previous.decision_state)
          IS DISTINCT FROM COALESCE(NULLIF(latest.decision_label, ''), latest.decision_state)
        ORDER BY latest.snapshot_date DESC, latest.created_at DESC
        LIMIT 20
      ` as Promise<LabelFlipDigestRow[]>,
      sql`
        SELECT
          log.id::text AS id,
          log.action::text AS action,
          log.status::text AS status,
          COALESCE(
            NULLIF(ad.ad_name_current, ''),
            NULLIF(ad.ad_name_historical, ''),
            NULLIF(log.payload_request->>'target_name', ''),
            NULLIF(log.payload_request->>'source_name', ''),
            NULLIF(log.payload_request->'body'->>'name', ''),
            log.resulting_ad_id,
            log.ad_id
          ) AS target,
          COALESCE(NULLIF(users.name, ''), NULLIF(users.email, ''), NULLIF(log.source, '')) AS actor,
          COALESCE(log.verified_at, log.updated_at, log.requested_at, log.created_at)::text AS occurred_at,
          log.error_code,
          log.error_message
        FROM meta_ads_action_log log
        LEFT JOIN users ON users.id = log.requested_by
        LEFT JOIN LATERAL (
          SELECT ad_name_current, ad_name_historical
          FROM meta_ad_dimensions
          WHERE business_id = ${input.businessId}
            AND ad_id = COALESCE(log.resulting_ad_id, log.ad_id)
          ORDER BY updated_at DESC
          LIMIT 1
        ) ad ON TRUE
        WHERE log.business_id::text = ${input.businessId}
          AND log.status IN ('success', 'silent_failure')
          AND (${since}::timestamptz IS NULL OR log.requested_at >= ${since}::timestamptz)
        ORDER BY COALESCE(log.verified_at, log.updated_at, log.requested_at, log.created_at) DESC
        LIMIT 20
      ` as Promise<ActionDigestRow[]>,
      sql`
        SELECT
          snapshot.rec_id AS id,
          COALESCE(
            NULLIF(snapshot.evidence->>'title', ''),
            NULLIF(snapshot.evidence->>'name', ''),
            NULLIF(snapshot.reasoning, ''),
            snapshot.scope_id
          ) AS title,
          CASE WHEN snapshot.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status,
          COALESCE(snapshot.detected_at, snapshot.created_at)::text AS occurred_at
        FROM meta_decision_snapshots_daily snapshot
        WHERE snapshot.business_id = ${input.businessId}
          AND COALESCE(snapshot.kind, 'recommendation') = 'anomaly'
          AND (${since}::timestamptz IS NULL OR COALESCE(snapshot.detected_at, snapshot.created_at) >= ${since}::timestamptz)
        ORDER BY COALESCE(snapshot.detected_at, snapshot.created_at) DESC
        LIMIT 20
      ` as Promise<AnomalyDigestRow[]>,
      sql`
        WITH ranked AS (
          SELECT
            response.rec_id,
            response.action,
            response.action_subtype,
            response.reappear_at,
            response.timestamp,
            ROW_NUMBER() OVER (PARTITION BY response.rec_id ORDER BY response.timestamp DESC) AS row_number
          FROM meta_decision_responses response
          WHERE response.business_id = ${input.businessId}
        )
        SELECT
          ranked.rec_id,
          COALESCE(NULLIF(snapshot.evidence->>'title', ''), NULLIF(snapshot.evidence->>'name', ''), ranked.rec_id) AS title,
          ranked.reappear_at::text AS due_at,
          ranked.action_subtype AS detail
        FROM ranked
        LEFT JOIN LATERAL (
          SELECT evidence
          FROM meta_decision_snapshots_daily snapshot
          WHERE snapshot.business_id = ${input.businessId}
            AND snapshot.rec_id = ranked.rec_id
          ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC
          LIMIT 1
        ) snapshot ON TRUE
        WHERE ranked.row_number = 1
          AND ranked.action = 'deferred'
          AND ranked.reappear_at IS NOT NULL
          AND ranked.reappear_at <= NOW()
        ORDER BY ranked.reappear_at ASC
        LIMIT 20
      ` as Promise<DeferralDigestRow[]>,
    ]);

    const actions = actionRows.map((row) => ({
      id: row.id,
      action: normalizeDigestLabel(row.action),
      target: row.target?.trim() || "unknown target",
      actor: row.actor?.trim() || null,
      status: row.status === "silent_failure" ? ("silent_failure" as const) : ("verified" as const),
      occurredAt: row.occurred_at ?? null,
      detail: row.status === "silent_failure"
        ? row.error_message ?? row.error_code ?? "Meta verification disagreed."
        : null,
    }));

    return {
      snapshotDate: input.snapshotDate,
      unavailableReason: null,
      labelFlips: {
        count: labelRows.length,
        publishedCount: labelRows.length,
        items: labelRows.map((row) => ({
          id: row.rec_id,
          title: row.title?.trim() || row.scope_id,
          previousLabel: normalizeDigestLabel(row.previous_label),
          currentLabel: normalizeDigestLabel(row.current_label),
          status: "published",
          occurredAt: row.snapshot_date,
        })),
      },
      actions: {
        verifiedCount: actions.filter((item) => item.status === "verified").length,
        silentFailureCount: actions.filter((item) => item.status === "silent_failure").length,
        items: actions,
      },
      anomalies: {
        openedCount: anomalyRows.filter((row) => row.status === "open").length,
        items: anomalyRows.map((row) => ({
          id: row.id,
          title: row.title?.trim() || row.id,
          status: row.status,
          occurredAt: row.occurred_at ?? null,
        })),
      },
      deferrals: {
        dueCount: deferralRows.length,
        items: deferralRows.map((row) => ({
          id: row.rec_id,
          title: row.title?.trim() || row.rec_id,
          dueAt: row.due_at ?? null,
          detail: row.detail?.trim() || null,
        })),
      },
    };
  } catch {
    return {
      ...digest,
      unavailableReason: "Digest source tables are not available in this runtime.",
    };
  }
}

function workspaceBanners(input: {
  pulse: MetaPulsePayload;
  lanes: MetaLanePayload;
  trackingBlocked: boolean;
  killSwitchEngaged: boolean;
  viewer: MetaDecisionsWorkspacePayload["viewer"];
}): MetaDecisionsWorkspaceBanner[] {
  const banners: MetaDecisionsWorkspaceBanner[] = [];
  if (input.viewer?.readOnly && input.viewer.readOnlyReason) {
    banners.push({
      id: input.viewer.isReviewer ? "reviewer_read_only" : "workspace_read_only",
      tone: "info",
      title: input.viewer.isReviewer ? "Reviewer access is read-only." : "Workspace access is read-only.",
      detail: input.viewer.readOnlyReason,
      blocking: false,
    });
  }
  const readiness = input.pulse.dataReadiness;
  if (readiness && (readiness.status !== "ok" || readiness.isPartial)) {
    banners.push({
      id: "data_readiness",
      tone: "warning",
      title: "Data is not fully ready.",
      detail: readiness.notReadyReason ?? "The selected range is partially verified; numbers may be incomplete.",
      blocking: false,
    });
  }
  if (input.trackingBlocked) {
    banners.push({
      id: "tracking_write_gate",
      tone: "danger",
      title: "Tracking anomaly active.",
      detail: input.pulse.trackingHealth.detail,
      blocking: true,
    });
  }
  const snapshotHealth = input.pulse.snapshotHealth ?? input.lanes.snapshotHealth ?? null;
  if (snapshotHealth && snapshotHealth.status !== "fresh") {
    banners.push({
      id: "snapshot_health",
      tone: snapshotHealth.status === "missing" ? "danger" : "warning",
      title: "Decision snapshot is not fresh.",
      detail: snapshotHealth.staleReason ?? "The served snapshot does not meet the current freshness contract.",
      blocking: snapshotHealth.status === "missing",
    });
  }
  if (input.killSwitchEngaged) {
    banners.push({
      id: "meta_write_kill_switch",
      tone: "danger",
      title: "Kill switch engaged.",
      detail: "All active Meta write endpoints are blocked by META_ADS_WRITE_KILL_SWITCH.",
      blocking: true,
    });
  }
  return banners;
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const params = workspaceParams(request.nextUrl.searchParams);

  try {
    const [pulse, lanes] = await Promise.all([
      readInternalJson<MetaPulsePayload>(request, "account-pulse", "/api/meta/account-pulse", params),
      readInternalJson<MetaLanePayload>(request, "lane-classify", "/api/meta/lane-classify", params),
    ]);
    const trackingBlocked = isTrackingBlocked(pulse);
    const killSwitchEngaged = isMetaWritesKillSwitchEngaged();
    const viewer = await workspaceViewer(request, businessId);
    const digest = await readDecisionDigest({
      businessId,
      snapshotDate: lanes.snapshotDate,
      endDate: lanes.endDate ?? pulse.endDate,
    });
    const payload: MetaDecisionsWorkspacePayload = {
      businessId: pulse.businessId,
      window: pulse.window as MetaWindowKey,
      statusFilter: pulse.statusFilter,
      startDate: pulse.startDate,
      endDate: pulse.endDate,
      pulse,
      lanes,
      queue: {
        groups: queueGroups(lanes),
        actionStates: actionStates(lanes),
      },
      system: {
        trackingBlocked,
        dataReadiness: pulse.dataReadiness ?? null,
        snapshotHealth: pulse.snapshotHealth ?? lanes.snapshotHealth ?? null,
        laneSnapshotDate: lanes.snapshotDate,
        laneSnapshotCreatedAt: lanes.snapshotCreatedAt ?? null,
        engineVersion: pulse.engineVersion,
        currency: pulse.currency ?? null,
        killSwitchEngaged,
        killSwitchReason: killSwitchEngaged ? "META_ADS_WRITE_KILL_SWITCH" : null,
      },
      viewer,
      banners: workspaceBanners({ pulse, lanes, trackingBlocked, killSwitchEngaged, viewer }),
      digest,
    };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return NextResponse.json(
        {
          error: "upstream_failed",
          source: error.source,
          detail: error.payload,
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build Meta decisions workspace." },
      { status: 500 },
    );
  }
}
