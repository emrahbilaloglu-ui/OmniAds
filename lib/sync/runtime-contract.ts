import { createHash } from "node:crypto";
import os from "node:os";
import { getCurrentRuntimeBuildId } from "@/lib/build-runtime";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { logStartupError, logStartupEvent } from "@/lib/startup-diagnostics";

export type RuntimeContractService = "web" | "worker";
// "staged" is a worker that registered so a release could be inspected and is
// admitted to no lane. It is deliberately NOT "healthy": the deploy gate reads
// this to mean "the worker is doing the work", and a staged process is not.
/**
 * Binary, deliberately. The only reader collapses anything that is not 'healthy'
 * into 'invalid', and both consumers branch on `=== "healthy"`. A third value was
 * declared here once without a reader or a CHECK constraint to match, so every
 * write of it violated the constraint and was swallowed.
 */
export type RuntimeContractHealthState = "healthy" | "invalid";
export type SyncGateMode = "measure_only" | "warn_only" | "block";
export type RuntimeContractIssueSeverity = "error" | "warning";

export interface RuntimeContractIssue {
  code: string;
  severity: RuntimeContractIssueSeverity;
  message: string;
}

export interface RuntimeContractFingerprintTarget {
  host: string | null;
  port: number | null;
  database: string | null;
  searchPath: string | null;
  sslMode: string | null;
}

export interface RuntimeContractConfigSummary {
  metaAuthoritativeFinalizationV2: boolean | null;
  metaRetentionExecutionEnabled: boolean | null;
  releaseCanaryBusinesses: string[];
  releaseCanaryConfigured: boolean;
  releaseCanaryHasMandatoryCanary: boolean;
  deployGateMode: SyncGateMode;
  releaseGateMode: SyncGateMode;
  /**
   * Whether this process is the STAGED worker: started for inspection during a
   * cutover, admitted to no lane, holding no lease and doing no work.
   *
   * It is recorded because nothing else in the runtime row could tell the two
   * apart. `service`, `runtime_role` and `build_id` are identical by design —
   * deploy-disabled deliberately starts the release's own worker — `health_state`
   * is binary and genuinely 'healthy' for a staged process (it started,
   * validated and answers), and `provider_scopes` is a static per-service
   * constant, not the lane admission set. So a staged worker's row was
   * indistinguishable from the active production worker's, and it satisfied the
   * release gate's worker-health term as if it were doing the work.
   *
   * Deliberately NOT part of `configFingerprint`: that fingerprint is compared
   * between the web and worker rows, and a term only the worker can carry would
   * make them disagree during every staged deploy — refusing for a fingerprint
   * mismatch instead of for the reason that actually applies.
   */
  workerStagingIdle: boolean;
}

export interface RuntimeContract {
  contractVersion: 1;
  service: RuntimeContractService;
  runtimeRole: RuntimeContractService;
  instanceId: string;
  buildId: string;
  nodeEnv: string;
  providerScopes: string[];
  dbTarget: RuntimeContractFingerprintTarget;
  dbFingerprint: string;
  configFingerprint: string;
  config: RuntimeContractConfigSummary;
  validation: {
    pass: boolean;
    issues: RuntimeContractIssue[];
  };
}

export interface RuntimeRegistryInstance {
  instanceId: string;
  service: RuntimeContractService;
  runtimeRole: RuntimeContractService;
  buildId: string;
  providerScopes: string[];
  dbFingerprint: string;
  configFingerprint: string;
  healthState: RuntimeContractHealthState;
  startedAt: string | null;
  lastSeenAt: string | null;
  contract: RuntimeContract | null;
  fresh: boolean;
  /**
   * `true` staged, `false` proven active, `null` the row does not say.
   *
   * `null` is not "active": a row that cannot state which it is cannot be used
   * to prove the active worker is up, so the gates treat it as unproven and
   * refuse. Only rows written before this field existed can be `null`, and a
   * gate is always evaluated against rows written by the build it is gating.
   */
  stagingIdle: boolean | null;
}

export interface RuntimeRegistryStatus {
  sampledAt: string;
  buildId: string;
  freshnessWindowMinutes: number;
  contractValid: boolean;
  serviceHealth: {
    web: RuntimeRegistryInstance | null;
    worker: RuntimeRegistryInstance | null;
  };
  webPresent: boolean;
  workerPresent: boolean;
  /**
   * The selected worker row is a proven ACTIVE worker — not staged, and not a
   * row that declines to say. This is what "the worker is up" has to mean for a
   * gate: deploy-disabled starts the release's own worker with every lane off,
   * so "a fresh healthy worker row exists on this build" is also true of a
   * process admitted to no work at all.
   */
  workerActive: boolean;
  dbFingerprintMatch: boolean;
  configFingerprintMatch: boolean;
  issues: string[];
}

const CONTRACT_VERSION = 1 as const;
const DEFAULT_DEPLOY_GATE_MODE: SyncGateMode = "measure_only";
const DEFAULT_RELEASE_GATE_MODE: SyncGateMode = "measure_only";
const MANDATORY_META_RELEASE_CANARIES = ["172d0ab8-495b-4679-a4c6-ffa404c389d3"];

function nowIso() {
  return new Date().toISOString();
}

function isWorkerRuntime(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.SYNC_WORKER_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function resolveRuntimeRole(env: NodeJS.ProcessEnv = process.env): RuntimeContractService {
  return isWorkerRuntime(env) ? "worker" : "web";
}

function normalizeList(raw: string | null | undefined) {
  return Array.from(
    new Set(
      String(raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function readStrictBooleanEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  const raw = env[name]?.trim().toLowerCase() ?? null;
  if (raw == null || raw.length === 0) {
    return {
      explicit: false,
      valid: false,
      raw: null,
      value: null,
    };
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return {
      explicit: true,
      valid: true,
      raw,
      value: true,
    };
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return {
      explicit: true,
      valid: true,
      raw,
      value: false,
    };
  }
  return {
    explicit: true,
    valid: false,
    raw,
    value: null,
  };
}

export function readSyncGateMode(
  name: "SYNC_DEPLOY_GATE_MODE" | "SYNC_RELEASE_GATE_MODE",
  env: NodeJS.ProcessEnv = process.env,
): SyncGateMode {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === "warn_only") return "warn_only";
  if (raw === "block") return "block";
  if (raw === "measure_only") return "measure_only";
  return name === "SYNC_DEPLOY_GATE_MODE" ? DEFAULT_DEPLOY_GATE_MODE : DEFAULT_RELEASE_GATE_MODE;
}

export function getSyncReleaseCanaryBusinessIds(env: NodeJS.ProcessEnv = process.env) {
  return normalizeList(env.SYNC_RELEASE_CANARY_BUSINESSES);
}

function readProviderScopes(service: RuntimeContractService) {
  return service === "worker"
    ? ["google_ads", "meta", "shopify"]
    : ["ga4", "google_ads", "meta", "search_console", "shopify"];
}

function parseDatabaseTarget(env: NodeJS.ProcessEnv = process.env): RuntimeContractFingerprintTarget {
  const raw = env.DATABASE_URL?.trim() ?? "";
  if (!raw) {
    return {
      host: null,
      port: null,
      database: null,
      searchPath: null,
      sslMode: null,
    };
  }

  try {
    const parsed = new URL(raw);
    const database = parsed.pathname.replace(/^\//, "") || null;
    const options = parsed.searchParams.get("options");
    const searchPath =
      parsed.searchParams.get("search_path") ??
      (() => {
        if (!options) return null;
        const match = options.match(/search_path=([^ ]+)/i);
        return match?.[1] ?? null;
      })();
    return {
      host: parsed.hostname || null,
      port: parsed.port ? Number(parsed.port) : 5432,
      database,
      searchPath,
      sslMode: parsed.searchParams.get("sslmode"),
    };
  } catch {
    return {
      host: null,
      port: null,
      database: null,
      searchPath: null,
      sslMode: null,
    };
  }
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildValidationIssues(input: {
  env: NodeJS.ProcessEnv;
  service: RuntimeContractService;
  config: RuntimeContractConfigSummary;
  dbTarget: RuntimeContractFingerprintTarget;
  finalizationFlag: ReturnType<typeof readStrictBooleanEnv>;
  retentionFlag: ReturnType<typeof readStrictBooleanEnv>;
}) {
  const nodeEnv = input.env.NODE_ENV ?? "unknown";
  const issues: RuntimeContractIssue[] = [];
  const production = nodeEnv === "production";

  if (!input.env.DATABASE_URL?.trim()) {
    issues.push({
      code: "database_url_missing",
      severity: "error",
      message: "DATABASE_URL is required for sync runtime contract evaluation.",
    });
  }

  if (!input.dbTarget.host || !input.dbTarget.database) {
    issues.push({
      code: "database_target_unresolved",
      severity: "error",
      message: "DATABASE_URL could not be resolved into a stable host/database fingerprint.",
    });
  }

  if (production && !input.finalizationFlag.explicit) {
    issues.push({
      code: "meta_finalization_implicit",
      severity: "error",
      message: "META_AUTHORITATIVE_FINALIZATION_V2 must be explicit in production.",
    });
  } else if (production && !input.finalizationFlag.valid) {
    issues.push({
      code: "meta_finalization_invalid",
      severity: "error",
      message: "META_AUTHORITATIVE_FINALIZATION_V2 must be a strict boolean in production.",
    });
  }

  if (production && !input.retentionFlag.explicit) {
    issues.push({
      code: "meta_retention_implicit",
      severity: "error",
      message: "META_RETENTION_EXECUTION_ENABLED must be explicit in production.",
    });
  } else if (production && !input.retentionFlag.valid) {
    issues.push({
      code: "meta_retention_invalid",
      severity: "error",
      message: "META_RETENTION_EXECUTION_ENABLED must be a strict boolean in production.",
    });
  }

  if (production && !input.env.SYNC_DEPLOY_GATE_MODE?.trim()) {
    issues.push({
      code: "deploy_gate_mode_implicit",
      severity: "error",
      message: "SYNC_DEPLOY_GATE_MODE must be explicit in production.",
    });
  }

  if (production && !input.env.SYNC_RELEASE_GATE_MODE?.trim()) {
    issues.push({
      code: "release_gate_mode_implicit",
      severity: "error",
      message: "SYNC_RELEASE_GATE_MODE must be explicit in production.",
    });
  }

  if (!input.config.releaseCanaryConfigured) {
    issues.push({
      code: "release_canary_unconfigured",
      severity: "warning",
      message: "SYNC_RELEASE_CANARY_BUSINESSES is not configured; release gate will be misconfigured.",
    });
  } else if (!input.config.releaseCanaryHasMandatoryCanary) {
    issues.push({
      code: "release_canary_missing_mandatory_business",
      severity: "warning",
      message: "SYNC_RELEASE_CANARY_BUSINESSES must include TheSwaf during Meta stabilization.",
    });
  }

  if (input.service === "worker" && !isWorkerRuntime(input.env)) {
    issues.push({
      code: "worker_mode_missing",
      severity: "error",
      message: "Worker runtime contract requires SYNC_WORKER_MODE=1.",
    });
  }

  if (input.service === "web" && isWorkerRuntime(input.env)) {
    issues.push({
      code: "web_running_in_worker_mode",
      severity: "error",
      message: "Web runtime contract cannot run with SYNC_WORKER_MODE enabled.",
    });
  }

  return issues;
}

export function buildRuntimeContract(input?: {
  env?: NodeJS.ProcessEnv;
  service?: RuntimeContractService;
  instanceId?: string;
}) : RuntimeContract {
  const env = input?.env ?? process.env;
  const service = input?.service ?? resolveRuntimeRole(env);
  const buildId = getCurrentRuntimeBuildId();
  const releaseCanaryBusinesses = getSyncReleaseCanaryBusinessIds(env);
  const finalizationFlag = readStrictBooleanEnv("META_AUTHORITATIVE_FINALIZATION_V2", env);
  const retentionFlag = readStrictBooleanEnv("META_RETENTION_EXECUTION_ENABLED", env);
  const dbTarget = parseDatabaseTarget(env);
  const config: RuntimeContractConfigSummary = {
    metaAuthoritativeFinalizationV2: finalizationFlag.value,
    metaRetentionExecutionEnabled: retentionFlag.value,
    releaseCanaryBusinesses,
    releaseCanaryConfigured: releaseCanaryBusinesses.length > 0,
    releaseCanaryHasMandatoryCanary: MANDATORY_META_RELEASE_CANARIES.every((businessId) =>
      releaseCanaryBusinesses.includes(businessId),
    ),
    deployGateMode: readSyncGateMode("SYNC_DEPLOY_GATE_MODE", env),
    releaseGateMode: readSyncGateMode("SYNC_RELEASE_GATE_MODE", env),
    // Same accepted spellings as the worker entrypoint's own gate, so the row
    // cannot say "not staged" about a process that started staged.
    workerStagingIdle:
      service === "worker" &&
      ["1", "true", "yes", "enabled"].includes(
        env.SYNC_WORKER_STAGING_IDLE?.trim().toLowerCase() ?? "",
      ),
  };
  const issues = buildValidationIssues({
    env,
    service,
    config,
    dbTarget,
    finalizationFlag,
    retentionFlag,
  });
  const configFingerprint = fingerprint({
    contractVersion: CONTRACT_VERSION,
    metaAuthoritativeFinalizationV2: config.metaAuthoritativeFinalizationV2,
    metaRetentionExecutionEnabled: config.metaRetentionExecutionEnabled,
    releaseCanaryBusinesses,
    deployGateMode: config.deployGateMode,
    releaseGateMode: config.releaseGateMode,
  });

  return {
    contractVersion: CONTRACT_VERSION,
    service,
    runtimeRole: service,
    instanceId:
      input?.instanceId?.trim() ||
      `${service}:${os.hostname()}:${process.pid}`,
    buildId,
    nodeEnv: env.NODE_ENV ?? "unknown",
    providerScopes: readProviderScopes(service),
    dbTarget,
    dbFingerprint: fingerprint({
      host: dbTarget.host,
      port: dbTarget.port,
      database: dbTarget.database,
      searchPath: dbTarget.searchPath,
      sslMode: dbTarget.sslMode,
    }),
    configFingerprint,
    config,
    validation: {
      pass: !issues.some((issue) => issue.severity === "error"),
      issues,
    },
  };
}

let startupValidationLogged = false;

export function assertRuntimeContractStartup(input?: {
  env?: NodeJS.ProcessEnv;
  service?: RuntimeContractService;
}) {
  const contract = buildRuntimeContract(input);
  if (!startupValidationLogged) {
    startupValidationLogged = true;
    const payload = {
      service: contract.service,
      buildId: contract.buildId,
      dbFingerprint: contract.dbFingerprint,
      configFingerprint: contract.configFingerprint,
      validationPass: contract.validation.pass,
      issueCodes: contract.validation.issues.map((issue) => issue.code),
    };
    if (contract.validation.pass) {
      logStartupEvent("runtime_contract_validated", payload);
    } else {
      logStartupError("runtime_contract_invalid", new Error("Runtime contract is invalid."), payload);
    }
  }
  if (!contract.validation.pass && contract.nodeEnv === "production") {
    const issues = contract.validation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .join(" | ");
    throw new Error(`Runtime contract invalid for ${contract.service}: ${issues}`);
  }
  return contract;
}

async function assertRuntimeContractTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: ["sync_runtime_instances"],
    context,
  });
}

export async function upsertRuntimeContractInstance(input?: {
  contract?: RuntimeContract;
  service?: RuntimeContractService;
  instanceId?: string;
  healthState?: RuntimeContractHealthState;
}) {
  const contract =
    input?.contract ??
    buildRuntimeContract({
      service: input?.service,
      instanceId: input?.instanceId,
    });
  await assertRuntimeContractTablesReady("runtime_contract:upsert_instance");
  const sql = getDb();
  await sql`
    INSERT INTO sync_runtime_instances (
      instance_id,
      service,
      runtime_role,
      build_id,
      db_fingerprint,
      config_fingerprint,
      provider_scopes,
      health_state,
      contract_json,
      started_at,
      last_seen_at,
      updated_at
    )
    VALUES (
      ${contract.instanceId},
      ${contract.service},
      ${contract.runtimeRole},
      ${contract.buildId},
      ${contract.dbFingerprint},
      ${contract.configFingerprint},
      ${contract.providerScopes}::text[],
      ${input?.healthState ?? (contract.validation.pass ? "healthy" : "invalid")},
      ${JSON.stringify(contract)}::jsonb,
      now(),
      now(),
      now()
    )
    ON CONFLICT (instance_id) DO UPDATE SET
      service = EXCLUDED.service,
      runtime_role = EXCLUDED.runtime_role,
      build_id = EXCLUDED.build_id,
      db_fingerprint = EXCLUDED.db_fingerprint,
      config_fingerprint = EXCLUDED.config_fingerprint,
      provider_scopes = EXCLUDED.provider_scopes,
      health_state = EXCLUDED.health_state,
      contract_json = EXCLUDED.contract_json,
      last_seen_at = now(),
      updated_at = now()
  `;
  return contract;
}

function normalizeRuntimeContract(value: unknown): RuntimeContract | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as RuntimeContract;
  return candidate.contractVersion === CONTRACT_VERSION ? candidate : null;
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export async function getRuntimeRegistryStatus(input?: {
  buildId?: string;
  freshnessWindowMinutes?: number;
}) : Promise<RuntimeRegistryStatus> {
  await assertRuntimeContractTablesReady("runtime_contract:get_registry_status");
  const sql = getDb();
  const buildId = input?.buildId ?? getCurrentRuntimeBuildId();
  const freshnessWindowMinutes = Math.max(1, input?.freshnessWindowMinutes ?? 10);
  const rows = await sql`
    WITH ranked AS (
      SELECT
        instance_id,
        service,
        runtime_role,
        build_id,
        provider_scopes,
        db_fingerprint,
        config_fingerprint,
        health_state,
        contract_json,
        started_at,
        last_seen_at,
        -- One row per service, and a STAGED row must not mask an active one.
        --
        -- Ordering by recency alone made the newest row win, which during a
        -- cutover is the staged worker: it is started after the outgoing worker
        -- stopped, on the same build, with the same service and role. An active
        -- worker whose row was a few seconds older simply disappeared from the
        -- gate's view. Proven-active rows are therefore preferred over staged and
        -- over rows that do not say, and recency decides only within a class.
        ROW_NUMBER() OVER (
          PARTITION BY service
        -- COALESCE, not a bare comparison: a row whose contract predates this
        -- field yields NULL, and NULL sorts FIRST under DESC in PostgreSQL — the
        -- unknown row would have been preferred over the proven one.
          ORDER BY
            COALESCE((contract_json -> 'config' ->> 'workerStagingIdle') = 'false', false) DESC,
            last_seen_at DESC,
            updated_at DESC
        ) AS service_rank
      FROM sync_runtime_instances
      WHERE build_id = ${buildId}
    )
    SELECT
      instance_id,
      service,
      runtime_role,
      build_id,
      provider_scopes,
      db_fingerprint,
      config_fingerprint,
      health_state,
      contract_json,
      started_at,
      last_seen_at
    FROM ranked
    WHERE service_rank = 1
  ` as Array<Record<string, unknown>>;

  const nowMs = Date.now();
  const freshnessWindowMs = freshnessWindowMinutes * 60_000;
  const normalizedRows = rows.reduce<{
    web: RuntimeRegistryInstance | null;
    worker: RuntimeRegistryInstance | null;
  }>(
    (accumulator, row) => {
      const service = String(row.service) === "worker" ? "worker" : "web";
      const lastSeenAt = normalizeTimestamp(row.last_seen_at);
      const fresh =
        lastSeenAt != null &&
        nowMs - new Date(lastSeenAt).getTime() <= freshnessWindowMs;
      const contract = normalizeRuntimeContract(row.contract_json);
      // A row written before this field existed carries no answer, and an absent
      // answer is not "active" — the guard is a typeof check rather than a
      // truthiness one so that `false` is read as the proof it is.
      const declaredStagingIdle = contract?.config?.workerStagingIdle;
      accumulator[service] = {
        instanceId: String(row.instance_id),
        service,
        runtimeRole: String(row.runtime_role) === "worker" ? "worker" : "web",
        buildId: String(row.build_id),
        providerScopes: Array.isArray(row.provider_scopes)
          ? row.provider_scopes.map((entry) => String(entry))
          : [],
        dbFingerprint: String(row.db_fingerprint ?? ""),
        configFingerprint: String(row.config_fingerprint ?? ""),
        healthState:
          String(row.health_state) === "healthy" ? "healthy" : "invalid",
        startedAt: normalizeTimestamp(row.started_at),
        lastSeenAt,
        contract,
        fresh,
        stagingIdle: typeof declaredStagingIdle === "boolean" ? declaredStagingIdle : null,
      } satisfies RuntimeRegistryInstance;
      return accumulator;
    },
    {
      web: null,
      worker: null,
    },
  );

  const issues: string[] = [];
  if (!normalizedRows.web?.fresh) {
    issues.push("Fresh web runtime contract instance was not observed for the current build.");
  }
  if (!normalizedRows.worker?.fresh) {
    issues.push("Fresh worker runtime contract instance was not observed for the current build.");
  }
  if (normalizedRows.web && normalizedRows.web.healthState !== "healthy") {
    issues.push("Web runtime contract is invalid.");
  }
  if (normalizedRows.worker && normalizedRows.worker.healthState !== "healthy") {
    issues.push("Worker runtime contract is invalid.");
  }
  // Named separately from "not observed" and from "invalid", because it is
  // neither: the process is up and its contract is sound, it is simply not the
  // worker doing the work. A gate that reported this as healthy would be
  // reporting a staged deploy as a serving release.
  if (normalizedRows.worker?.stagingIdle === true) {
    issues.push(
      "Worker runtime instance is the STAGED worker for this build: it is admitted to no lane and does no work.",
    );
  }
  if (normalizedRows.worker && normalizedRows.worker.stagingIdle == null) {
    issues.push(
      "Worker runtime instance does not state whether it is staged; it cannot be accepted as the active worker.",
    );
  }

  const dbFingerprintMatch =
    Boolean(normalizedRows.web?.dbFingerprint) &&
    normalizedRows.web?.dbFingerprint === normalizedRows.worker?.dbFingerprint;
  const configFingerprintMatch =
    Boolean(normalizedRows.web?.configFingerprint) &&
    normalizedRows.web?.configFingerprint === normalizedRows.worker?.configFingerprint;

  if (normalizedRows.web && normalizedRows.worker && !dbFingerprintMatch) {
    issues.push("Web and worker DB fingerprints do not match.");
  }
  if (normalizedRows.web && normalizedRows.worker && !configFingerprintMatch) {
    issues.push("Web and worker config fingerprints do not match.");
  }

  return {
    sampledAt: nowIso(),
    buildId,
    freshnessWindowMinutes,
    contractValid:
      Boolean(normalizedRows.web?.contract?.validation.pass) &&
      Boolean(normalizedRows.worker?.contract?.validation.pass),
    serviceHealth: normalizedRows,
    webPresent: Boolean(normalizedRows.web?.fresh),
    workerPresent: Boolean(normalizedRows.worker?.fresh),
    workerActive:
      Boolean(normalizedRows.worker?.fresh) && normalizedRows.worker?.stagingIdle === false,
    dbFingerprintMatch,
    configFingerprintMatch,
    issues,
  };
}
