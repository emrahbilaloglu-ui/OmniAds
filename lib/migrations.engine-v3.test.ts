import { beforeEach, describe, expect, it, vi } from "vitest";

const ENGINE_V3_TABLES = [
  "engine_v3_account_calibration_daily",
  "engine_v3_creative_lifecycle_daily",
  "engine_v3_decision_events",
  "engine_v3_decision_snapshots_daily",
  "engine_v3_job_runs",
] as const;

const ENGINE_V3_INDEXES = [
  "idx_engine_v3_job_runs_lookup",
  "idx_engine_v3_job_runs_status",
  "idx_engine_v3_job_runs_business_recent",
  "idx_engine_v3_calibration_latest",
  "idx_engine_v3_lifecycle_business_day",
  "idx_engine_v3_lifecycle_creative_timeline",
  "idx_engine_v3_lifecycle_attention",
  "idx_engine_v3_decisions_business_day_label",
  "idx_engine_v3_decisions_creative_timeline",
  "idx_engine_v3_decisions_first_scale",
  "idx_engine_v3_events_business_date",
  "idx_engine_v3_events_creative_timeline",
] as const;

const ENGINE_V3_COLUMN_COUNTS = {
  engine_v3_job_runs: 22,
  engine_v3_account_calibration_daily: 26,
  engine_v3_creative_lifecycle_daily: 62,
  engine_v3_decision_snapshots_daily: 24,
  engine_v3_decision_events: 17,
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
  }));
  vi.doMock("@/lib/startup-diagnostics", () => ({
    logStartupError: vi.fn(),
    logStartupEvent: vi.fn(),
  }));

  const { runMigrations } = await import("@/lib/migrations");
  await runMigrations({ force: true, reason: "engine-v3-schema-test" });

  return queries;
}

function findCreateTableStatement(queries: string[], tableName: string) {
  return (
    queries.find((query) => query.includes(`CREATE TABLE IF NOT EXISTS ${tableName} (`)) ?? ""
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
  return queries.filter((query) => query.includes("engine_v3_"));
}

describe("Engine v3 precomputed table migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("creates the five engine_v3 tables with expected constraints and indexes", async () => {
    const queries = await collectMigrationQueries();
    const joined = normalizeSql(engineStatements(queries).join("\n"));

    for (const tableName of ENGINE_V3_TABLES) {
      const statement = findCreateTableStatement(queries, tableName);
      expect(statement).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
      expect(countColumnDefinitions(statement)).toBe(ENGINE_V3_COLUMN_COUNTS[tableName]);
    }

    expect(normalizeSql(findCreateTableStatement(queries, "engine_v3_account_calibration_daily"))).toContain(
      normalizeSql("UNIQUE (business_ref_id, scope_type, scope_id, as_of_date, engine_version)"),
    );
    expect(normalizeSql(findCreateTableStatement(queries, "engine_v3_creative_lifecycle_daily"))).toContain(
      normalizeSql("UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)"),
    );
    expect(normalizeSql(findCreateTableStatement(queries, "engine_v3_decision_snapshots_daily"))).toContain(
      normalizeSql("UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)"),
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
      normalizeSql("job_run_id UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL"),
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
    expect(joined).not.toContain("REFERENCES businesses");
    expect(joined).not.toContain("REFERENCES provider_accounts");
    expect(joined).not.toContain("REFERENCES meta_creative_daily");
  });

  it("emits idempotent schema-only SQL for engine_v3 tables", async () => {
    const firstRun = engineStatements(await collectMigrationQueries()).map(normalizeSql);
    const secondRun = engineStatements(await collectMigrationQueries()).map(normalizeSql);

    expect(secondRun).toEqual(firstRun);

    for (const statement of firstRun) {
      expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    }

    expect(firstRun.join("\n")).not.toMatch(
      /\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+engine_v3_/i,
    );
  });
});
