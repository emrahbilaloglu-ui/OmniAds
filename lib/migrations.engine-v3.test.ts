import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ENGINE_V3_TABLES = [
  "business_engine_v3_flags",
  "engine_v3_account_calibration_daily",
  "engine_v3_creative_lifecycle_daily",
  "engine_v3_decision_events",
  "engine_v3_decision_outcomes_daily",
  "engine_v3_decision_snapshots_daily",
  "engine_v3_job_runs",
] as const;

const ENGINE_V3_INDEXES = [
  "idx_engine_v3_job_runs_lookup",
  "idx_engine_v3_job_runs_status",
  "idx_engine_v3_job_runs_business_recent",
  "idx_engine_v3_calibration_latest",
  "idx_engine_v3_calibration_latest_by_kind",
  "idx_engine_v3_lifecycle_business_day",
  "idx_engine_v3_lifecycle_creative_timeline",
  "idx_engine_v3_lifecycle_attention",
  "idx_engine_v3_decisions_business_day_label",
  "idx_engine_v3_decisions_creative_timeline",
  "idx_engine_v3_decisions_first_scale",
  "idx_engine_v3_events_business_date",
  "idx_engine_v3_events_creative_timeline",
  "idx_engine_v3_outcomes_business_eval",
  "idx_engine_v3_outcomes_label_window",
  "idx_engine_v3_outcomes_snapshot",
] as const;

const ENGINE_V3_COLUMN_COUNTS = {
  business_engine_v3_flags: 7,
  engine_v3_job_runs: 22,
  engine_v3_account_calibration_daily: 42,
  engine_v3_creative_lifecycle_daily: 62,
  engine_v3_decision_snapshots_daily: 32,
  engine_v3_decision_events: 17,
  engine_v3_decision_outcomes_daily: 29,
} satisfies Record<(typeof ENGINE_V3_TABLES)[number], number>;

function normalizeSql(statement: string) {
  return statement.replace(/\s+/g, " ").trim();
}

function joinTemplate(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce((statement, part, index) => {
    const value = index < values.length ? String(values[index]) : "";
    return `${statement}${part}${value}`;
  }, "");
}

function createSqlMock(queries: string[]) {
  return Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(joinTemplate(strings, values));
      return [];
    }),
    {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    },
  );
}

async function collectMigrationQueries() {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  vi.stubEnv("DB_DROP_LEGACY_CORE_TABLES", "");
  vi.stubEnv("DB_ENABLE_LEGACY_CORE_COMPAT_TABLES", "");

  const queries: string[] = [];
  const sql = createSqlMock(queries);

  vi.doMock("@/lib/db", () => ({
    getDb: () => sql,
    getDbWithTimeout: () => sql,
    runDbTransaction: async (operation: () => Promise<unknown>) => operation(),
  }));
  vi.doMock("@/lib/startup-diagnostics", () => ({
    logStartupError: vi.fn(),
    logStartupEvent: vi.fn(),
  }));

  const { runMigrations } = await import("@/lib/migrations");
  await runMigrations({
    force: true,
    reason: "engine-v3-schema-test",
    verifyNativeSchemaCapabilities: false,
  });

  return queries;
}

function findCreateTableStatement(queries: string[], tableName: string) {
  return (
    queries.find((query) =>
      query.includes(`CREATE TABLE IF NOT EXISTS ${tableName} (`),
    ) ?? ""
  );
}

function extractCreateTableBody(statement: string) {
  const openIndex = statement.indexOf("(");
  if (openIndex < 0) return "";

  let depth = 0;
  for (let index = openIndex; index < statement.length; index += 1) {
    const character = statement[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) return statement.slice(openIndex + 1, index);
  }

  return "";
}

function splitTopLevelSqlDefinitions(body: string) {
  const definitions: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      definitions.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalDefinition = body.slice(start).trim();
  if (finalDefinition) definitions.push(finalDefinition);

  return definitions;
}

function countColumnDefinitions(statement: string) {
  const body = extractCreateTableBody(statement);
  return splitTopLevelSqlDefinitions(body).filter((definition) => {
    const [firstToken] = definition.trim().split(/\s+/);
    return !["UNIQUE", "PRIMARY", "CONSTRAINT", "CHECK", "FOREIGN"].includes(
      firstToken?.toUpperCase() ?? "",
    );
  }).length;
}

function engineStatements(queries: string[]) {
  return queries.filter((query) => {
    const statement = normalizeSql(query);
    return ENGINE_V3_TABLES.some(
      (tableName) =>
        statement.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`) ||
        statement.includes(`ALTER TABLE ${tableName}`) ||
        statement.includes(` ON ${tableName} `),
    );
  });
}

function precomputedEngineStatements(queries: string[]) {
  return engineStatements(queries).filter(
    (query) =>
      !query.includes("business_engine_v3_flags") &&
      !query.includes("engine_v3_ad_"),
  );
}

describe("Engine v3 precomputed table migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("creates the engine_v3 tables with expected constraints and indexes", async () => {
    const queries = await collectMigrationQueries();
    const joined = normalizeSql(engineStatements(queries).join("\n"));

    for (const tableName of ENGINE_V3_TABLES) {
      const statement = findCreateTableStatement(queries, tableName);
      expect(statement).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
      expect(countColumnDefinitions(statement)).toBe(
        ENGINE_V3_COLUMN_COUNTS[tableName],
      );
    }

    expect(joined).toContain(
      normalizeSql(
        "UNIQUE (business_ref_id, scope_type, scope_id, campaign_kind, creative_format, as_of_date, engine_version)",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(
          queries,
          "engine_v3_account_calibration_daily",
        ),
      ),
    ).toContain(
      normalizeSql(
        "meta_aov_quality TEXT CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready'))",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(
          queries,
          "engine_v3_account_calibration_daily",
        ),
      ),
    ).toContain(
      normalizeSql(
        "campaign_kind TEXT NOT NULL DEFAULT 'all' CHECK (campaign_kind IN ('all', 'main', 'test', 'mixed'))",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_creative_lifecycle_daily"),
      ),
    ).toContain(
      normalizeSql(
        "UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_decision_snapshots_daily"),
      ),
    ).toContain(
      normalizeSql(
        "UNIQUE (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id)",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_decision_snapshots_daily"),
      ),
    ).toContain(
      normalizeSql(
        "label_transform TEXT CHECK (label_transform IN ('test_cohort_refresh_to_cut'))",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_decision_snapshots_daily"),
      ),
    ).toContain(
      normalizeSql(
        "blocked_action_type TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh'))",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_decision_snapshots_daily"),
      ),
    ).toContain(
      normalizeSql(
        "'commercial_truth', 'commercial_truth_stale', 'account_baseline'",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "ADD COLUMN IF NOT EXISTS label_transform TEXT CHECK (label_transform IN ('test_cohort_refresh_to_cut'))",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "ADD COLUMN IF NOT EXISTS blocked_action_type TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh'))",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "ADD CONSTRAINT engine_v3_decision_snapshots_daily_truth_source_check",
      ),
    );

    for (const indexName of ENGINE_V3_INDEXES) {
      expect(joined).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }

    expect(joined).toContain(
      normalizeSql(
        "dependency_run_id UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "job_run_id UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "lifecycle_row_id UUID REFERENCES engine_v3_creative_lifecycle_daily(id) ON DELETE SET NULL",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "calibration_row_id UUID REFERENCES engine_v3_account_calibration_daily(id) ON DELETE SET NULL",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "decision_snapshot_id UUID REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE SET NULL",
      ),
    );
    expect(joined).toContain(
      normalizeSql(
        "decision_snapshot_id UUID NOT NULL REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE CASCADE",
      ),
    );
    expect(
      normalizeSql(
        findCreateTableStatement(queries, "engine_v3_decision_outcomes_daily"),
      ),
    ).toContain(
      normalizeSql("UNIQUE (decision_snapshot_id, outcome_window_days)"),
    );
    expect(joined).toContain(
      normalizeSql(
        "business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE",
      ),
    );

    const precomputedJoined = normalizeSql(
      precomputedEngineStatements(queries).join("\n"),
    );
    expect(precomputedJoined).not.toContain("REFERENCES businesses");
    expect(precomputedJoined).not.toContain("REFERENCES provider_accounts");
    expect(precomputedJoined).not.toContain("REFERENCES meta_creative_daily");
  });

  it("emits idempotent schema-only SQL for engine_v3 tables", async () => {
    const firstRun = engineStatements(await collectMigrationQueries()).map(
      normalizeSql,
    );
    const secondRun = engineStatements(await collectMigrationQueries()).map(
      normalizeSql,
    );

    expect(secondRun).toEqual(firstRun);

    for (const statement of firstRun) {
      expect(statement).toMatch(
        /^(CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS|ALTER TABLE .* ADD COLUMN IF NOT EXISTS|DO \$\$) /,
      );
    }

    expect(firstRun.join("\n")).not.toMatch(
      /\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+engine_v3_/i,
    );
  });

  it("emits four nullable authority-provenance contracts", async () => {
    const joined = normalizeSql((await collectMigrationQueries()).join("\n"));
    for (const table of [
      "engine_v3_decision_snapshots_daily",
      "engine_v3_decision_outcomes_daily",
      "engine_v3_ad_decision_snapshots_daily",
      "engine_v3_ad_decision_outcomes_daily",
    ]) {
      expect(joined).toContain(table);
    }
    expect(joined).toContain(
      "ADD COLUMN IF NOT EXISTS pre_authority_label TEXT",
    );
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS authority_blocker TEXT");
    for (const blocker of [
      "profile_hard_action_ineligible",
      "source_freshness",
      "campaign_context",
      "native_metrics_unavailable",
      "native_profile_unavailable",
      "recent_recovery_unverifiable",
    ])
      expect(joined).toContain(blocker);
  });

  it("upgrades all four authority-blocker constraints without rewriting rows", async () => {
    const queries = await collectMigrationQueries();
    const upgrade = queries.find((query) =>
      query.includes("$d063_authority_blocker$"),
    );

    expect(upgrade).toBeDefined();
    for (const [table, constraint] of [
      [
        "engine_v3_decision_snapshots_daily",
        "engine_v3_decision_snapshots_authority_blocker_check",
      ],
      [
        "engine_v3_decision_outcomes_daily",
        "engine_v3_decision_outcomes_authority_blocker_check",
      ],
      [
        "engine_v3_ad_decision_snapshots_daily",
        "engine_v3_ad_snapshots_authority_blocker_check",
      ],
      [
        "engine_v3_ad_decision_outcomes_daily",
        "engine_v3_ad_outcomes_authority_blocker_check",
      ],
    ] as const) {
      expect(upgrade).toContain(table);
      expect(upgrade).toContain(constraint);
    }
    expect(upgrade).toContain("recent_recovery_unverifiable");
    expect(upgrade).toContain("NOT VALID");
    expect(upgrade).toContain("VALIDATE CONSTRAINT");
    expect(upgrade).toContain("RENAME CONSTRAINT");
    expect(upgrade).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\b/i);
  });

  it("extends partial native tables before capability inspection", () => {
    const source = readFileSync("lib/migrations.ts", "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(
      source.indexOf("await db.query(ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL)"),
    ).toBeLessThan(
      source.indexOf(
        "let decisions = await inspectEvaluationStoreSchemaCapability",
      ),
    );
    expect(
      source.indexOf("await db.query(NATIVE_AD_OUTCOME_PROVENANCE_SCHEMA_SQL)"),
    ).toBeLessThan(
      source.indexOf(
        "let outcomes = await inspectAdDecisionOutcomeSchemaCapability",
      ),
    );
  });

  it("adds kind calibration columns before indexing them", async () => {
    const queries = await collectMigrationQueries();
    const normalizedQueries = queries.map(normalizeSql);
    const addKindColumnsIndex = normalizedQueries.findIndex(
      (query) =>
        query.includes("ALTER TABLE engine_v3_account_calibration_daily") &&
        query.includes("ADD COLUMN IF NOT EXISTS creative_format") &&
        query.includes("ADD COLUMN IF NOT EXISTS campaign_kind"),
    );
    const byKindIndexIndex = normalizedQueries.findIndex((query) =>
      query.includes(
        "CREATE INDEX IF NOT EXISTS idx_engine_v3_calibration_latest_by_kind",
      ),
    );

    expect(addKindColumnsIndex).toBeGreaterThanOrEqual(0);
    expect(byKindIndexIndex).toBeGreaterThan(addKindColumnsIndex);
  });
});

describe("business target pack history migrations", () => {
  it("creates append-only history and bootstraps only a real current target row once", async () => {
    const queries = await collectMigrationQueries();
    const createStatement = normalizeSql(
      findCreateTableStatement(queries, "business_target_pack_history"),
    );
    const joined = normalizeSql(queries.join("\n"));

    expect(createStatement).toContain(
      "id UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    );
    expect(createStatement).toContain(
      "business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE",
    );
    expect(createStatement).toContain(
      "business_ref_id UUID REFERENCES businesses(id) ON DELETE SET NULL",
    );
    expect(createStatement).toContain(
      "operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete'))",
    );
    expect(createStatement).toContain("effective_at TIMESTAMPTZ NOT NULL");
    expect(createStatement).toContain(
      "recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    );
    expect(createStatement).toContain("CHECK (effective_at <= recorded_at)");
    expect(joined).toContain(
      normalizeSql(
        "CREATE INDEX IF NOT EXISTS idx_business_target_pack_history_business_effective ON business_target_pack_history (business_id, effective_at DESC, recorded_at DESC, id DESC)",
      ),
    );
    const backfills = queries
      .map(normalizeSql)
      .filter((query) =>
        query.startsWith("INSERT INTO business_target_pack_history"),
      );
    expect(backfills).toHaveLength(1);
    expect(backfills[0]).toContain("FROM business_target_packs target");
    expect(backfills[0]).toContain("target.updated_at");
    expect(backfills[0]).toContain(
      "GREATEST(transaction_timestamp(), target.updated_at)",
    );
    expect(backfills[0]).toContain(
      "WHERE NOT EXISTS ( SELECT 1 FROM business_target_pack_history history WHERE history.business_id = target.business_id )",
    );
    expect(backfills[0]).toContain("'upsert'");
    expect(joined).not.toContain("operation = 'bootstrap'");
  });
});
