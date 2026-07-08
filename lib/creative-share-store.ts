import { randomUUID } from "crypto";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";

type CreateCreativeSharePayload = Omit<SharePayload, "token" | "createdAt">;

async function ensureShareTable() {
  await assertDbSchemaReady({
    tables: ["creative_share_snapshots"],
    context: "creative_share_store",
  });
}

function normalizeShareAudience(value: SharePayload["audience"]): NonNullable<SharePayload["audience"]> {
  return value === "creative_team" || value === "external" ? value : "buyer";
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function sanitizeClientActions(payload: CreateCreativeSharePayload) {
  const audience = normalizeShareAudience(payload.audience);
  if (audience !== "buyer") return undefined;
  const actions = payload.clientActions ?? [];
  return actions
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

export function sanitizeCreativeSharePayloadForStorage(
  payload: CreateCreativeSharePayload,
  now = new Date(),
): CreateCreativeSharePayload & Pick<SharePayload, "createdAt" | "frozenAt" | "openCount"> {
  const audience = normalizeShareAudience(payload.audience);
  const allowDecisionLanguage = audience === "buyer" && payload.includeDecisionLanguage !== false;
  const allowCampaignNames = audience === "buyer" && payload.includeCampaignNames !== false;
  const createdAt = now.toISOString();
  const sanitizeCreative = (creative: SharePayload["creatives"][number]) => ({
    ...creative,
    analysis: allowDecisionLanguage ? creative.analysis ?? null : null,
  });

  return {
    ...payload,
    audience,
    createdAt,
    frozenAt: createdAt,
    openCount: safeNumber(payload.openCount),
    includeDecisionLanguage: allowDecisionLanguage,
    includeCampaignNames: allowCampaignNames,
    filters: audience === "external" ? [] : payload.filters,
    selectedRowIds: audience === "external" ? undefined : payload.selectedRowIds,
    groupBy: allowCampaignNames ? payload.groupBy : undefined,
    clientActions: sanitizeClientActions(payload),
    creatives: payload.creatives.map(sanitizeCreative),
    benchmarkCreatives: payload.benchmarkCreatives?.map(sanitizeCreative),
  };
}

export async function createCreativeShareSnapshot(
  payload: CreateCreativeSharePayload
): Promise<{ token: string; payload: SharePayload }> {
  await ensureShareTable();
  const sql = getDb();
  const token = randomUUID().replace(/-/g, "");
  const snapshot: SharePayload = {
    ...sanitizeCreativeSharePayloadForStorage(payload),
    token,
  };
  await sql`
    INSERT INTO creative_share_snapshots (token, payload, expires_at)
    VALUES (${token}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.expiresAt})
  `;

  return { token, payload: snapshot };
}

function parseSharePayload(payload: unknown): SharePayload | null {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as SharePayload;
    } catch {
      return null;
    }
  }
  if (payload && typeof payload === "object") return payload as SharePayload;
  return null;
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
    LIMIT 1
  `) as Array<{ payload?: unknown; expires_at?: string }>;
  const row = rows[0];
  if (!row?.payload || !row.expires_at) return null;

  const expires = new Date(row.expires_at).getTime();
  if (Number.isFinite(expires) && expires < Date.now()) {
    return null;
  }

  const payload = parseSharePayload(row.payload);
  if (!payload) return null;
  if (!options.recordOpen) return payload;

  const openedPayload: SharePayload = {
    ...payload,
    openCount: safeNumber(payload.openCount) + 1,
  };
  await sql`
    UPDATE creative_share_snapshots
    SET payload = ${JSON.stringify(openedPayload)}::jsonb
    WHERE token = ${token}
  `;
  return openedPayload;
}
