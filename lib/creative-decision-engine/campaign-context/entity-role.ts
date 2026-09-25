// Explicit, account-scoped Meta entity role declarations (D118).
//
// Meta carries no Main/Test/Mixed field, and the automatic resolver's authority
// gate stays closed (D074/D076). For genuine ambiguity the operator states the
// role of ONE entity — a campaign or an ad set — in one physical account, from
// one day, with an author and a reason. That statement is recorded append-only
// in `meta_entity_role_declarations` and read here.
//
// Three rules this module exists to hold:
//
// 1. A campaign and an ad set are separate entities with separate roles. A
//    Main campaign can run a Test ad set, so an ad set's role is NEVER its
//    campaign's. Without its own declaration, an ad set receives the parent
//    campaign's role only as a suggestion, capped below action authority.
// 2. A name is never read. Nothing here consults a campaign or ad set name.
// 3. The retired manual-label table (`meta_campaign_labels`) is not revived:
//    it is not read, not written, and nothing maps into it.
import { getDb, runDbTransaction } from "@/lib/db";
import type { CreativeCampaignContextTrust } from "../campaign-label-guard";
import {
  canonicalSha256,
  type CampaignContextProvenance,
} from "../canonical-evaluation";
import type {
  CampaignContextEntryWithProvenance,
  CampaignContextMode,
} from "./source";

export const ENTITY_ROLE_DECLARATION_CONTRACT_VERSION =
  "meta-entity-role-declaration.v1";
/** The only provenance source a declaration may carry. */
export const ENTITY_ROLE_DECLARATION_SOURCE = "operator_declared" as const;
export const ENTITY_ROLE_DECLARATION_TABLE = "meta_entity_role_declarations";

export const ROLE_ENTITY_TYPES = ["campaign", "adset"] as const;
export type RoleEntityType = (typeof ROLE_ENTITY_TYPES)[number];

/** Mixed is a campaign shape (a winner core beside active testing). */
export const DECLARABLE_ROLES: Readonly<
  Record<RoleEntityType, readonly ("main" | "test" | "mixed")[]>
> = Object.freeze({
  campaign: ["main", "test", "mixed"] as const,
  adset: ["main", "test"] as const,
});

export type DeclaredRole = "main" | "test" | "mixed";

export interface EntityRoleDeclarationEvent {
  id: string;
  businessId: string;
  providerAccountId: string;
  entityType: RoleEntityType;
  entityId: string;
  /** For an ad set: the campaign it was observed under when declared. Context only. */
  parentCampaignId: string | null;
  event: "declare" | "revoke";
  declaredRole: DeclaredRole | null;
  /** Calendar day from which the event applies. */
  effectiveFrom: string;
  /** Instant the event was recorded. Point-in-time reads bound on this. */
  declaredAt: string;
  declaredBy: string;
  reason: string | null;
  contractVersion: string;
}

export interface EntityRoleScope {
  businessId: string;
  providerAccountId: string;
  entityType: RoleEntityType;
  entityId: string;
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * The tighter of two knowledge bounds on declarations: a replay cutoff and
 * the instant the reading run began. Either absent defers to the other. An
 * unparseable bound is returned as-is so the read fails closed on it rather
 * than silently dropping it.
 */
export function declarationKnowledgeCutoff(
  visibleAtCutoff: string | null | undefined,
  recordedBy: string | null | undefined,
): string | null {
  const replay = visibleAtCutoff ?? null;
  const run = recordedBy ?? null;
  if (replay === null) return run;
  if (run === null) return replay;
  const replayMs = Date.parse(replay);
  const runMs = Date.parse(run);
  if (!Number.isFinite(replayMs)) return replay;
  if (!Number.isFinite(runMs)) return run;
  return replayMs <= runMs ? replay : run;
}

export function isDeclarableRole(
  entityType: RoleEntityType,
  role: unknown,
): role is DeclaredRole {
  return (
    typeof role === "string" &&
    ((DECLARABLE_ROLES[entityType] ?? []) as readonly string[]).includes(role)
  );
}

/**
 * The declaration in force for one entity at `asOf`, or null.
 *
 * Only events for the EXACT scope count (byte-for-byte strings, no trimming).
 * Among events effective on or before `asOf` — and, for a historical replay,
 * recorded at or before `visibleAtCutoff` — the latest recorded one wins. A
 * `revoke` winning means no declaration. An event from another contract
 * version, or naming a role this entity type cannot hold, is ignored rather
 * than repaired.
 */
export function selectActiveEntityRoleDeclaration(
  events: readonly EntityRoleDeclarationEvent[],
  scope: EntityRoleScope & {
    asOf: string;
    visibleAtCutoff?: string | null;
  },
): EntityRoleDeclarationEvent | null {
  if (!isCalendarDay(scope.asOf)) return null;
  const cutoffMs =
    scope.visibleAtCutoff == null ? null : Date.parse(scope.visibleAtCutoff);
  if (cutoffMs !== null && !Number.isFinite(cutoffMs)) return null;
  const inForce = events.filter((event) => {
    if (
      event.businessId !== scope.businessId ||
      event.providerAccountId !== scope.providerAccountId ||
      event.entityType !== scope.entityType ||
      event.entityId !== scope.entityId ||
      event.contractVersion !== ENTITY_ROLE_DECLARATION_CONTRACT_VERSION ||
      !isCalendarDay(event.effectiveFrom) ||
      event.effectiveFrom > scope.asOf
    ) {
      return false;
    }
    const declaredMs = Date.parse(event.declaredAt);
    if (!Number.isFinite(declaredMs)) return false;
    return cutoffMs === null || declaredMs <= cutoffMs;
  });
  if (inForce.length === 0) return null;
  const latest = [...inForce].sort(
    (left, right) =>
      Date.parse(left.declaredAt) - Date.parse(right.declaredAt) ||
      left.id.localeCompare(right.id),
  )[inForce.length - 1]!;
  if (latest.event !== "declare") return null;
  return isDeclarableRole(latest.entityType, latest.declaredRole)
    ? latest
    : null;
}

/** A role entry as every decision surface consumes it. @see CampaignContextEntryWithProvenance */
export type EntityRoleEntry = CampaignContextEntryWithProvenance;

/** A declaration, as a role entry. Authority requires the exact contract. */
export function declaredEntityRoleEntry(input: {
  declaration: EntityRoleDeclarationEvent;
  mode: CampaignContextMode;
}): EntityRoleEntry {
  const { declaration } = input;
  const kind = declaration.declaredRole!;
  const campaignId =
    declaration.entityType === "campaign"
      ? declaration.entityId
      : declaration.parentCampaignId;
  const sourceHash = canonicalSha256({
    sourceRecordType: ENTITY_ROLE_DECLARATION_TABLE,
    sourceRecordId: declaration.id,
    businessId: declaration.businessId,
    providerAccountId: declaration.providerAccountId,
    entityType: declaration.entityType,
    entityId: declaration.entityId,
    parentCampaignId: declaration.parentCampaignId,
    declaredRole: kind,
    effectiveFrom: declaration.effectiveFrom,
    declaredAt: declaration.declaredAt,
    declaredBy: declaration.declaredBy,
    contractVersion: declaration.contractVersion,
  });
  const provenance: CampaignContextProvenance = {
    mode: input.mode,
    source: ENTITY_ROLE_DECLARATION_SOURCE,
    campaignId,
    kind,
    testDimension: null,
    contextTrust: "high",
    sourceRecordType: ENTITY_ROLE_DECLARATION_TABLE,
    sourceRecordId: declaration.id,
    sourceAsOfDate: declaration.effectiveFrom,
    sourceUpdatedAt: declaration.declaredAt,
    sourceHash,
    roleEntityType: declaration.entityType,
    roleEntityId: declaration.entityId,
    roleDeclarationContractVersion: declaration.contractVersion,
  };
  return {
    kind,
    testDimension: null,
    contextTrust: "high",
    inferenceConfidenceClass: "high",
    // Not a resolver output: the resolver gate is neither consulted nor opened.
    resolverAuthorityValidated: false,
    declarationAuthorityValidated:
      declaration.contractVersion === ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
    roleEntityType: declaration.entityType,
    roleEntityId: declaration.entityId,
    roleBasis: "declared",
    provenance,
  };
}

function capBelowAuthority(
  trust: CreativeCampaignContextTrust | undefined,
): CreativeCampaignContextTrust {
  if (trust === "high" || trust === "override") return "medium";
  return trust ?? "unknown";
}

/**
 * An ad set with no declaration of its own.
 *
 * Its campaign's role is carried as a SUGGESTION: kind and provenance are the
 * campaign's, so the context stays visible, but trust is capped at medium and
 * both authority flags are false, so no role-dependent action can follow from
 * it. With no campaign entry at all the ad set is plainly unknown.
 *
 * A campaign entry at medium or below passes through with identical trust and
 * provenance, so a surface that never declares anything sees exactly what it
 * saw before this module existed.
 */
export function adsetRoleEntryFromParent(input: {
  adsetId: string | null;
  campaignId: string | null;
  parent: EntityRoleEntry | CampaignContextEntryWithProvenance | null | undefined;
  mode: CampaignContextMode;
}): EntityRoleEntry {
  const parent = input.parent ?? null;
  if (!parent) {
    return {
      kind: null,
      testDimension: null,
      contextTrust: "unknown",
      inferenceConfidenceClass: "unknown",
      resolverAuthorityValidated: false,
      declarationAuthorityValidated: false,
      roleEntityType: "adset",
      roleEntityId: input.adsetId,
      roleBasis: "none",
      provenance: {
        mode: input.mode,
        source: "unknown",
        campaignId: input.campaignId,
        kind: null,
        testDimension: null,
        contextTrust: null,
        sourceRecordType: null,
        sourceRecordId: null,
        sourceAsOfDate: null,
        sourceUpdatedAt: null,
        sourceHash: null,
      },
    };
  }
  const contextTrust = capBelowAuthority(parent.contextTrust);
  return {
    ...parent,
    contextTrust,
    resolverAuthorityValidated: false,
    declarationAuthorityValidated: false,
    roleEntityType: "adset",
    roleEntityId: input.adsetId,
    roleBasis: "parent_campaign_suggestion",
    provenance:
      contextTrust === parent.provenance.contextTrust
        ? parent.provenance
        : { ...parent.provenance, contextTrust },
  };
}

/**
 * The ONE predicate for role-dependent action authority.
 *
 * Exactly two provenances can satisfy it, each with its own proof:
 * - automatic inference: source `system_inferred`, class `high`, and the
 *   operator-approved resolver identity (D074 — unchanged, still env-gated);
 * - an explicit declaration: source `operator_declared`, class `high`, and the
 *   exact current declaration contract (D118).
 * Anything else — a suggestion inherited from a parent, a missing field, a
 * retired manual source — is not authority.
 */
export function isEntityRoleTrustedForAction(
  entry:
    | {
        kind: string | null;
        contextTrust?: string | null;
        inferenceConfidenceClass?: string | null;
        resolverAuthorityValidated?: boolean;
        declarationAuthorityValidated?: boolean;
        source?: string | null;
        provenance?: { source?: string | null } | null;
      }
    | null
    | undefined,
): boolean {
  if (!entry || !entry.kind) return false;
  if (entry.contextTrust !== "high") return false;
  if (entry.inferenceConfidenceClass !== "high") return false;
  const source = entry.provenance?.source ?? entry.source ?? null;
  if (source === "system_inferred") {
    return entry.resolverAuthorityValidated === true;
  }
  if (source === ENTITY_ROLE_DECLARATION_SOURCE) {
    return entry.declarationAuthorityValidated === true;
  }
  return false;
}

/** Exact-contract check for a persisted declaration's version and source. */
export function isEntityRoleDeclarationAuthorityValidated(input: {
  source: string | null | undefined;
  contractVersion: string | null | undefined;
}): boolean {
  return (
    input.source === ENTITY_ROLE_DECLARATION_SOURCE &&
    input.contractVersion === ENTITY_ROLE_DECLARATION_CONTRACT_VERSION
  );
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toEvent(row: Row): EntityRoleDeclarationEvent | null {
  const entityType = text(row.entity_type);
  const event = text(row.event);
  const id = text(row.id);
  const businessId = text(row.business_id);
  const providerAccountId = text(row.provider_account_id);
  const entityId = text(row.entity_id);
  const effectiveFrom = text(row.effective_from);
  const declaredAt = toIso(row.declared_at);
  const declaredBy = text(row.declared_by);
  const contractVersion = text(row.contract_version);
  if (
    (entityType !== "campaign" && entityType !== "adset") ||
    (event !== "declare" && event !== "revoke") ||
    !id ||
    !businessId ||
    !providerAccountId ||
    !entityId ||
    !effectiveFrom ||
    !declaredAt ||
    !declaredBy ||
    !contractVersion
  ) {
    return null;
  }
  const role = text(row.declared_role);
  return {
    id,
    businessId,
    providerAccountId,
    entityType,
    entityId,
    parentCampaignId: text(row.parent_campaign_id),
    event,
    declaredRole:
      role === "main" || role === "test" || role === "mixed" ? role : null,
    effectiveFrom,
    declaredAt,
    declaredBy,
    reason: text(row.reason),
    contractVersion,
  };
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

/**
 * During a rolling migration the declaration table may not exist yet. A
 * failed SELECT would poison a caller's read-only PostgreSQL transaction even
 * if we caught 42P01 in JavaScript, so probe the catalog before referencing
 * the relation. Keep checking until it appears; a long-lived process can
 * span the migration without caching an absent table forever.
 */
async function declarationTableExists(): Promise<boolean> {
  const [row] = await getDb().query<Row>(
    "SELECT to_regclass('meta_entity_role_declarations')::text AS table_name",
  );
  return typeof row?.table_name === "string" && row.table_name.length > 0;
}

/**
 * Every declaration event that can bear on `entityIds` at `asOf`.
 *
 * Before the D118 migration has run the table does not exist; that reads as
 * "nothing declared", which can only withhold authority (a declaration is the
 * only thing that grants it). Any other read failure throws, as the automatic
 * context read does.
 */
export async function readEntityRoleDeclarationEvents(input: {
  businessId: string;
  providerAccountId: string;
  entityType: RoleEntityType;
  entityIds: readonly string[];
  asOf: string;
  visibleAtCutoff?: string | null;
  /**
   * The decision run whose knowledge this read must match. A declaration
   * counts only if it was recorded by that run's `started_at`, so the run that
   * published a generation and every later read of that generation see the
   * SAME declarations: one recorded afterwards reaches the next run, never an
   * earlier generation. An unknown run admits nothing.
   */
  knowledgeJobRunId?: string | null;
}): Promise<EntityRoleDeclarationEvent[]> {
  if (input.entityIds.length === 0 || !input.providerAccountId) return [];
  if (!(await declarationTableExists())) return [];
  try {
    const rows = await getDb().query<Row>(
      `
      SELECT
        id::text AS id,
        business_id,
        provider_account_id,
        entity_type,
        entity_id,
        parent_campaign_id,
        event,
        declared_role,
        effective_from::text AS effective_from,
        declared_at,
        declared_by,
        reason,
        contract_version
      FROM meta_entity_role_declarations
      WHERE business_id = $1
        AND provider_account_id = $2
        AND entity_type = $3
        AND entity_id = ANY($4::text[])
        AND effective_from <= $5::date
        AND ($6::timestamptz IS NULL OR declared_at <= $6::timestamptz)
        AND (
          $7::uuid IS NULL
          OR declared_at <= (
            SELECT run.started_at FROM engine_v3_job_runs run WHERE run.id = $7::uuid
          )
        )
      ORDER BY entity_id, declared_at, id
      `,
      [
        input.businessId,
        input.providerAccountId,
        input.entityType,
        [...input.entityIds],
        input.asOf,
        input.visibleAtCutoff ?? null,
        input.knowledgeJobRunId ?? null,
      ],
    );
    return rows
      .map(toEvent)
      .filter((event): event is EntityRoleDeclarationEvent => event !== null);
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

/** The declaration in force for each requested entity, keyed by entity id. */
export async function readActiveEntityRoleDeclarations(input: {
  businessId: string;
  providerAccountId: string;
  entityType: RoleEntityType;
  entityIds: readonly string[];
  asOf: string;
  visibleAtCutoff?: string | null;
  /** @see readEntityRoleDeclarationEvents */
  knowledgeJobRunId?: string | null;
}): Promise<Map<string, EntityRoleDeclarationEvent>> {
  const events = await readEntityRoleDeclarationEvents(input);
  const active = new Map<string, EntityRoleDeclarationEvent>();
  for (const entityId of new Set(input.entityIds)) {
    const declaration = selectActiveEntityRoleDeclaration(events, {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      entityType: input.entityType,
      entityId,
      asOf: input.asOf,
      visibleAtCutoff: input.visibleAtCutoff ?? null,
    });
    if (declaration) active.set(entityId, declaration);
  }
  return active;
}

/** Stable key for an ad set's role inside one physical account. */
export function adsetRoleKey(providerAccountId: string, adsetId: string) {
  return `${providerAccountId}\u0000${adsetId}`;
}

// ── Writing ──────────────────────────────────────────────────────────────

export interface EntityRoleDeclarationRequest {
  entityType: string;
  entityId: string;
  event: string;
  role?: string | null;
  effectiveFrom: string;
  reason?: string | null;
}

export type EntityRoleDeclarationRefusal =
  | "entity_type_invalid"
  | "entity_id_missing"
  | "event_invalid"
  | "role_invalid_for_entity"
  | "role_present_on_revoke"
  | "effective_from_invalid"
  | "effective_from_backdated"
  | "reason_too_long"
  | "duplicate_entity_in_request"
  | "entity_not_observed_in_account"
  | "entity_parent_ambiguous";

/**
 * Pure validation of one request. A declaration may not reach back before the
 * day it is recorded (one day of slack for account time zones): authority is
 * never granted retroactively, and a replay can never see a role that was not
 * yet stated.
 */
export function validateEntityRoleDeclarationRequest(
  request: EntityRoleDeclarationRequest,
  now: Date,
): EntityRoleDeclarationRefusal | null {
  if (request.entityType !== "campaign" && request.entityType !== "adset") {
    return "entity_type_invalid";
  }
  if (typeof request.entityId !== "string" || !/^\d+$/.test(request.entityId)) {
    return "entity_id_missing";
  }
  if (request.event !== "declare" && request.event !== "revoke") {
    return "event_invalid";
  }
  if (request.event === "declare" && !isDeclarableRole(request.entityType, request.role)) {
    return "role_invalid_for_entity";
  }
  if (request.event === "revoke" && request.role != null) {
    return "role_present_on_revoke";
  }
  if (!isCalendarDay(request.effectiveFrom)) return "effective_from_invalid";
  const earliest = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (request.effectiveFrom < earliest) return "effective_from_backdated";
  if (request.reason != null && request.reason.length > 500) {
    return "reason_too_long";
  }
  return null;
}

/**
 * The account this entity was observed in, and for an ad set its campaign.
 * Provider observation is the only binding: names are never consulted.
 */
async function observedEntityBinding(input: {
  businessId: string;
  providerAccountId: string;
  entityType: RoleEntityType;
  entityId: string;
}): Promise<
  | { ok: true; parentCampaignId: string | null }
  | { ok: false; refusal: EntityRoleDeclarationRefusal }
> {
  const idColumn = input.entityType === "campaign" ? "campaign_id" : "adset_id";
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT campaign_id
    FROM (
      SELECT campaign_id
      FROM meta_entity_state_history
      WHERE business_id = $1
        AND provider_account_id = $2
        AND entity_type = $3
        AND entity_id = $4
        AND presence = 'present'
      UNION
      SELECT campaign_id
      FROM meta_ad_daily
      WHERE business_id = $1
        AND provider_account_id = $2
        AND ${idColumn} = $4
    ) observed
    `,
    [input.businessId, input.providerAccountId, input.entityType, input.entityId],
  );
  if (rows.length === 0) {
    return { ok: false, refusal: "entity_not_observed_in_account" };
  }
  if (input.entityType === "campaign") return { ok: true, parentCampaignId: null };
  const parents = [
    ...new Set(
      rows
        .map((row) => text(row.campaign_id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (parents.length !== 1) return { ok: false, refusal: "entity_parent_ambiguous" };
  return { ok: true, parentCampaignId: parents[0]! };
}

export type AppendEntityRoleDeclarationsResult =
  | { ok: true; events: EntityRoleDeclarationEvent[] }
  | {
      ok: false;
      refusal: EntityRoleDeclarationRefusal;
      index: number;
      entityId: string | null;
    };

/**
 * Appends a batch of declaration events atomically. Each entity is stated on
 * its own: declaring a campaign says nothing about its ad sets, and a batch
 * that names both does so explicitly, one row each. Nothing is updated or
 * deleted; a change of mind is a later event.
 */
export async function appendEntityRoleDeclarations(input: {
  businessId: string;
  providerAccountId: string;
  declaredBy: string;
  requests: readonly EntityRoleDeclarationRequest[];
  now?: Date;
}): Promise<AppendEntityRoleDeclarationsResult> {
  const now = input.now ?? new Date();
  const seen = new Set<string>();
  for (const [index, request] of input.requests.entries()) {
    const refusal = validateEntityRoleDeclarationRequest(request, now);
    if (refusal) return { ok: false, refusal, index, entityId: request.entityId ?? null };
    const key = `${request.entityType}:${request.entityId}`;
    if (seen.has(key)) {
      return { ok: false, refusal: "duplicate_entity_in_request", index, entityId: request.entityId };
    }
    seen.add(key);
  }
  /*
    Every binding is proven BEFORE anything is written, so a refusal on the
    third entity leaves the first two unrecorded: the batch is all or nothing.
  */
  const parents: Array<string | null> = [];
  for (const [index, request] of input.requests.entries()) {
    const binding = await observedEntityBinding({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      entityType: request.entityType as RoleEntityType,
      entityId: request.entityId,
    });
    if (!binding.ok) {
      return { ok: false, refusal: binding.refusal, index, entityId: request.entityId };
    }
    parents.push(binding.parentCampaignId);
  }
  return runDbTransaction(async () => {
    const events: EntityRoleDeclarationEvent[] = [];
    for (const [index, request] of input.requests.entries()) {
      const rows = await getDb().query<Row>(
        `
        INSERT INTO meta_entity_role_declarations (
          business_id, provider_account_id, entity_type, entity_id,
          parent_campaign_id, event, declared_role, effective_from,
          declared_at, declared_by, reason, contract_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::timestamptz, $10, $11, $12)
        RETURNING
          id::text AS id, business_id, provider_account_id, entity_type,
          entity_id, parent_campaign_id, event, declared_role,
          effective_from::text AS effective_from, declared_at, declared_by,
          reason, contract_version
        `,
        [
          input.businessId,
          input.providerAccountId,
          request.entityType,
          request.entityId,
          parents[index] ?? null,
          request.event,
          request.event === "declare" ? request.role : null,
          request.effectiveFrom,
          now.toISOString(),
          input.declaredBy,
          request.reason?.trim() || null,
          ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
        ],
      );
      const event = rows[0] ? toEvent(rows[0]) : null;
      // Throwing rolls the whole batch back.
      if (!event) throw new Error("entity_role_declaration_insert_unreadable");
      events.push(event);
    }
    return { ok: true as const, events };
  });
}

/** Declaration history for one account, newest first, for the review surface. */
export async function listEntityRoleDeclarations(input: {
  businessId: string;
  providerAccountId: string;
  limit?: number;
}): Promise<EntityRoleDeclarationEvent[]> {
  if (!(await declarationTableExists())) return [];
  try {
    const rows = await getDb().query<Row>(
      `
      SELECT
        id::text AS id, business_id, provider_account_id, entity_type,
        entity_id, parent_campaign_id, event, declared_role,
        effective_from::text AS effective_from, declared_at, declared_by,
        reason, contract_version
      FROM meta_entity_role_declarations
      WHERE business_id = $1 AND provider_account_id = $2
      ORDER BY declared_at DESC, id DESC
      LIMIT $3
      `,
      [input.businessId, input.providerAccountId, Math.min(Math.max(input.limit ?? 500, 1), 2000)],
    );
    return rows
      .map(toEvent)
      .filter((event): event is EntityRoleDeclarationEvent => event !== null);
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}
