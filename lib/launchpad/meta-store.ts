import { getDb } from "@/lib/db";
import {
  normalizeMetaLaunchPayload,
  type MetaLaunchPayload,
} from "@/lib/launchpad/meta";

export interface MetaLaunchTemplateRow {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  payload: MetaLaunchPayload;
  source: "manual" | "auto_recent";
  createdAt: string;
  updatedAt: string;
}

export interface MetaLaunchDraftRow {
  id: string;
  businessId: string;
  name: string;
  payload: MetaLaunchPayload;
  status: "draft" | "queued" | "launched" | "failed";
  createdAt: string;
  updatedAt: string;
  launchedAt: string | null;
  lastError: Record<string, unknown> | null;
}

type TemplateDbRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  payload_json: unknown;
  source: "manual" | "auto_recent";
  created_at: string;
  updated_at: string;
};

type DraftDbRow = {
  id: string;
  business_id: string;
  name: string;
  payload_json: unknown;
  status: "draft" | "queued" | "launched" | "failed";
  created_at: string;
  updated_at: string;
  launched_at: string | null;
  last_error_json: Record<string, unknown> | null;
};

function mapTemplate(row: TemplateDbRow): MetaLaunchTemplateRow {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    payload: normalizeMetaLaunchPayload(row.payload_json),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDraft(row: DraftDbRow): MetaLaunchDraftRow {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    payload: normalizeMetaLaunchPayload(row.payload_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    launchedAt: row.launched_at,
    lastError: row.last_error_json,
  };
}

export async function listManualMetaLaunchTemplates(input: {
  businessId: string;
}): Promise<MetaLaunchTemplateRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_launch_templates
    WHERE business_id = ${input.businessId}
      AND source = 'manual'
    ORDER BY updated_at DESC
    LIMIT 50
  `) as TemplateDbRow[];
  return rows.map(mapTemplate);
}

export async function createManualMetaLaunchTemplate(input: {
  businessId: string;
  name: string;
  description?: string | null;
  payload: unknown;
  createdBy?: string | null;
}): Promise<MetaLaunchTemplateRow> {
  const sql = getDb();
  const payload = normalizeMetaLaunchPayload(input.payload);
  const rows = (await sql`
    INSERT INTO meta_launch_templates (
      business_id,
      name,
      description,
      payload_json,
      source,
      created_by
    ) VALUES (
      ${input.businessId},
      ${input.name},
      ${input.description ?? null},
      ${JSON.stringify(payload)}::jsonb,
      'manual',
      ${input.createdBy ?? null}
    )
    RETURNING *
  `) as TemplateDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to create launch template.");
  return mapTemplate(row);
}

export async function deleteManualMetaLaunchTemplate(input: {
  businessId: string;
  id: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM meta_launch_templates
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND source = 'manual'
    RETURNING id
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function listMetaLaunchDrafts(input: {
  businessId: string;
}): Promise<MetaLaunchDraftRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_launch_drafts
    WHERE business_id = ${input.businessId}
      AND status IN ('draft', 'failed')
    ORDER BY updated_at DESC
    LIMIT 50
  `) as DraftDbRow[];
  return rows.map(mapDraft);
}

export async function upsertMetaLaunchDraft(input: {
  businessId: string;
  id?: string | null;
  name: string;
  payload: unknown;
  createdBy?: string | null;
}): Promise<MetaLaunchDraftRow> {
  const sql = getDb();
  const payload = normalizeMetaLaunchPayload(input.payload);
  const rows = input.id
    ? ((await sql`
        UPDATE meta_launch_drafts
        SET
          name = ${input.name},
          payload_json = ${JSON.stringify(payload)}::jsonb,
          status = 'draft',
          updated_at = NOW()
        WHERE business_id = ${input.businessId}
          AND id = ${input.id}
        RETURNING *
      `) as DraftDbRow[])
    : ((await sql`
        INSERT INTO meta_launch_drafts (
          business_id,
          name,
          payload_json,
          status,
          created_by
        ) VALUES (
          ${input.businessId},
          ${input.name},
          ${JSON.stringify(payload)}::jsonb,
          'draft',
          ${input.createdBy ?? null}
        )
        RETURNING *
      `) as DraftDbRow[]);
  const row = rows[0];
  if (!row) throw new Error("Failed to save launch draft.");
  return mapDraft(row);
}

export async function deleteMetaLaunchDraft(input: {
  businessId: string;
  id: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM meta_launch_drafts
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
    RETURNING id
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function listRecentMetaLaunchTemplates(input: {
  businessId: string;
}): Promise<MetaLaunchTemplateRow[]> {
  const sql = getDb();
  const rows = (await sql`
    WITH recent_campaigns AS (
      SELECT
        dim.business_id,
        dim.provider_account_id,
        dim.campaign_id,
        COALESCE(dim.campaign_name_current, dim.campaign_name_historical, dim.campaign_id) AS campaign_name,
        dim.updated_at,
        cfg.objective,
        cfg.daily_budget,
        cfg.lifetime_budget,
        cfg.bid_strategy_type,
        cfg.manual_bid_amount
      FROM meta_campaign_dimensions dim
      LEFT JOIN LATERAL (
        SELECT *
        FROM meta_campaign_config_history cfg
        WHERE cfg.business_id = dim.business_id
          AND cfg.provider_account_id = dim.provider_account_id
          AND cfg.campaign_id = dim.campaign_id
        ORDER BY cfg.captured_at DESC
        LIMIT 1
      ) cfg ON TRUE
      WHERE dim.business_id = ${input.businessId}
        AND cfg.objective = 'OUTCOME_SALES'
      ORDER BY dim.updated_at DESC
      LIMIT 5
    ),
    adset_counts AS (
      SELECT campaign_id, COUNT(DISTINCT adset_id)::int AS adset_count
      FROM meta_adset_dimensions
      WHERE business_id = ${input.businessId}
      GROUP BY campaign_id
    )
    SELECT
      recent.business_id,
      recent.campaign_id AS id,
      recent.campaign_name AS name,
      recent.updated_at,
      recent.daily_budget,
      recent.lifetime_budget,
      recent.bid_strategy_type,
      recent.manual_bid_amount,
      COALESCE(counts.adset_count, 1) AS adset_count
    FROM recent_campaigns recent
    LEFT JOIN adset_counts counts ON counts.campaign_id = recent.campaign_id
    ORDER BY recent.updated_at DESC
  `) as Array<{
    business_id: string;
    id: string;
    name: string;
    updated_at: string;
    daily_budget: number | null;
    lifetime_budget: number | null;
    bid_strategy_type: string | null;
    manual_bid_amount: number | null;
    adset_count: number;
  }>;

  return rows.map((row) => {
    const hasCampaignBudget =
      row.daily_budget !== null || row.lifetime_budget !== null;
    const amount = Number(row.daily_budget ?? row.lifetime_budget ?? 0);
    const payload = normalizeMetaLaunchPayload({
      campaign: {
        name: `${row.name} (template)`,
        objective: "OUTCOME_SALES",
        specialAdCategories: [],
      },
      budget: {
        mode: hasCampaignBudget ? "CBO" : "ABO",
        schedule: row.lifetime_budget !== null ? "lifetime" : "daily",
        amountMinor: Math.max(0, Math.round(amount * 100)),
        bidStrategy:
          row.bid_strategy_type === "LOWEST_COST_WITH_BID_CAP" ||
          row.bid_strategy_type === "COST_CAP"
            ? row.bid_strategy_type
            : "LOWEST_COST_WITHOUT_CAP",
        bidAmountMinor: row.manual_bid_amount
          ? Math.round(Number(row.manual_bid_amount) * 100)
          : null,
      },
      creativeIds: [],
      creatives: [],
      adSets: Array.from({ length: Math.max(1, row.adset_count) }).map((_, index) => ({
        clientId: `recent-${row.id}-${index + 1}`,
        name: `${row.name} - ${index + 1}`,
        optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: "",
        customEventType: "PURCHASE",
        targeting: {
          countries: ["US"],
          ageMin: 18,
          ageMax: 65,
          advantageAudience: true,
          advantagePlacements: true,
        },
        attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
        budget: hasCampaignBudget
          ? null
          : {
              mode: "ABO",
              schedule: "daily",
              amountMinor: 0,
              bidStrategy: "LOWEST_COST_WITHOUT_CAP",
            },
      })),
    });
    return {
      id: row.id,
      businessId: row.business_id,
      name: row.name,
      description: `${row.adset_count} ad set${row.adset_count === 1 ? "" : "s"} - ${
        hasCampaignBudget ? "CBO" : "ABO"
      }`,
      payload,
      source: "auto_recent",
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    };
  });
}
