import { getDb, type DbClient } from "@/lib/db";
import { chunkDecisionRows } from "./batching";
import {
  canonicalSha256,
  stableCanonicalJson,
  type CanonicalEvaluationProvenance,
  type CanonicalJsonObject,
} from "./canonical-evaluation";
import {
  DECISION_AUTHORITY_BLOCKERS,
  type DecisionAuthorityBlocker,
  type DecisionLabel,
  type DecisionProfileScope,
} from "./types";

export { DECISION_AUTHORITY_BLOCKERS };
export type { DecisionAuthorityBlocker };

export const AD_DECISION_EVALUATION_CONTRACT_VERSION =
  "engine-v3-canonical-ad-evaluation.v6" as const;

export interface AdDecisionEvaluationIdentity {
  decisionEntityType: "ad";
  decisionEntityId: string;
  adId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  /** Portfolio/grouping metadata only. It never participates in row identity. */
  creativeId: string | null;
}

export interface AdCanonicalEvaluationProvenance {
  contractVersion: typeof AD_DECISION_EVALUATION_CONTRACT_VERSION;
  identity: AdDecisionEvaluationIdentity;
  contextPayload: CanonicalJsonObject;
  inputPayload: CanonicalJsonObject;
  decisionPayload: CanonicalJsonObject;
  contextJson: string;
  inputJson: string;
  decisionJson: string;
  contextHash: string;
  inputHash: string;
  decisionHash: string;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  hysteresisSuppressed: boolean;
}

export interface EvaluationStoreSchemaCapability {
  ready: boolean;
  missing: string[];
}

export class EvaluationStoreSchemaNotReadyError extends Error {
  readonly code = "ad_decision_evaluation_schema_not_ready";

  constructor(readonly missing: readonly string[]) {
    super(`Ad decision evaluation schema is not ready: ${missing.join(", ")}`);
    this.name = "EvaluationStoreSchemaNotReadyError";
  }
}

type ColumnRow = Record<string, unknown> & {
  table_name: unknown;
  column_name: unknown;
  is_nullable: unknown;
  data_type: unknown;
  udt_name: unknown;
  character_maximum_length: unknown;
};

type IndexRow = Record<string, unknown> & {
  tablename: unknown;
  indexname: unknown;
  indexdef: unknown;
};

type ConstraintRow = Record<string, unknown> & {
  table_name: unknown;
  constraint_name: unknown;
  constraint_type: unknown;
  definition: unknown;
  validated: unknown;
};

type IdRow = Record<string, unknown> & { id: unknown };

type StoredEvaluationRow = Record<string, unknown> & {
  id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  decision_entity_id: unknown;
  evaluation_id?: unknown;
  input_hash: unknown;
  decision_hash: unknown;
};

export const AD_EVALUATION_CONTEXTS_TABLE =
  "engine_v3_ad_decision_evaluation_contexts";
export const AD_EVALUATIONS_TABLE = "engine_v3_ad_decision_evaluations";
export const AD_SNAPSHOTS_TABLE = "engine_v3_ad_decision_snapshots_daily";
export const AD_EVENTS_TABLE = "engine_v3_ad_decision_events";

export const AD_DECISION_SCHEMA_REQUIRED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  [AD_EVALUATION_CONTEXTS_TABLE]: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "contract_version",
    "context_json",
    "account_profile_json",
    "data_health_json",
    "flags_json",
    "context_hash",
    "job_run_id",
    "evaluated_at",
    "created_at",
  ],
  [AD_EVALUATIONS_TABLE]: [
    "id",
    "context_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "contract_version",
    "creative_input_json",
    "campaign_context_json",
    "prior_hysteresis_json",
    "decision_output_json",
    "raw_label",
    "hysteresis_suppressed",
    "input_hash",
    "decision_hash",
    "job_run_id",
    "evaluated_at",
    "created_at",
  ],
  [AD_SNAPSHOTS_TABLE]: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "label",
    "raw_label",
    "pre_authority_label",
    "authority_blocker",
    "confidence",
    "truth_source",
    "effective_target_roas",
    "ratio_to_target",
    "badges",
    "reason",
    "spend",
    "purchases",
    "roas",
    "recent7d_roas",
    "label_transform",
    "blocked_action_type",
    "authorized_action",
    "job_run_id",
    "creative_evidence_lifecycle_row_id",
    "calibration_row_id",
    "evaluation_id",
    "input_hash",
    "decision_hash",
    "computed_at",
    "created_at",
    "updated_at",
  ],
  [AD_EVENTS_TABLE]: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "event_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "event_type",
    "previous_label",
    "current_label",
    "previous_confidence",
    "current_confidence",
    "operator_action_type",
    "operator_evidence",
    "decision_snapshot_id",
    "job_run_id",
    "notes",
    "created_at",
    "updated_at",
  ],
};

const NULLABLE_COLUMNS = new Set([
  `${AD_EVALUATIONS_TABLE}.creative_id`,
  `${AD_SNAPSHOTS_TABLE}.creative_id`,
  `${AD_SNAPSHOTS_TABLE}.ratio_to_target`,
  `${AD_SNAPSHOTS_TABLE}.spend`,
  `${AD_SNAPSHOTS_TABLE}.purchases`,
  `${AD_SNAPSHOTS_TABLE}.roas`,
  `${AD_SNAPSHOTS_TABLE}.recent7d_roas`,
  `${AD_SNAPSHOTS_TABLE}.label_transform`,
  `${AD_SNAPSHOTS_TABLE}.blocked_action_type`,
  `${AD_SNAPSHOTS_TABLE}.pre_authority_label`,
  `${AD_SNAPSHOTS_TABLE}.authority_blocker`,
  `${AD_SNAPSHOTS_TABLE}.authorized_action`,
  `${AD_SNAPSHOTS_TABLE}.creative_evidence_lifecycle_row_id`,
  `${AD_SNAPSHOTS_TABLE}.calibration_row_id`,
  `${AD_EVENTS_TABLE}.creative_id`,
  `${AD_EVENTS_TABLE}.previous_label`,
  `${AD_EVENTS_TABLE}.current_label`,
  `${AD_EVENTS_TABLE}.previous_confidence`,
  `${AD_EVENTS_TABLE}.current_confidence`,
  `${AD_EVENTS_TABLE}.operator_action_type`,
  `${AD_EVENTS_TABLE}.operator_evidence`,
  `${AD_EVENTS_TABLE}.decision_snapshot_id`,
  `${AD_EVENTS_TABLE}.job_run_id`,
  `${AD_EVENTS_TABLE}.notes`,
]);

const UUID_COLUMNS = new Set([
  "id",
  "business_ref_id",
  "provider_account_ref_id",
  "job_run_id",
  "context_id",
  "evaluation_id",
  "creative_evidence_lifecycle_row_id",
  "calibration_row_id",
  "decision_snapshot_id",
]);
const DATE_COLUMNS = new Set(["as_of_date", "event_date"]);
const TIMESTAMPTZ_COLUMNS = new Set([
  "evaluated_at",
  "computed_at",
  "created_at",
  "updated_at",
]);
const JSONB_COLUMNS = new Set([
  "context_json",
  "account_profile_json",
  "data_health_json",
  "flags_json",
  "creative_input_json",
  "campaign_context_json",
  "prior_hysteresis_json",
  "decision_output_json",
  "badges",
  "operator_evidence",
]);
const INTEGER_COLUMNS = new Set([
  "confidence",
  "previous_confidence",
  "current_confidence",
]);
const FLOAT_COLUMNS = new Set([
  "effective_target_roas",
  "ratio_to_target",
  "spend",
  "purchases",
  "roas",
  "recent7d_roas",
]);
const HASH_COLUMNS = new Set(["context_hash", "input_hash", "decision_hash"]);

export interface AdDecisionColumnContract {
  udtName: string;
  nullable: boolean;
  characterMaximumLength: number | null;
}

export function expectedAdDecisionColumnContract(
  table: string,
  column: string,
): AdDecisionColumnContract {
  const identity = `${table}.${column}`;
  if (HASH_COLUMNS.has(column)) {
    return {
      udtName: "bpchar",
      nullable: NULLABLE_COLUMNS.has(identity),
      characterMaximumLength: 64,
    };
  }
  const udtName = UUID_COLUMNS.has(column)
    ? "uuid"
    : DATE_COLUMNS.has(column)
      ? "date"
      : TIMESTAMPTZ_COLUMNS.has(column)
        ? "timestamptz"
        : JSONB_COLUMNS.has(column)
          ? "jsonb"
          : INTEGER_COLUMNS.has(column)
            ? "int4"
            : FLOAT_COLUMNS.has(column)
              ? "float8"
              : column === "hysteresis_suppressed"
                ? "bool"
                : "text";
  return {
    udtName,
    nullable: NULLABLE_COLUMNS.has(identity),
    characterMaximumLength: null,
  };
}

export interface RequiredConstraintContract {
  table: string;
  name: string;
  type: "c" | "f" | "u";
  allOf: readonly string[];
}

export const AD_DECISION_REQUIRED_CONSTRAINTS: readonly RequiredConstraintContract[] = [
  {
    table: "engine_v3_job_runs",
    name: "engine_v3_job_runs_native_lineage_unique",
    type: "u",
    allOf: [
      "unique (id, business_ref_id, business_id, as_of_date, engine_version)",
    ],
  },
  ...(
    [
      [
        AD_EVALUATION_CONTEXTS_TABLE,
        "engine_v3_ad_eval_contexts_business_identity_check",
      ],
      [
        AD_EVALUATIONS_TABLE,
        "engine_v3_ad_evaluations_business_identity_check",
      ],
      [
        AD_SNAPSHOTS_TABLE,
        "engine_v3_ad_snapshots_business_identity_check",
      ],
      [AD_EVENTS_TABLE, "engine_v3_ad_events_business_identity_check"],
    ] as const
  ).map(([table, name]) => ({
    table,
    name,
    type: "c" as const,
    allOf: ["business_id", "business_ref_id"],
  })),
  ...(
    [
      [
        AD_EVALUATION_CONTEXTS_TABLE,
        "engine_v3_ad_eval_contexts_account_scope_check",
      ],
      [
        AD_EVALUATIONS_TABLE,
        "engine_v3_ad_evaluations_account_scope_check",
      ],
      [
        AD_SNAPSHOTS_TABLE,
        "engine_v3_ad_snapshots_account_scope_check",
      ],
      [AD_EVENTS_TABLE, "engine_v3_ad_events_account_scope_check"],
    ] as const
  ).map(([table, name]) => ({
    table,
    name,
    type: "c" as const,
    allOf: ["scope_type", "account", "scope_id", "provider_account_id"],
  })),
  ...(
    [
      [
        AD_EVALUATIONS_TABLE,
        "engine_v3_ad_evaluations_entity_identity_check",
      ],
      [
        AD_SNAPSHOTS_TABLE,
        "engine_v3_ad_snapshots_entity_identity_check",
      ],
      [AD_EVENTS_TABLE, "engine_v3_ad_events_entity_identity_check"],
    ] as const
  ).map(([table, name]) => ({
    table,
    name,
    type: "c" as const,
    allOf: ["decision_entity_id", "ad_id"],
  })),
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_pre_authority_label_check",
    type: "c",
    allOf: [
      "pre_authority_label is null", "scale", "keep", "refresh", "cut",
      "test_more", "diagnose", "out_of_scope",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_authority_blocker_check",
    type: "c",
    allOf: ["authority_blocker is null", ...DECISION_AUTHORITY_BLOCKERS],
  },
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "engine_v3_ad_eval_contexts_binding_fk",
    type: "f",
    allOf: [
      "foreign key (business_id, provider_account_ref_id, provider_account_id)",
      "references business_provider_accounts(business_id, provider_account_ref_id, provider_account_id)",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "engine_v3_ad_eval_contexts_job_run_lineage_fk",
    type: "f",
    allOf: [
      "foreign key (job_run_id, business_ref_id, business_id, as_of_date, engine_version)",
      "references engine_v3_job_runs(id, business_ref_id, business_id, as_of_date, engine_version)",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "engine_v3_ad_eval_contexts_run_scope_hash_unique",
    type: "u",
    allOf: [
      "job_run_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, context_hash",
    ],
  },
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "engine_v3_ad_eval_contexts_lineage_unique",
    type: "u",
    allOf: [
      "id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, contract_version, job_run_id",
    ],
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "engine_v3_ad_evaluations_binding_fk",
    type: "f",
    allOf: [
      "foreign key (business_id, provider_account_ref_id, provider_account_id)",
      "references business_provider_accounts(business_id, provider_account_ref_id, provider_account_id)",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "engine_v3_ad_evaluations_context_lineage_fk",
    type: "f",
    allOf: [
      "context_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
      "contract_version, job_run_id",
      "references engine_v3_ad_decision_evaluation_contexts",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "engine_v3_ad_evaluations_ad_identity_unique",
    type: "u",
    allOf: [
      "context_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, input_hash, decision_hash",
    ],
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "engine_v3_ad_evaluations_snapshot_lineage_unique",
    type: "u",
    allOf: ["provider_account_ref_id", "decision_hash", "job_run_id"],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_binding_fk",
    type: "f",
    allOf: [
      "foreign key (business_id, provider_account_ref_id, provider_account_id)",
      "references business_provider_accounts(business_id, provider_account_ref_id, provider_account_id)",
      "on delete restrict",
    ],
  },
  {
    table: "engine_v3_ad_account_calibration_daily",
    name: "engine_v3_ad_calibration_snapshot_lineage_unique",
    type: "u",
    allOf: [
      "id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_calibration_lineage_fk",
    type: "f",
    allOf: [
      "foreign key (calibration_row_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version)",
      "references engine_v3_ad_account_calibration_daily(id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version)",
      "on delete restrict",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_authority_check",
    type: "c",
    allOf: [
      "calibration_row_id is null",
      "confidence <= 40",
      "authorized_action",
      "authority_blocker",
      "pending_transition",
      "native_calibration_unavailable",
      "raw_label",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_ad_identity_unique",
    type: "u",
    allOf: [
      "business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, as_of_date, engine_version, scope_type, scope_id",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_evaluation_unique",
    type: "u",
    allOf: ["unique (evaluation_id)"],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_evaluation_lineage_fk",
    type: "f",
    allOf: [
      "evaluation_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
      "decision_hash, job_run_id",
      "references engine_v3_ad_decision_evaluations",
      "on delete restrict",
    ],
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "engine_v3_ad_snapshots_event_lineage_unique",
    type: "u",
    allOf: [
      "id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
      "label, confidence, job_run_id",
    ],
  },
  {
    table: AD_EVENTS_TABLE,
    name: "engine_v3_ad_events_binding_fk",
    type: "f",
    allOf: [
      "foreign key (business_id, provider_account_ref_id, provider_account_id)",
      "references business_provider_accounts(business_id, provider_account_ref_id, provider_account_id)",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVENTS_TABLE,
    name: "engine_v3_ad_events_job_run_fk",
    type: "f",
    allOf: [
      "foreign key (job_run_id)",
      "references engine_v3_job_runs(id)",
      "on delete restrict",
    ],
  },
  {
    table: AD_EVENTS_TABLE,
    name: "engine_v3_ad_events_change_lineage_check",
    type: "c",
    allOf: [
      "event_type",
      "decision_changed",
      "previous_label",
      "current_label",
      "decision_snapshot_id",
      "job_run_id",
    ],
  },
  {
    table: AD_EVENTS_TABLE,
    name: "engine_v3_ad_events_snapshot_fk",
    type: "f",
    allOf: [
      "decision_snapshot_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
      "current_label, current_confidence, job_run_id",
      "references engine_v3_ad_decision_snapshots_daily",
      "on delete restrict",
    ],
  },
] as const;

export interface RequiredIndexContract {
  table: string;
  name: string;
  unique: boolean;
  orderedColumns: readonly string[];
  predicate: string | null;
}

export const AD_DECISION_REQUIRED_INDEXES: readonly RequiredIndexContract[] = [
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "idx_engine_v3_ad_eval_contexts_business_scope",
    unique: false,
    orderedColumns: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "as_of_date desc",
      "engine_version",
      "scope_type",
      "scope_id",
      "evaluated_at desc",
    ],
    predicate: null,
  },
  {
    table: AD_EVALUATION_CONTEXTS_TABLE,
    name: "idx_engine_v3_ad_eval_contexts_job",
    unique: false,
    orderedColumns: ["job_run_id", "evaluated_at desc"],
    predicate: null,
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "idx_engine_v3_ad_evaluations_entity_timeline",
    unique: false,
    orderedColumns: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "decision_entity_type",
      "decision_entity_id",
      "as_of_date desc",
      "evaluated_at desc",
    ],
    predicate: null,
  },
  {
    table: AD_EVALUATIONS_TABLE,
    name: "idx_engine_v3_ad_evaluations_context",
    unique: false,
    orderedColumns: ["context_id", "evaluated_at desc"],
    predicate: null,
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "idx_engine_v3_ad_snapshots_business_day_label",
    unique: false,
    orderedColumns: [
      "business_ref_id",
      "as_of_date desc",
      "engine_version",
      "label",
    ],
    predicate: null,
  },
  {
    table: AD_SNAPSHOTS_TABLE,
    name: "idx_engine_v3_ad_snapshots_entity_timeline",
    unique: false,
    orderedColumns: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "decision_entity_type",
      "decision_entity_id",
      "as_of_date desc",
      "computed_at desc",
    ],
    predicate: null,
  },
  {
    table: AD_EVENTS_TABLE,
    name: "idx_engine_v3_ad_events_business_date",
    unique: false,
    orderedColumns: ["business_ref_id", "event_date desc", "event_type"],
    predicate: null,
  },
  {
    table: AD_EVENTS_TABLE,
    name: "idx_engine_v3_ad_events_entity_timeline",
    unique: false,
    orderedColumns: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "decision_entity_type",
      "decision_entity_id",
      "event_date desc",
    ],
    predicate: null,
  },
  {
    table: AD_EVENTS_TABLE,
    name: "engine_v3_ad_events_change_unique",
    unique: true,
    orderedColumns: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "decision_entity_type",
      "decision_entity_id",
      "event_date",
      "engine_version",
      "scope_type",
      "scope_id",
      "event_type",
    ],
    predicate: "event_type = 'decision_changed'",
  },
] as const;

function nonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} must be a non-empty string.`);
  return text;
}

export function normalizeAdDecisionEvaluationIdentity(
  input: AdDecisionEvaluationIdentity,
): AdDecisionEvaluationIdentity {
  if (input.decisionEntityType !== "ad") {
    throw new TypeError("decisionEntityType must be ad.");
  }
  const decisionEntityId = nonEmpty(input.decisionEntityId, "decisionEntityId");
  const adId = nonEmpty(input.adId, "adId");
  if (decisionEntityId !== adId) {
    throw new TypeError("decisionEntityId must equal the native adId.");
  }
  return {
    decisionEntityType: "ad",
    decisionEntityId,
    adId,
    providerAccountId: nonEmpty(input.providerAccountId, "providerAccountId"),
    providerAccountRefId: nonEmpty(
      input.providerAccountRefId,
      "providerAccountRefId",
    ),
    creativeId:
      typeof input.creativeId === "string" && input.creativeId.trim()
        ? input.creativeId.trim()
        : null,
  };
}

/** Identity key deliberately excludes creativeId: one creative can back many ads. */
export function adDecisionEvaluationIdentityKey(
  identity: AdDecisionEvaluationIdentity,
): string {
  const normalized = normalizeAdDecisionEvaluationIdentity(identity);
  return `${normalized.providerAccountRefId}:${normalized.providerAccountId}:${normalized.decisionEntityType}:${normalized.decisionEntityId}`;
}

function withoutKeys(
  input: object,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !keys.includes(key)),
  );
}

/**
 * Upgrades the existing normalized resolver payload to an ad-owned identity
 * envelope. The v1 hashes are not reused because they do not bind native adId.
 */
export function buildAdCanonicalEvaluationProvenance(input: {
  identity: AdDecisionEvaluationIdentity;
  base: CanonicalEvaluationProvenance;
}): AdCanonicalEvaluationProvenance {
  const identity = normalizeAdDecisionEvaluationIdentity(input.identity);
  const contextPayload = {
    ...withoutKeys(input.base.contextPayload, ["contractVersion"]),
    contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
  } satisfies Record<string, unknown>;
  const contextHash = canonicalSha256(contextPayload);
  const inputPayload = {
    ...withoutKeys(input.base.inputPayload, ["contractVersion", "contextHash"]),
    contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
    contextHash,
    decisionIdentity: {
      decisionEntityType: identity.decisionEntityType,
      decisionEntityId: identity.decisionEntityId,
      adId: identity.adId,
      providerAccountId: identity.providerAccountId,
      providerAccountRefId: identity.providerAccountRefId,
      creativeGroupingId: identity.creativeId,
    },
  } satisfies Record<string, unknown>;
  const inputHash = canonicalSha256(inputPayload);
  const decisionPayload = {
    ...withoutKeys(input.base.decisionPayload, [
      "contractVersion",
      "inputHash",
    ]),
    contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
    inputHash,
  } satisfies Record<string, unknown>;
  const decisionHash = canonicalSha256(decisionPayload);

  return {
    contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
    identity,
    contextPayload: contextPayload as CanonicalJsonObject,
    inputPayload: inputPayload as CanonicalJsonObject,
    decisionPayload: decisionPayload as CanonicalJsonObject,
    contextJson: stableCanonicalJson(contextPayload),
    inputJson: stableCanonicalJson(inputPayload),
    decisionJson: stableCanonicalJson(decisionPayload),
    contextHash,
    inputHash,
    decisionHash,
    rawLabel: input.base.decisionPayload.rawLabel,
    publishedLabel: input.base.decisionPayload.publishedLabel,
    hysteresisSuppressed: input.base.decisionPayload.hysteresisSuppressed,
  };
}

function normalizeSqlDefinition(value: unknown): string {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .replaceAll('"', "")
        .replaceAll("public.", "")
        .replace(/::(?:text|character varying)/g, "")
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")
        .replace(/\s+\(/g, "(")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trim()
    : "";
}

function normalizedIndexPredicate(definition: string): string | null {
  const match = definition.match(/\swhere\s*(.+)$/);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesIndexContract(
  row: IndexRow | undefined,
  contract: RequiredIndexContract,
): boolean {
  if (!row || row.tablename !== contract.table) return false;
  const definition = normalizeSqlDefinition(row.indexdef).replaceAll(
    "using btree ",
    "",
  );
  if (
    contract.unique !== definition.startsWith("create unique index") ||
    !definition.includes(`(${contract.orderedColumns.join(", ")})`)
  ) {
    return false;
  }
  return normalizedIndexPredicate(definition) === contract.predicate;
}

function hasCreativeOwnedUniqueIndex(rows: IndexRow[], table: string): boolean {
  return rows.some((row) => {
    const definition = normalizeSqlDefinition(row.indexdef);
    return (
      row.tablename === table &&
      definition.includes("create unique index") &&
      definition.includes("creative_id") &&
      !definition.includes("decision_entity_id")
    );
  });
}

export async function inspectEvaluationStoreSchemaCapability(
  db: DbClient = getDb(),
): Promise<EvaluationStoreSchemaCapability> {
  const columns = await db.query<ColumnRow>(
    `
    SELECT table_name, column_name, is_nullable, data_type, udt_name,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])
    `,
    [
      [
        AD_EVALUATION_CONTEXTS_TABLE,
        AD_EVALUATIONS_TABLE,
        AD_SNAPSHOTS_TABLE,
        AD_EVENTS_TABLE,
      ],
    ],
  );
  const indexes = await db.query<IndexRow>(
    `
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = ANY($1::text[])
    `,
    [
      [
        AD_EVALUATION_CONTEXTS_TABLE,
        AD_EVALUATIONS_TABLE,
        AD_SNAPSHOTS_TABLE,
        AD_EVENTS_TABLE,
      ],
    ],
  );
  const constraints = await db.query<ConstraintRow>(
    `
    SELECT
      relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      constraint_row.contype::text AS constraint_type,
      pg_get_constraintdef(constraint_row.oid, true) AS definition,
      constraint_row.convalidated AS validated
    FROM pg_constraint constraint_row
    INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    INNER JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND relation.relname = ANY($1::text[])
    `,
    [
      [
        AD_EVALUATION_CONTEXTS_TABLE,
        AD_EVALUATIONS_TABLE,
        AD_SNAPSHOTS_TABLE,
        AD_EVENTS_TABLE,
        "engine_v3_job_runs",
        "engine_v3_ad_account_calibration_daily",
      ],
    ],
  );
  const columnMap = new Map(
    columns.map((row) => [
      `${String(row.table_name)}.${String(row.column_name)}`,
      row,
    ]),
  );
  const missing: string[] = [];
  for (const [table, requiredColumns] of Object.entries(
    AD_DECISION_SCHEMA_REQUIRED_COLUMNS,
  )) {
    for (const column of requiredColumns) {
      const identity = `${table}.${column}`;
      const row = columnMap.get(identity);
      if (!row) {
        missing.push(`${table}.${column}`);
        continue;
      }
      const expected = expectedAdDecisionColumnContract(table, column);
      if (String(row.udt_name) !== expected.udtName) {
        missing.push(`${identity}.type:${expected.udtName}`);
      }
      if ((String(row.is_nullable) === "YES") !== expected.nullable) {
        missing.push(
          `${identity}.${expected.nullable ? "nullable" : "not_null"}`,
        );
      }
      const actualLength =
        row.character_maximum_length === null ||
        row.character_maximum_length === undefined
          ? null
          : Number(row.character_maximum_length);
      if (actualLength !== expected.characterMaximumLength) {
        missing.push(
          `${identity}.length:${expected.characterMaximumLength ?? "none"}`,
        );
      }
    }
  }
  const indexesByName = new Map(
    indexes.map((row) => [String(row.indexname), row]),
  );
  for (const contract of AD_DECISION_REQUIRED_INDEXES) {
    if (!matchesIndexContract(indexesByName.get(contract.name), contract)) {
      missing.push(`${contract.table}.${contract.name}.definition`);
    }
  }
  if (hasCreativeOwnedUniqueIndex(indexes, AD_EVALUATIONS_TABLE)) {
    missing.push(`${AD_EVALUATIONS_TABLE}.creative_identity_unique_present`);
  }
  if (hasCreativeOwnedUniqueIndex(indexes, AD_SNAPSHOTS_TABLE)) {
    missing.push(`${AD_SNAPSHOTS_TABLE}.creative_identity_unique_present`);
  }
  if (hasCreativeOwnedUniqueIndex(indexes, AD_EVENTS_TABLE)) {
    missing.push(`${AD_EVENTS_TABLE}.creative_identity_unique_present`);
  }
  const constraintsByName = new Map(
    constraints.map((row) => [
      `${String(row.table_name)}.${String(row.constraint_name)}`,
      row,
    ]),
  );
  for (const contract of AD_DECISION_REQUIRED_CONSTRAINTS) {
    const row = constraintsByName.get(`${contract.table}.${contract.name}`);
    const definition = normalizeSqlDefinition(row?.definition);
    if (
      !row ||
      String(row.constraint_type) !== contract.type ||
      row.validated !== true ||
      !contract.allOf.every((token) =>
        definition.includes(normalizeSqlDefinition(token)),
      )
    ) {
      missing.push(`${contract.table}.${contract.name}.definition`);
    }
  }
  return {
    ready: missing.length === 0,
    missing: Array.from(new Set(missing)).sort(),
  };
}

export async function assertEvaluationStoreSchemaReady(
  db: DbClient = getDb(),
): Promise<void> {
  const capability = await inspectEvaluationStoreSchemaCapability(db);
  if (!capability.ready) {
    throw new EvaluationStoreSchemaNotReadyError(capability.missing);
  }
}

export const INSERT_AD_EVALUATION_CONTEXT_QUERY = `
WITH inserted AS (
  INSERT INTO engine_v3_ad_decision_evaluation_contexts (
    business_ref_id, business_id, provider_account_ref_id, provider_account_id,
    as_of_date, engine_version, scope_type,
    scope_id, contract_version, context_json, account_profile_json,
    data_health_json, flags_json, context_hash, job_run_id, evaluated_at
  ) VALUES (
    $1::uuid, $2, $3::uuid, $4, $5::date, $6, $7, $8, $9,
    $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::uuid,
    $16::timestamptz
  )
  ON CONFLICT ON CONSTRAINT engine_v3_ad_eval_contexts_run_scope_hash_unique
  DO NOTHING
  RETURNING id
)
SELECT id FROM inserted
UNION ALL
SELECT id
FROM engine_v3_ad_decision_evaluation_contexts
WHERE job_run_id = $15::uuid
  AND business_ref_id = $1::uuid
  AND provider_account_ref_id = $3::uuid
  AND provider_account_id = $4
  AND as_of_date = $5::date
  AND engine_version = $6
  AND scope_type = $7
  AND scope_id = $8
  AND context_hash = $14
LIMIT 1
`;

export const INSERT_AD_DECISION_EVALUATIONS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    context_id uuid,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    ad_id text,
    creative_id text,
    as_of_date date,
    engine_version text,
    scope_type text,
    scope_id text,
    contract_version text,
    creative_input_json jsonb,
    campaign_context_json jsonb,
    prior_hysteresis_json jsonb,
    decision_output_json jsonb,
    raw_label text,
    hysteresis_suppressed boolean,
    input_hash text,
    decision_hash text,
    job_run_id uuid,
    evaluated_at timestamptz
  )
), inserted AS (
  INSERT INTO engine_v3_ad_decision_evaluations (
    context_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
    decision_entity_id, ad_id, creative_id, as_of_date, engine_version,
    scope_type, scope_id, contract_version, creative_input_json,
    campaign_context_json, prior_hysteresis_json, decision_output_json,
    raw_label, hysteresis_suppressed, input_hash, decision_hash, job_run_id,
    evaluated_at
  )
  SELECT
    context_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
    decision_entity_id, ad_id, creative_id, as_of_date, engine_version,
    scope_type, scope_id, contract_version, creative_input_json,
    campaign_context_json, prior_hysteresis_json, decision_output_json,
    raw_label, hysteresis_suppressed, input_hash, decision_hash, job_run_id,
    evaluated_at
  FROM payload
  ON CONFLICT DO NOTHING
  RETURNING
    id,
    provider_account_ref_id,
    provider_account_id,
    decision_entity_id,
    input_hash,
    decision_hash
)
SELECT
  inserted.id,
  inserted.provider_account_ref_id,
  inserted.provider_account_id,
  inserted.decision_entity_id,
  inserted.input_hash::text AS input_hash,
  inserted.decision_hash::text AS decision_hash
FROM inserted
UNION ALL
SELECT
  evaluation.id,
  evaluation.provider_account_ref_id,
  evaluation.provider_account_id,
  evaluation.decision_entity_id,
  evaluation.input_hash::text AS input_hash,
  evaluation.decision_hash::text AS decision_hash
FROM engine_v3_ad_decision_evaluations evaluation
JOIN payload
  ON evaluation.context_id = payload.context_id
 AND evaluation.provider_account_id = payload.provider_account_id
 AND evaluation.provider_account_ref_id = payload.provider_account_ref_id
 AND evaluation.decision_entity_type = payload.decision_entity_type
 AND evaluation.decision_entity_id = payload.decision_entity_id
 AND evaluation.input_hash = payload.input_hash
 AND evaluation.decision_hash = payload.decision_hash
WHERE NOT EXISTS (
  SELECT 1 FROM inserted WHERE inserted.id = evaluation.id
)
`;

export interface PersistAdDecisionEvaluationBatchInput {
  businessId: string;
  businessDisplayId?: string | null;
  asOf: string;
  engineVersion: string;
  scope: DecisionProfileScope;
  jobRunId: string;
  evaluatedAt: string;
  evaluations: AdCanonicalEvaluationProvenance[];
}

export interface StoredAdDecisionEvaluation {
  evaluationId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityId: string;
  inputHash: string;
  decisionHash: string;
}

function jsonObjectField(
  object: CanonicalJsonObject,
  field: string,
): CanonicalJsonObject {
  const value = object[field];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`Canonical context field ${field} must be an object.`);
  }
  return value as CanonicalJsonObject;
}

function canonicalTextField(
  object: CanonicalJsonObject,
  field: string,
): string {
  return nonEmpty(object[field], `canonical ${field}`);
}

function assertCanonicalHash(
  field: string,
  payload: CanonicalJsonObject,
  json: string,
  hash: string,
): void {
  const expectedJson = stableCanonicalJson(payload);
  if (json !== expectedJson) {
    throw new TypeError(`${field} canonical JSON does not match its payload.`);
  }
  if (hash !== canonicalSha256(payload)) {
    throw new TypeError(`${field} hash does not match its canonical payload.`);
  }
}

export function assertAdCanonicalEvaluationProvenance(
  evaluation: AdCanonicalEvaluationProvenance,
): void {
  const identity = normalizeAdDecisionEvaluationIdentity(evaluation.identity);
  if (
    evaluation.identity.decisionEntityId !== identity.decisionEntityId ||
    evaluation.identity.adId !== identity.adId ||
    evaluation.identity.providerAccountRefId !==
      identity.providerAccountRefId ||
    evaluation.identity.providerAccountId !== identity.providerAccountId ||
    evaluation.identity.creativeId !== identity.creativeId
  ) {
    throw new TypeError("Ad evaluation identity must already be normalized.");
  }
  if (evaluation.contractVersion !== AD_DECISION_EVALUATION_CONTRACT_VERSION) {
    throw new TypeError("Unexpected ad evaluation contract version.");
  }
  for (const payload of [
    evaluation.contextPayload,
    evaluation.inputPayload,
    evaluation.decisionPayload,
  ]) {
    if (payload.contractVersion !== AD_DECISION_EVALUATION_CONTRACT_VERSION) {
      throw new TypeError(
        "Canonical payload contract version is not ad-aware.",
      );
    }
  }
  if (
    canonicalTextField(evaluation.contextPayload, "envelopeType") !==
      "context" ||
    canonicalTextField(evaluation.inputPayload, "envelopeType") !== "input" ||
    canonicalTextField(evaluation.decisionPayload, "envelopeType") !==
      "decision"
  ) {
    throw new TypeError("Canonical envelope types are inconsistent.");
  }
  const engineVersion = canonicalTextField(
    evaluation.contextPayload,
    "engineVersion",
  );
  if (
    canonicalTextField(evaluation.inputPayload, "engineVersion") !==
      engineVersion ||
    canonicalTextField(evaluation.decisionPayload, "engineVersion") !==
      engineVersion
  ) {
    throw new TypeError("Canonical envelope engine versions differ.");
  }
  assertCanonicalHash(
    "context",
    evaluation.contextPayload,
    evaluation.contextJson,
    evaluation.contextHash,
  );
  assertCanonicalHash(
    "input",
    evaluation.inputPayload,
    evaluation.inputJson,
    evaluation.inputHash,
  );
  assertCanonicalHash(
    "decision",
    evaluation.decisionPayload,
    evaluation.decisionJson,
    evaluation.decisionHash,
  );
  if (evaluation.inputPayload.contextHash !== evaluation.contextHash) {
    throw new TypeError("Canonical input does not bind the context hash.");
  }
  if (evaluation.decisionPayload.inputHash !== evaluation.inputHash) {
    throw new TypeError("Canonical decision does not bind the input hash.");
  }
  const payloadIdentity = jsonObjectField(
    evaluation.inputPayload,
    "decisionIdentity",
  );
  if (
    payloadIdentity.decisionEntityType !== "ad" ||
    payloadIdentity.decisionEntityId !== identity.decisionEntityId ||
    payloadIdentity.adId !== identity.adId ||
    payloadIdentity.providerAccountRefId !== identity.providerAccountRefId ||
    payloadIdentity.providerAccountId !== identity.providerAccountId ||
    payloadIdentity.creativeGroupingId !== identity.creativeId
  ) {
    throw new TypeError(
      "Canonical input identity differs from the store identity.",
    );
  }
  if (
    evaluation.decisionPayload.rawLabel !== evaluation.rawLabel ||
    evaluation.decisionPayload.publishedLabel !== evaluation.publishedLabel ||
    evaluation.decisionPayload.hysteresisSuppressed !==
      evaluation.hysteresisSuppressed
  ) {
    throw new TypeError(
      "Canonical decision label provenance differs from columns.",
    );
  }
  const decision = jsonObjectField(evaluation.decisionPayload, "decision");
  if (decision.label !== evaluation.publishedLabel) {
    throw new TypeError(
      "Published label differs from canonical decision output.",
    );
  }
}

function validateBatch(input: PersistAdDecisionEvaluationBatchInput) {
  const businessId = nonEmpty(input.businessId, "businessId");
  nonEmpty(input.asOf, "asOf");
  nonEmpty(input.engineVersion, "engineVersion");
  nonEmpty(input.scope.type, "scope.type");
  nonEmpty(input.scope.id, "scope.id");
  nonEmpty(input.jobRunId, "jobRunId");
  nonEmpty(input.evaluatedAt, "evaluatedAt");
  if (input.evaluations.length === 0) {
    throw new TypeError("At least one ad evaluation is required.");
  }
  const first = input.evaluations[0]!;
  const firstIdentity = normalizeAdDecisionEvaluationIdentity(first.identity);
  const accountProfile = jsonObjectField(
    first.contextPayload,
    "accountProfile",
  );
  const canonicalScope = jsonObjectField(first.contextPayload, "scope");
  if (canonicalTextField(accountProfile, "businessId") !== businessId) {
    throw new TypeError("Canonical account profile and batch tenant differ.");
  }
  if (
    canonicalTextField(canonicalScope, "type") !== input.scope.type ||
    canonicalTextField(canonicalScope, "id") !== input.scope.id
  ) {
    throw new TypeError("Canonical context and batch scopes differ.");
  }
  if (
    input.scope.type === "account" &&
    input.scope.id !== firstIdentity.providerAccountId
  ) {
    throw new TypeError(
      "Native account scope must equal the physical provider account.",
    );
  }
  const identities = new Set<string>();
  for (const evaluation of input.evaluations) {
    assertAdCanonicalEvaluationProvenance(evaluation);
    const identityKey = adDecisionEvaluationIdentityKey(evaluation.identity);
    if (
      evaluation.identity.providerAccountRefId !==
        firstIdentity.providerAccountRefId ||
      evaluation.identity.providerAccountId !== firstIdentity.providerAccountId
    ) {
      throw new TypeError(
        "All evaluations in one native context must share one provider account binding.",
      );
    }
    if (identities.has(identityKey)) {
      throw new TypeError(`Duplicate ad evaluation identity: ${identityKey}`);
    }
    identities.add(identityKey);
    if (
      evaluation.contractVersion !== AD_DECISION_EVALUATION_CONTRACT_VERSION
    ) {
      throw new TypeError("Unexpected ad evaluation contract version.");
    }
    if (
      evaluation.contextHash !== first.contextHash ||
      evaluation.contextJson !== first.contextJson
    ) {
      throw new TypeError(
        "All evaluations must share one exact job/scope context.",
      );
    }
    if (evaluation.contextPayload.engineVersion !== input.engineVersion) {
      throw new TypeError("Evaluation and batch engine versions differ.");
    }
    const creativeInput = jsonObjectField(
      evaluation.inputPayload,
      "creativeInput",
    );
    if (canonicalTextField(creativeInput, "businessId") !== businessId) {
      throw new TypeError("Canonical ad input and batch tenant differ.");
    }
  }
  return first;
}

/**
 * Must be called with the job's transaction-bound DbClient. The function does
 * not catch write errors, so context/evaluation writes roll back atomically.
 * Missing or creative-owned native schemas are rejected before the first INSERT.
 */
export async function persistAdDecisionEvaluations(
  input: PersistAdDecisionEvaluationBatchInput,
  db: DbClient = getDb(),
): Promise<Map<string, StoredAdDecisionEvaluation>> {
  const first = validateBatch(input);
  await assertEvaluationStoreSchemaReady(db);

  const contextPayload = first.contextPayload;
  const contextRows = await db.query<IdRow>(
    INSERT_AD_EVALUATION_CONTEXT_QUERY,
    [
      input.businessId,
      input.businessDisplayId ?? input.businessId,
      first.identity.providerAccountRefId,
      first.identity.providerAccountId,
      input.asOf,
      input.engineVersion,
      input.scope.type,
      input.scope.id,
      AD_DECISION_EVALUATION_CONTRACT_VERSION,
      first.contextJson,
      stableCanonicalJson(jsonObjectField(contextPayload, "accountProfile")),
      stableCanonicalJson(jsonObjectField(contextPayload, "dataHealth")),
      stableCanonicalJson(jsonObjectField(contextPayload, "flags")),
      first.contextHash,
      input.jobRunId,
      input.evaluatedAt,
    ],
  );
  const contextId = nonEmpty(contextRows[0]?.id, "contextId");
  const rows = input.evaluations.map((evaluation) => ({
    context_id: contextId,
    business_ref_id: input.businessId,
    business_id: input.businessDisplayId ?? input.businessId,
    provider_account_ref_id: evaluation.identity.providerAccountRefId,
    provider_account_id: evaluation.identity.providerAccountId,
    decision_entity_type: evaluation.identity.decisionEntityType,
    decision_entity_id: evaluation.identity.decisionEntityId,
    ad_id: evaluation.identity.adId,
    creative_id: evaluation.identity.creativeId,
    as_of_date: input.asOf,
    engine_version: input.engineVersion,
    scope_type: input.scope.type,
    scope_id: input.scope.id,
    contract_version: AD_DECISION_EVALUATION_CONTRACT_VERSION,
    creative_input_json: evaluation.inputPayload.creativeInput,
    campaign_context_json: evaluation.inputPayload.campaignContext,
    prior_hysteresis_json: evaluation.inputPayload.priorHysteresis,
    decision_output_json: evaluation.decisionPayload.decision,
    raw_label: evaluation.rawLabel,
    hysteresis_suppressed: evaluation.hysteresisSuppressed,
    input_hash: evaluation.inputHash,
    decision_hash: evaluation.decisionHash,
    job_run_id: input.jobRunId,
    evaluated_at: input.evaluatedAt,
  }));
  const storedRows: StoredEvaluationRow[] = [];
  for (const batch of chunkDecisionRows(rows)) {
    let storedBatch = await db.query<StoredEvaluationRow>(
      INSERT_AD_DECISION_EVALUATIONS_QUERY,
      [JSON.stringify(batch)],
    );
    if (storedBatch.length !== batch.length) {
      // Preserve one compatibility retry for direct READ COMMITTED callers.
      // The native job's REPEATABLE READ snapshot and advisory lock make this
      // neither its concurrency-control path nor a whole-transaction retry.
      storedBatch = await db.query<StoredEvaluationRow>(
        INSERT_AD_DECISION_EVALUATIONS_QUERY,
        [JSON.stringify(batch)],
      );
    }
    storedRows.push(...storedBatch);
  }
  const stored = new Map<string, StoredAdDecisionEvaluation>();
  for (const row of storedRows) {
    const providerAccountId = nonEmpty(
      row.provider_account_id,
      "stored providerAccountId",
    );
    const providerAccountRefId = nonEmpty(
      row.provider_account_ref_id,
      "stored providerAccountRefId",
    );
    const decisionEntityId = nonEmpty(
      row.decision_entity_id,
      "stored decisionEntityId",
    );
    stored.set(
      `${providerAccountRefId}:${providerAccountId}:ad:${decisionEntityId}`,
      {
      evaluationId: nonEmpty(row.id, "stored evaluationId"),
      providerAccountRefId,
      providerAccountId,
      decisionEntityId,
      inputHash: nonEmpty(row.input_hash, "stored inputHash"),
      decisionHash: nonEmpty(row.decision_hash, "stored decisionHash"),
      },
    );
  }
  if (stored.size !== rows.length) {
    throw new Error(
      `Ad evaluation linkage incomplete: expected ${rows.length}, resolved ${stored.size}.`,
    );
  }
  return stored;
}
