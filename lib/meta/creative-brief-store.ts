import { getDb } from "@/lib/db";
import {
  META_CREATIVE_BRIEF_CONTRACT_VERSION,
  buildMetaCreativeBriefCreateRequestHash,
  buildMetaCreativeDecisionId,
  type CreateMetaCreativeBriefRequest,
  type MetaCreativeBrief,
  type MetaCreativeBriefSourceBadge,
  type MetaCreativeBriefStatus,
  type PatchMetaCreativeBriefRequest,
} from "@/lib/meta/creative-brief-contract";

type CreativeBriefDbRow = {
  id: string;
  business_id: string;
  provider_account_id: string;
  contract_version: string;
  create_request_hash: string;
  source_decision_id: string;
  source_snapshot_id: string;
  source_creative_id: string;
  source_engine_version: string;
  source_snapshot_as_of: string;
  source_scope_type: string;
  source_scope_id: string;
  source_published_label: string;
  source_raw_label: string | null;
  source_reason: string;
  source_badges_json: unknown;
  source_trigger: string;
  keep_text: string;
  change_text: string;
  next_text: string;
  status: MetaCreativeBriefStatus;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
};

type SourceDecisionDbRow = {
  snapshot_id: string;
  creative_id: string;
  engine_version: string;
  snapshot_as_of: string;
  scope_type: string;
  scope_id: string;
  published_label: string;
  raw_label: string | null;
  reason: string;
  badges: unknown;
};

const BRIEF_SELECT = `
  id::text AS id,
  business_id::text AS business_id,
  provider_account_id,
  contract_version,
  create_request_hash,
  source_decision_id,
  source_snapshot_id::text AS source_snapshot_id,
  source_creative_id,
  source_engine_version,
  source_snapshot_as_of::text AS source_snapshot_as_of,
  source_scope_type,
  source_scope_id,
  source_published_label,
  source_raw_label,
  source_reason,
  source_badges_json,
  source_trigger,
  keep_text,
  change_text,
  next_text,
  status,
  version,
  created_by::text AS created_by,
  updated_by::text AS updated_by,
  reviewed_by::text AS reviewed_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at,
  reviewed_at::text AS reviewed_at
`;

export class MetaCreativeBriefIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already bound to a different brief create request.");
    this.name = "MetaCreativeBriefIdempotencyConflictError";
  }
}

export class MetaCreativeBriefSourceNotFoundError extends Error {
  constructor() {
    super("The source decision snapshot is not available in the selected Meta account.");
    this.name = "MetaCreativeBriefSourceNotFoundError";
  }
}

export class MetaCreativeBriefNotFoundError extends Error {
  constructor() {
    super("Creative brief not found.");
    this.name = "MetaCreativeBriefNotFoundError";
  }
}

export class MetaCreativeBriefVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Creative brief version conflict: expected ${expectedVersion}, current ${currentVersion}.`,
    );
    this.name = "MetaCreativeBriefVersionConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mapSourceBadges(value: unknown): MetaCreativeBriefSourceBadge[] {
  if (!Array.isArray(value)) return [];
  const badges: MetaCreativeBriefSourceBadge[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== "string" || !entry.type.trim()) {
      continue;
    }
    badges.push({
      type: entry.type.trim(),
      label:
        typeof entry.label === "string" && entry.label.trim()
          ? entry.label.trim()
          : null,
      severity:
        typeof entry.severity === "string" && entry.severity.trim()
          ? entry.severity.trim()
          : null,
    });
  }
  return badges;
}

function mapBrief(row: CreativeBriefDbRow): MetaCreativeBrief {
  return {
    contractVersion: META_CREATIVE_BRIEF_CONTRACT_VERSION,
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    sourceDecision: {
      decisionId: row.source_decision_id,
      snapshotId: row.source_snapshot_id,
      creativeId: row.source_creative_id,
      engineVersion: row.source_engine_version,
      snapshotAsOf: row.source_snapshot_as_of,
      scopeType: row.source_scope_type,
      scopeId: row.source_scope_id,
      publishedLabel: row.source_published_label,
      rawLabel: row.source_raw_label,
      reason: row.source_reason,
      badges: mapSourceBadges(row.source_badges_json),
      trigger: row.source_trigger,
    },
    content: {
      keep: row.keep_text,
      change: row.change_text,
      next: row.next_text,
    },
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
  };
}

async function readByIdempotencyKey(input: {
  businessId: string;
  providerAccountId: string;
  idempotencyKey: string;
}) {
  const rows = await getDb().query<CreativeBriefDbRow>(
    `
      SELECT ${BRIEF_SELECT}
      FROM meta_creative_briefs
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND idempotency_key = $3
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.idempotencyKey],
  );
  return rows[0] ?? null;
}

async function readVerifiedSourceDecision(input: {
  businessId: string;
  providerAccountId: string;
  snapshotId: string;
}) {
  const rows = await getDb().query<SourceDecisionDbRow>(
    `
      WITH account_creatives AS (
        SELECT creative_id
        FROM meta_creative_dimensions
        WHERE business_id = $1
          AND provider_account_id = $2
        UNION
        SELECT creative_id
        FROM meta_creative_daily
        WHERE business_id = $1
          AND provider_account_id = $2
      )
      SELECT
        snapshot.id::text AS snapshot_id,
        snapshot.creative_id,
        snapshot.engine_version,
        snapshot.as_of_date::text AS snapshot_as_of,
        snapshot.scope_type,
        snapshot.scope_id,
        snapshot.label AS published_label,
        snapshot.raw_label,
        snapshot.reason,
        snapshot.badges
      FROM engine_v3_decision_snapshots_daily snapshot
      WHERE snapshot.id = $3::uuid
        AND (
          snapshot.business_id = $1
          OR snapshot.business_ref_id::text = $1
        )
        AND EXISTS (
          SELECT 1
          FROM account_creatives account_creative
          WHERE account_creative.creative_id = snapshot.creative_id
        )
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.snapshotId],
  );
  return rows[0] ?? null;
}

export async function createMetaCreativeBrief(input: {
  request: CreateMetaCreativeBriefRequest;
  createdBy: string | null;
}): Promise<{ brief: MetaCreativeBrief; created: boolean }> {
  const requestHash = buildMetaCreativeBriefCreateRequestHash(input.request);
  const idempotentExisting = await readByIdempotencyKey({
    businessId: input.request.businessId,
    providerAccountId: input.request.providerAccountId,
    idempotencyKey: input.request.idempotencyKey,
  });
  if (idempotentExisting) {
    if (idempotentExisting.create_request_hash !== requestHash) {
      throw new MetaCreativeBriefIdempotencyConflictError();
    }
    return { brief: mapBrief(idempotentExisting), created: false };
  }

  const source = await readVerifiedSourceDecision({
    businessId: input.request.businessId,
    providerAccountId: input.request.providerAccountId,
    snapshotId: input.request.sourceDecision.snapshotId,
  });
  if (!source) throw new MetaCreativeBriefSourceNotFoundError();

  const sourceBadges = mapSourceBadges(source.badges);
  const sourceDecisionId = buildMetaCreativeDecisionId({
    businessId: input.request.businessId,
    providerAccountId: input.request.providerAccountId,
    creativeId: source.creative_id,
    scopeType: source.scope_type,
    scopeId: source.scope_id,
  });
  const rows = await getDb().query<CreativeBriefDbRow>(
    `
      INSERT INTO meta_creative_briefs (
        business_id,
        provider_account_id,
        contract_version,
        idempotency_key,
        create_request_hash,
        source_decision_id,
        source_snapshot_id,
        source_creative_id,
        source_engine_version,
        source_snapshot_as_of,
        source_scope_type,
        source_scope_id,
        source_published_label,
        source_raw_label,
        source_reason,
        source_badges_json,
        source_trigger,
        keep_text,
        change_text,
        next_text,
        status,
        version,
        created_by,
        updated_by,
        reviewed_by,
        reviewed_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10::date,
        $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20,
        $21, 1, $22::uuid, $22::uuid,
        CASE WHEN $21 = 'reviewed' THEN $22::uuid ELSE NULL END,
        CASE WHEN $21 = 'reviewed' THEN NOW() ELSE NULL END
      )
      ON CONFLICT (business_id, provider_account_id, idempotency_key) DO NOTHING
      RETURNING ${BRIEF_SELECT}
    `,
    [
      input.request.businessId,
      input.request.providerAccountId,
      META_CREATIVE_BRIEF_CONTRACT_VERSION,
      input.request.idempotencyKey,
      requestHash,
      sourceDecisionId,
      source.snapshot_id,
      source.creative_id,
      source.engine_version,
      source.snapshot_as_of,
      source.scope_type,
      source.scope_id,
      source.published_label,
      source.raw_label,
      source.reason,
      JSON.stringify(sourceBadges),
      input.request.sourceDecision.trigger,
      input.request.content.keep,
      input.request.content.change,
      input.request.content.next,
      input.request.status,
      input.createdBy,
    ],
  );
  if (rows[0]) return { brief: mapBrief(rows[0]), created: true };

  const racedExisting = await readByIdempotencyKey({
    businessId: input.request.businessId,
    providerAccountId: input.request.providerAccountId,
    idempotencyKey: input.request.idempotencyKey,
  });
  if (!racedExisting || racedExisting.create_request_hash !== requestHash) {
    throw new MetaCreativeBriefIdempotencyConflictError();
  }
  return { brief: mapBrief(racedExisting), created: false };
}

export async function listMetaCreativeBriefs(input: {
  businessId: string;
  providerAccountId: string;
  status?: MetaCreativeBriefStatus | null;
  limit?: number;
}): Promise<MetaCreativeBrief[]> {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 100));
  const rows = await getDb().query<CreativeBriefDbRow>(
    `
      SELECT ${BRIEF_SELECT}
      FROM meta_creative_briefs
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND ($3::text IS NULL OR status = $3)
      ORDER BY updated_at DESC, id DESC
      LIMIT $4
    `,
    [input.businessId, input.providerAccountId, input.status ?? null, limit],
  );
  return rows.map(mapBrief);
}

export async function readMetaCreativeBrief(input: {
  businessId: string;
  providerAccountId: string;
  id: string;
}): Promise<MetaCreativeBrief | null> {
  const rows = await getDb().query<CreativeBriefDbRow>(
    `
      SELECT ${BRIEF_SELECT}
      FROM meta_creative_briefs
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.id],
  );
  return rows[0] ? mapBrief(rows[0]) : null;
}

export async function patchMetaCreativeBrief(input: {
  businessId: string;
  providerAccountId: string;
  id: string;
  patch: PatchMetaCreativeBriefRequest;
  updatedBy: string | null;
}): Promise<MetaCreativeBrief> {
  const hasKeep = Object.prototype.hasOwnProperty.call(input.patch.content, "keep");
  const hasChange = Object.prototype.hasOwnProperty.call(
    input.patch.content,
    "change",
  );
  const hasNext = Object.prototype.hasOwnProperty.call(input.patch.content, "next");
  const hasContentChange = hasKeep || hasChange || hasNext;
  const hasExplicitStatus = input.patch.status !== undefined;

  const rows = await getDb().query<CreativeBriefDbRow>(
    `
      UPDATE meta_creative_briefs
      SET
        keep_text = CASE WHEN $6::boolean THEN $7 ELSE keep_text END,
        change_text = CASE WHEN $8::boolean THEN $9 ELSE change_text END,
        next_text = CASE WHEN $10::boolean THEN $11 ELSE next_text END,
        status = CASE
          WHEN $12::boolean THEN $13
          WHEN $14::boolean THEN 'draft'
          ELSE status
        END,
        reviewed_by = CASE
          WHEN (
            CASE
              WHEN $12::boolean THEN $13
              WHEN $14::boolean THEN 'draft'
              ELSE status
            END
          ) = 'reviewed' THEN $5::uuid
          ELSE NULL
        END,
        reviewed_at = CASE
          WHEN (
            CASE
              WHEN $12::boolean THEN $13
              WHEN $14::boolean THEN 'draft'
              ELSE status
            END
          ) = 'reviewed' THEN NOW()
          ELSE NULL
        END,
        updated_by = $5::uuid,
        version = version + 1,
        updated_at = NOW()
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
        AND version = $4
      RETURNING ${BRIEF_SELECT}
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.id,
      input.patch.expectedVersion,
      input.updatedBy,
      hasKeep,
      input.patch.content.keep ?? null,
      hasChange,
      input.patch.content.change ?? null,
      hasNext,
      input.patch.content.next ?? null,
      hasExplicitStatus,
      input.patch.status ?? null,
      hasContentChange,
    ],
  );
  if (rows[0]) return mapBrief(rows[0]);

  const current = await getDb().query<{ version: number }>(
    `
      SELECT version
      FROM meta_creative_briefs
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.id],
  );
  if (!current[0]) throw new MetaCreativeBriefNotFoundError();
  throw new MetaCreativeBriefVersionConflictError(
    input.patch.expectedVersion,
    Number(current[0].version),
  );
}
