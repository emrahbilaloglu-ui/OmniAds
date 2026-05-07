import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

export const TRIAGE_ACTIONS = ["deferred", "undeferred"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export interface TriageEventRow {
  businessId: string;
  scopeType: string;
  scopeId: string;
  action: TriageAction;
  timestamp: string;
  reappearAt: string | null;
}

type TriageDbRow = {
  rec_id: string;
  business_id: string;
  action: TriageAction;
  timestamp: string;
  reappear_at: string | null;
};

const TRIAGE_REC_PREFIX = "triage:";

function normalizeTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isTriageAction(value: string): value is TriageAction {
  return TRIAGE_ACTIONS.includes(value as TriageAction);
}

export function buildTriageRecId(scopeType: string, scopeId: string) {
  return `${TRIAGE_REC_PREFIX}${encodeURIComponent(scopeType)}:${encodeURIComponent(scopeId)}`;
}

export function parseTriageRecId(value: string) {
  if (!value.startsWith(TRIAGE_REC_PREFIX)) return null;
  const body = value.slice(TRIAGE_REC_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0) return null;
  try {
    const scopeType = decodeURIComponent(body.slice(0, separator));
    const scopeId = decodeURIComponent(body.slice(separator + 1));
    if (!scopeType || !scopeId) return null;
    return { scopeType, scopeId };
  } catch {
    return null;
  }
}

function mapTriageRow(row: TriageDbRow): TriageEventRow | null {
  const parsed = parseTriageRecId(row.rec_id);
  if (!parsed) return null;
  return {
    businessId: row.business_id,
    scopeType: parsed.scopeType,
    scopeId: parsed.scopeId,
    action: row.action,
    timestamp: row.timestamp,
    reappearAt: row.reappear_at,
  };
}

export async function recordTriageEvent(input: {
  businessId: string;
  scopeType: string;
  scopeId: string;
  action: TriageAction;
  reappearAt?: string | null;
}): Promise<TriageEventRow> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_responses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    throw new Error("Triage persistence is not ready.");
  }

  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_decision_responses (
      rec_id,
      business_id,
      action,
      action_subtype,
      reappear_at
    ) VALUES (
      ${buildTriageRecId(input.scopeType, input.scopeId)},
      ${input.businessId},
      ${input.action},
      ${`triage:${input.scopeType}`},
      ${normalizeTimestamp(input.reappearAt)}::timestamptz
    )
    RETURNING
      rec_id,
      business_id,
      action,
      timestamp::text AS timestamp,
      reappear_at::text AS reappear_at
  `) as TriageDbRow[];
  const mapped = rows[0] ? mapTriageRow(rows[0]) : null;
  if (!mapped) throw new Error("Failed to persist triage event.");
  return mapped;
}

export async function readTriageState(input: {
  businessId: string;
  scopeType?: string | null;
  now?: Date;
}): Promise<{ rows: TriageEventRow[]; deferredCount: number }> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_responses"],
  }).catch(() => null);
  if (!readiness?.ready) return { rows: [], deferredCount: 0 };

  const sql = getDb();
  const scopePattern = input.scopeType
    ? `${TRIAGE_REC_PREFIX}${encodeURIComponent(input.scopeType)}:%`
    : `${TRIAGE_REC_PREFIX}%`;
  const now = input.now ?? new Date();
  const rows = (await sql`
    WITH ranked AS (
      SELECT
        rec_id,
        business_id,
        action,
        timestamp::text AS timestamp,
        reappear_at::text AS reappear_at,
        ROW_NUMBER() OVER (PARTITION BY rec_id ORDER BY timestamp DESC) AS row_number
      FROM meta_decision_responses
      WHERE business_id = ${input.businessId}
        AND rec_id LIKE ${scopePattern}
        AND action IN ('deferred', 'undeferred')
    )
    SELECT
      rec_id,
      business_id,
      action,
      timestamp,
      reappear_at
    FROM ranked
    WHERE row_number = 1
      AND (
        action <> 'deferred'
        OR reappear_at IS NULL
        OR reappear_at::timestamptz > ${now.toISOString()}::timestamptz
      )
    ORDER BY timestamp DESC
  `) as TriageDbRow[];

  const mapped = rows
    .map(mapTriageRow)
    .filter((row): row is TriageEventRow => Boolean(row));
  return {
    rows: mapped,
    deferredCount: mapped.filter((row) => row.action === "deferred").length,
  };
}
