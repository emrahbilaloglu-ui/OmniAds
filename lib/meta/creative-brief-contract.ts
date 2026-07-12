import { createHash } from "node:crypto";

export const META_CREATIVE_BRIEF_CONTRACT_VERSION =
  "meta-creative-brief.v1" as const;

export const META_CREATIVE_BRIEF_STATUSES = ["draft", "reviewed"] as const;

export type MetaCreativeBriefStatus =
  (typeof META_CREATIVE_BRIEF_STATUSES)[number];

export interface MetaCreativeBriefCapability {
  status: "ready" | "migration_required";
  canRead: boolean;
  canWrite: boolean;
  missingTables: string[];
  checkedAt: string;
}

export interface MetaCreativeBriefContent {
  keep: string;
  change: string;
  next: string;
}

export interface MetaCreativeBriefSourceBadge {
  type: string;
  label: string | null;
  severity: string | null;
}

export interface MetaCreativeBriefSourceDecision {
  decisionId: string;
  snapshotId: string;
  creativeId: string;
  engineVersion: string;
  snapshotAsOf: string;
  scopeType: string;
  scopeId: string;
  publishedLabel: string;
  rawLabel: string | null;
  reason: string;
  badges: MetaCreativeBriefSourceBadge[];
  trigger: string;
}

export interface MetaCreativeBrief {
  contractVersion: typeof META_CREATIVE_BRIEF_CONTRACT_VERSION;
  id: string;
  businessId: string;
  providerAccountId: string;
  sourceDecision: MetaCreativeBriefSourceDecision;
  content: MetaCreativeBriefContent;
  status: MetaCreativeBriefStatus;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface CreateMetaCreativeBriefRequest {
  businessId: string;
  providerAccountId: string;
  idempotencyKey: string;
  sourceDecision: {
    snapshotId: string;
    trigger: string;
  };
  content: MetaCreativeBriefContent;
  status: MetaCreativeBriefStatus;
}

export interface PatchMetaCreativeBriefRequest {
  expectedVersion: number;
  content: Partial<MetaCreativeBriefContent>;
  status?: MetaCreativeBriefStatus;
}

export class MetaCreativeBriefValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MetaCreativeBriefValidationError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FIELD_LIMITS = {
  businessId: 128,
  providerAccountId: 255,
  idempotencyKey: 200,
  trigger: 255,
  content: 5_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MetaCreativeBriefValidationError(
      `missing_${field}`,
      `${field} is required.`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new MetaCreativeBriefValidationError(
      `${field}_too_long`,
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
  return normalized;
}

function contentString(value: unknown, field: keyof MetaCreativeBriefContent) {
  if (typeof value !== "string") {
    throw new MetaCreativeBriefValidationError(
      `invalid_${field}`,
      `content.${field} must be a string.`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > FIELD_LIMITS.content) {
    throw new MetaCreativeBriefValidationError(
      `${field}_too_long`,
      `content.${field} must be ${FIELD_LIMITS.content} characters or fewer.`,
    );
  }
  return normalized;
}

function parseStatus(
  value: unknown,
  fallback?: MetaCreativeBriefStatus,
): MetaCreativeBriefStatus {
  if (value === undefined && fallback) return fallback;
  if (value === "draft" || value === "reviewed") return value;
  throw new MetaCreativeBriefValidationError(
    "invalid_status",
    "status must be draft or reviewed.",
  );
}

export function parseCreateMetaCreativeBriefRequest(
  value: unknown,
): CreateMetaCreativeBriefRequest {
  if (!isRecord(value)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_body",
      "A JSON request body is required.",
    );
  }
  if (!isRecord(value.sourceDecision)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_source_decision",
      "sourceDecision is required.",
    );
  }
  if (!isRecord(value.content)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_content",
      "content is required.",
    );
  }

  const snapshotId = requiredString(
    value.sourceDecision.snapshotId,
    "source_snapshot_id",
    36,
  );
  if (!UUID_PATTERN.test(snapshotId)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_source_snapshot_id",
      "sourceDecision.snapshotId must be a UUID.",
    );
  }

  return {
    businessId: requiredString(
      value.businessId,
      "business_id",
      FIELD_LIMITS.businessId,
    ),
    providerAccountId: requiredString(
      value.providerAccountId,
      "provider_account_id",
      FIELD_LIMITS.providerAccountId,
    ),
    idempotencyKey: requiredString(
      value.idempotencyKey,
      "idempotency_key",
      FIELD_LIMITS.idempotencyKey,
    ),
    sourceDecision: {
      snapshotId: snapshotId.toLowerCase(),
      trigger: requiredString(
        value.sourceDecision.trigger,
        "source_trigger",
        FIELD_LIMITS.trigger,
      ),
    },
    content: {
      keep: contentString(value.content.keep, "keep"),
      change: contentString(value.content.change, "change"),
      next: contentString(value.content.next, "next"),
    },
    status: parseStatus(value.status, "draft"),
  };
}

export function parsePatchMetaCreativeBriefRequest(
  value: unknown,
): PatchMetaCreativeBriefRequest {
  if (!isRecord(value)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_body",
      "A JSON request body is required.",
    );
  }
  if ("sourceDecision" in value) {
    throw new MetaCreativeBriefValidationError(
      "source_decision_immutable",
      "sourceDecision is immutable after brief creation.",
    );
  }

  const expectedVersion = Number(value.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new MetaCreativeBriefValidationError(
      "invalid_expected_version",
      "expectedVersion must be a positive integer.",
    );
  }

  const content: Partial<MetaCreativeBriefContent> = {};
  if (value.content !== undefined) {
    if (!isRecord(value.content)) {
      throw new MetaCreativeBriefValidationError(
        "invalid_content",
        "content must be an object.",
      );
    }
    for (const field of ["keep", "change", "next"] as const) {
      if (field in value.content) {
        content[field] = contentString(value.content[field], field);
      }
    }
  }

  const hasStatus = value.status !== undefined;
  const status = hasStatus ? parseStatus(value.status) : undefined;
  if (Object.keys(content).length === 0 && !hasStatus) {
    throw new MetaCreativeBriefValidationError(
      "empty_patch",
      "PATCH must change content or status.",
    );
  }

  return { expectedVersion, content, status };
}

export function buildMetaCreativeDecisionId(input: {
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  scopeType: string;
  scopeId: string;
}) {
  const digest = createHash("sha256")
    .update(
      [
        input.businessId,
        input.providerAccountId,
        "creative",
        input.creativeId,
        input.scopeType,
        input.scopeId,
      ].join("\u001f"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mdd_${digest}`;
}

export function buildMetaCreativeBriefCreateRequestHash(
  input: CreateMetaCreativeBriefRequest,
) {
  const canonical = JSON.stringify({
    contractVersion: META_CREATIVE_BRIEF_CONTRACT_VERSION,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    sourceDecision: input.sourceDecision,
    content: input.content,
    status: input.status,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
