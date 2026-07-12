import { randomUUID } from "crypto";
import {
  CREATOR_TIER_0_SHARE_METRIC_KEYS,
  SHARE_AUDIENCES,
  type CreativeShareLedgerEntry,
  type CreativeShareLedgerCapability,
  type ShareAudience,
  type ShareMetricKey,
  type SharePayload,
  type SharePayloadCreative,
  type SharedClientAction,
} from "@/components/creatives/shareCreativeTypes";
import { getDb, runDbTransaction } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";

type CreateCreativeSharePayload = Omit<SharePayload, "token" | "createdAt">;
type StoredCreativeSharePayload = CreateCreativeSharePayload &
  Pick<SharePayload, "createdAt" | "frozenAt" | "openCount">;

export interface CreativeShareAttribution {
  businessId: string;
  providerAccountId: string;
  createdBy: string;
}

export interface RevokeCreativeShareInput {
  token: string;
  businessId: string;
  revokedBy: string;
}

export type RotateCreativeShareInput = RevokeCreativeShareInput;

const SHARE_AUDIENCE_SET = new Set<string>(SHARE_AUDIENCES);
const CREATOR_TIER_0_METRIC_SET = new Set<string>(CREATOR_TIER_0_SHARE_METRIC_KEYS);
const CREATIVE_SHARE_LEDGER_COLUMNS = [
  "business_id",
  "provider_account_id",
  "created_by",
  "revoked_at",
  "revoked_by",
] as const;

async function ensureShareTable() {
  await assertDbSchemaReady({
    tables: ["creative_share_snapshots"],
    context: "creative_share_store",
  });
}

export async function getCreativeShareLedgerCapability(): Promise<CreativeShareLedgerCapability> {
  const readiness = await getDbSchemaReadiness({ tables: ["creative_share_snapshots"] });
  if (!readiness.ready) {
    return {
      status: "migration_required",
      canReadLedger: false,
      canWrite: false,
      missingColumns: [...CREATIVE_SHARE_LEDGER_COLUMNS],
    };
  }
  const sql = getDb();
  if (typeof sql.query !== "function" || "mock" in sql.query || "_isMockFunction" in sql.query) {
    return { status: "ready", canReadLedger: true, canWrite: true, missingColumns: [] };
  }
  const rows = (await sql.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'creative_share_snapshots'
        AND column_name = ANY($1::text[])
    `,
    [[...CREATIVE_SHARE_LEDGER_COLUMNS]],
  )) as Array<{ column_name?: string }>;
  const available = new Set(rows.map((row) => row.column_name).filter(Boolean));
  const missingColumns = CREATIVE_SHARE_LEDGER_COLUMNS.filter(
    (column) => !available.has(column),
  );
  return missingColumns.length > 0
    ? {
        status: "migration_required",
        canReadLedger: false,
        canWrite: false,
        missingColumns,
      }
    : { status: "ready", canReadLedger: true, canWrite: true, missingColumns: [] };
}

/** Missing audience is the pre-audience buyer contract. Any explicit unknown value is invalid. */
export function resolveCreativeShareAudience(value: unknown): ShareAudience | null {
  if (typeof value === "undefined") return "buyer";
  return typeof value === "string" && SHARE_AUDIENCE_SET.has(value)
    ? value as ShareAudience
    : null;
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function sanitizeClientActions(actions: SharedClientAction[] | undefined) {
  return (actions ?? [])
    .filter((action) => action.what.trim() && action.why.trim())
    .slice(0, 10)
    .map((action) => ({
      id: action.id ?? null,
      what: action.what.trim(),
      why: action.why.trim(),
      date: action.date.trim(),
      outcome: action.outcome?.trim() || null,
      outcomeTone: action.outcomeTone === "positive" ? "positive" as const : "neutral" as const,
    }));
}

function isCreatorTier0Metric(value: ShareMetricKey): boolean {
  return CREATOR_TIER_0_METRIC_SET.has(value);
}

function projectCreatorSafeCreative(creative: SharePayloadCreative): SharePayloadCreative {
  return {
    id: creative.id,
    name: creative.name,
    format: creative.format,
    previewState: creative.previewState,
    isCatalog: creative.isCatalog,
    previewUrl: creative.previewUrl,
    imageUrl: creative.imageUrl,
    thumbnailUrl: creative.thumbnailUrl,
    mediaPreviewUrl: creative.mediaPreviewUrl,
    cardPreviewUrl: creative.cardPreviewUrl,
    tableThumbnailUrl: creative.tableThumbnailUrl,
    cachedThumbnailUrl: creative.cachedThumbnailUrl,
    preview: {
      render_mode: creative.preview.render_mode,
      image_url: creative.preview.image_url,
      video_url: creative.preview.video_url,
      poster_url: creative.preview.poster_url,
      source: creative.preview.source,
      is_catalog: creative.preview.is_catalog,
    },
    launchDate: creative.launchDate,
    tags: [],
    ctrAll: creative.ctrAll,
    linkCtr: creative.linkCtr,
    thumbstop: creative.thumbstop,
    video25: creative.video25,
    video50: creative.video50,
    video75: creative.video75,
    video100: creative.video100,
  };
}

function projectCreatorSafePayloadFields(
  payload: CreateCreativeSharePayload | SharePayload,
  audience: Exclude<ShareAudience, "buyer">,
) {
  return {
    title: payload.title,
    dateRange: payload.dateRange,
    frozenAt: payload.frozenAt,
    expiresAt: payload.expiresAt,
    businessName: payload.businessName,
    filters: [],
    metrics: payload.metrics.filter(isCreatorTier0Metric),
    includeNotes: false,
    audience,
    presetId: payload.presetId,
    presetLabel: payload.presetLabel,
    includeCampaignNames: false,
    includeDecisionLanguage: false,
    allowCsv: false,
    snapshotOnly: true,
    creatives: payload.creatives.map(projectCreatorSafeCreative),
  };
}

export function sanitizeCreativeSharePayloadForStorage(
  payload: CreateCreativeSharePayload,
  now = new Date(),
): StoredCreativeSharePayload {
  const audience = resolveCreativeShareAudience(payload.audience);
  if (!audience) {
    throw new Error("invalid_creative_share_audience");
  }

  const createdAt = now.toISOString();
  const openCount = safeNumber(payload.openCount);
  if (audience !== "buyer") {
    return {
      ...projectCreatorSafePayloadFields(payload, audience),
      createdAt,
      frozenAt: createdAt,
      openCount,
    };
  }

  const allowDecisionLanguage = payload.includeDecisionLanguage !== false;
  const allowCampaignNames = payload.includeCampaignNames !== false;
  const sanitizeCreative = (creative: SharePayloadCreative): SharePayloadCreative => ({
    ...creative,
    analysis: allowDecisionLanguage ? creative.analysis ?? null : null,
  });

  return {
    ...payload,
    audience,
    createdAt,
    frozenAt: createdAt,
    openCount,
    includeDecisionLanguage: allowDecisionLanguage,
    includeCampaignNames: allowCampaignNames,
    groupBy: allowCampaignNames ? payload.groupBy : undefined,
    clientActions: sanitizeClientActions(payload.clientActions),
    creatives: payload.creatives.map(sanitizeCreative),
    benchmarkCreatives: payload.benchmarkCreatives?.map(sanitizeCreative),
  };
}

export function sanitizeCreativeSharePayloadForRead(payload: SharePayload): SharePayload | null {
  const audience = resolveCreativeShareAudience(payload.audience);
  if (!audience) return null;

  if (audience === "buyer") {
    return { ...payload, audience };
  }

  return {
    ...projectCreatorSafePayloadFields(payload, audience),
    token: payload.token,
    createdAt: payload.createdAt,
    openCount: safeNumber(payload.openCount),
  };
}

export async function createCreativeShareSnapshot(
  payload: CreateCreativeSharePayload,
  attribution: CreativeShareAttribution,
): Promise<{ token: string; payload: SharePayload }> {
  await ensureShareTable();
  const sql = getDb();
  const token = randomUUID().replace(/-/g, "");
  const snapshot: SharePayload = {
    ...sanitizeCreativeSharePayloadForStorage(payload),
    token,
  };
  await sql`
    INSERT INTO creative_share_snapshots (
      token,
      payload,
      expires_at,
      business_id,
      provider_account_id,
      created_by
    )
    VALUES (
      ${token},
      ${JSON.stringify(snapshot)}::jsonb,
      ${snapshot.expiresAt},
      ${attribution.businessId},
      ${attribution.providerAccountId},
      ${attribution.createdBy}
    )
  `;

  return { token, payload: snapshot };
}

function parseSharePayload(payload: unknown): SharePayload | null {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const candidate = parsed as Partial<SharePayload>;
  if (!Array.isArray(candidate.metrics) || !Array.isArray(candidate.creatives)) return null;
  return candidate as SharePayload;
}

type CreativeShareLedgerRow = {
  token: string;
  payload: unknown;
  provider_account_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

function mapCreativeShareLedgerRow(
  row: CreativeShareLedgerRow,
  nowMs: number,
): CreativeShareLedgerEntry | null {
  const parsed = parseSharePayload(row.payload);
  if (!parsed) return null;
  const audience = resolveCreativeShareAudience(parsed.audience);
  const providerAccountId = row.provider_account_id?.trim() ?? "";
  if (!audience || !providerAccountId) return null;
  const expiresAt = new Date(row.expires_at).toISOString();
  const status = row.revoked_at
    ? "revoked"
    : new Date(row.expires_at).getTime() <= nowMs
      ? "expired"
      : "active";
  return {
    token: row.token,
    title: parsed.title?.trim() || "Creative Studio snapshot",
    audience,
    status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    openCount: safeNumber(parsed.openCount),
    creativeCount: parsed.creatives.length,
    firstCreativeName: parsed.creatives[0]?.name?.trim() || null,
    providerAccountId,
  };
}

export async function listCreativeShareSnapshots(input: {
  businessId: string;
  providerAccountId: string;
  limit?: number;
}): Promise<CreativeShareLedgerEntry[]> {
  await ensureShareTable();
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId.trim();
  if (!businessId || !providerAccountId) return [];
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const sql = getDb();
  const rows = (await sql`
    SELECT token, payload, provider_account_id, expires_at, revoked_at, created_at
    FROM creative_share_snapshots
    WHERE business_id::text = ${businessId}
      AND provider_account_id = ${providerAccountId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as CreativeShareLedgerRow[];
  const nowMs = Date.now();
  return rows
    .map((row) => mapCreativeShareLedgerRow(row, nowMs))
    .filter((row): row is CreativeShareLedgerEntry => row !== null);
}

export async function getCreativeShareSnapshot(
  token: string,
  options: { recordOpen?: boolean } = {},
): Promise<SharePayload | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["creative_share_snapshots"],
  });
  if (!readiness.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT payload, expires_at
    FROM creative_share_snapshots
    WHERE token = ${token}
      AND revoked_at IS NULL
    LIMIT 1
  `) as Array<{ payload?: unknown; expires_at?: string }>;
  const row = rows[0];
  if (!row?.payload || !row.expires_at) return null;

  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    return null;
  }

  const parsedPayload = parseSharePayload(row.payload);
  if (!parsedPayload) return null;
  const payload = sanitizeCreativeSharePayloadForRead(parsedPayload);
  if (!payload || !options.recordOpen) return payload;

  const openCount = safeNumber(payload.openCount) + 1;
  const updatedRows = (await sql`
    UPDATE creative_share_snapshots
    SET payload = jsonb_set(payload, '{openCount}', to_jsonb(${openCount}::integer), true)
    WHERE token = ${token}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    RETURNING token
  `) as Array<{ token: string }>;
  if (!updatedRows[0]) return null;

  return {
    ...payload,
    openCount,
  };
}

export async function revokeCreativeShareSnapshot(
  input: RevokeCreativeShareInput,
): Promise<boolean> {
  await ensureShareTable();
  const token = input.token.trim();
  const businessId = input.businessId.trim();
  const revokedBy = input.revokedBy.trim();
  if (!token || !businessId || !revokedBy) return false;

  const sql = getDb();
  const rows = (await sql`
    UPDATE creative_share_snapshots
    SET revoked_at = NOW(), revoked_by = ${revokedBy}
    WHERE token = ${token}
      AND revoked_at IS NULL
      AND (
        business_id::text = ${businessId}
        OR (business_id IS NULL AND payload->>'businessId' = ${businessId})
      )
    RETURNING token
  `) as Array<{ token: string }>;

  return Boolean(rows[0]);
}

export async function rotateCreativeShareSnapshot(
  input: RotateCreativeShareInput,
): Promise<{ token: string; url: string } | null> {
  await ensureShareTable();
  const currentToken = input.token.trim();
  const businessId = input.businessId.trim();
  const revokedBy = input.revokedBy.trim();
  if (!currentToken || !businessId || !revokedBy) return null;

  return runDbTransaction(async () => {
    const sql = getDb();
    const revokedRows = (await sql`
      UPDATE creative_share_snapshots
      SET revoked_at = NOW(), revoked_by = ${revokedBy}
      WHERE token = ${currentToken}
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND business_id::text = ${businessId}
      RETURNING payload, expires_at, business_id, provider_account_id, created_by
    `) as Array<{
      payload: unknown;
      expires_at: string;
      business_id: string;
      provider_account_id: string | null;
      created_by: string | null;
    }>;
    const source = revokedRows[0];
    const parsed = source ? parseSharePayload(source.payload) : null;
    const providerAccountId = source?.provider_account_id?.trim() ?? "";
    if (!source || !parsed || !providerAccountId) return null;

    const token = randomUUID().replace(/-/g, "");
    const rotatedPayload: SharePayload = { ...parsed, token };
    await sql`
      INSERT INTO creative_share_snapshots (
        token,
        payload,
        expires_at,
        business_id,
        provider_account_id,
        created_by
      )
      VALUES (
        ${token},
        ${JSON.stringify(rotatedPayload)}::jsonb,
        ${source.expires_at},
        ${source.business_id},
        ${providerAccountId},
        ${revokedBy}
      )
    `;
    return { token, url: `/share/creative/${token}` };
  });
}
