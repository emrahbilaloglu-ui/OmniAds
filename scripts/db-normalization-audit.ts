import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDbWithTimeout } from "@/lib/db";
import {
  buildNormalizationRunDir,
  getOptionalCliValue,
  parseCliArgs,
  writeJsonFile,
  writeTextFile,
} from "./db-normalization-support";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "./_operational-runtime";

type RefCoverageRow = {
  tableName: string;
  refColumn: "business_ref_id" | "provider_account_ref_id";
  totalRows: number;
  nullRefRows: number;
  populatedRefRows: number;
  expectedNullRefRows: number;
  blockingNullRefRows: number;
};

type LegacyCorePhase = "compat_retained" | "removed";

type ExpectedNullRef = {
  tableName: "provider_connections";
  refColumn: "provider_account_ref_id";
  rowCount: number;
  reason: "search_console_not_selected";
};

type LegacyTableState = {
  tableName:
    | "integrations"
    | "provider_account_assignments"
    | "provider_account_snapshots";
  exists: boolean;
  rows: number | null;
};

type CoreLegacyState = {
  legacyPhase: LegacyCorePhase;
  tables: LegacyTableState[];
  providerConnectionsRows: number;
  businessProviderAccountsRows: number;
  snapshotRunsRows: number;
  snapshotItemsRows: number;
};

type AuditSummary = {
  totalRefTables: number;
  tablesWithRefGaps: number;
  tablesWithBlockingRefGaps: number;
  businessRefGapTables: number;
  providerRefGapTables: number;
  businessBlockingRefGapTables: number;
  providerBlockingRefGapTables: number;
  expectedNullRefTables: number;
  expectedNullRefRows: number;
  legacyPhase: LegacyCorePhase;
  retainedLegacyTables: number;
  removedLegacyTables: number;
  duplicateDerivedCandidateCount: number;
};

export type DbNormalizationClassification =
  | "canonical"
  | "derived_label"
  | "raw_payload"
  | "display_alias"
  | "historical_snapshot"
  | "compatibility_shadow"
  | "unclear";

export type DbNormalizationRemovalRisk = "low" | "medium" | "high";

export interface DbColumnDescriptor {
  tableName: string;
  columnName: string;
  dataType?: string | null;
}

export interface DbDuplicateDerivedCandidate {
  tableName: string;
  columnName: string;
  classification: DbNormalizationClassification;
  suspectedSource: string | null;
  suspectedDuplicate: string | null;
  recommendedCanonicalField: string | null;
  consumerCount: number | null;
  removalRisk: DbNormalizationRemovalRisk;
  rationale: string;
}

type ExpectedNullRefCandidate = {
  provider: string | null;
  provider_account_id: string | null;
  provider_account_name: string | null;
  business_ref_id: string | null;
};

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function columnKey(tableName: string, columnName: string) {
  return `${tableName}.${columnName}`;
}

function buildTableColumnMap(columns: DbColumnDescriptor[]) {
  const byTable = new Map<string, Set<string>>();
  for (const column of columns) {
    const table = byTable.get(column.tableName) ?? new Set<string>();
    table.add(column.columnName);
    byTable.set(column.tableName, table);
  }
  return byTable;
}

function hasColumn(tableColumns: Set<string>, columnName: string) {
  return tableColumns.has(columnName);
}

function buildCandidate(input: {
  column: DbColumnDescriptor;
  classification: DbNormalizationClassification;
  suspectedSource?: string | null;
  suspectedDuplicate?: string | null;
  recommendedCanonicalField?: string | null;
  removalRisk: DbNormalizationRemovalRisk;
  rationale: string;
  consumerCounts?: Map<string, number>;
}): DbDuplicateDerivedCandidate {
  return {
    tableName: input.column.tableName,
    columnName: input.column.columnName,
    classification: input.classification,
    suspectedSource: input.suspectedSource ?? null,
    suspectedDuplicate: input.suspectedDuplicate ?? null,
    recommendedCanonicalField: input.recommendedCanonicalField ?? null,
    consumerCount:
      input.consumerCounts?.get(
        columnKey(input.column.tableName, input.column.columnName),
      ) ?? null,
    removalRisk: input.removalRisk,
    rationale: input.rationale,
  };
}

export function classifyDuplicateDerivedColumn(input: {
  column: DbColumnDescriptor;
  tableColumns: Set<string>;
  consumerCounts?: Map<string, number>;
}): DbDuplicateDerivedCandidate | null {
  const { column, tableColumns, consumerCounts } = input;
  const name = column.columnName;

  if (name === "breakdown_label" && hasColumn(tableColumns, "breakdown_key")) {
    return null;
  }

  if (name === "display_query" && hasColumn(tableColumns, "normalized_query")) {
    return null;
  }

  if (name.endsWith("_label")) {
    const base = name.slice(0, -"_label".length);
    const typeColumn = `${base}_type`;
    const codeColumn = `${base}_code`;
    if (hasColumn(tableColumns, typeColumn) || hasColumn(tableColumns, codeColumn)) {
      const canonical = hasColumn(tableColumns, typeColumn) ? typeColumn : codeColumn;
      return buildCandidate({
        column,
        classification: "derived_label",
        suspectedSource: canonical,
        suspectedDuplicate: canonical,
        recommendedCanonicalField: canonical,
        removalRisk: "medium",
        rationale: "Label column has a matching type/code column and should be derived for display.",
        consumerCounts,
      });
    }
  }

  if (name.endsWith("_type")) {
    const labelColumn = `${name.slice(0, -"_type".length)}_label`;
    if (hasColumn(tableColumns, labelColumn)) {
      return buildCandidate({
        column,
        classification: "canonical",
        suspectedDuplicate: labelColumn,
        recommendedCanonicalField: name,
        removalRisk: "low",
        rationale: "Type column is the canonical enum/value beside a derived display label.",
        consumerCounts,
      });
    }
  }

  if (name === "manual_bid_amount" && hasColumn(tableColumns, "bid_value")) {
    return buildCandidate({
      column,
      classification: "compatibility_shadow",
      suspectedSource: "Meta API bid_amount",
      suspectedDuplicate: "bid_value",
      recommendedCanonicalField: hasColumn(tableColumns, "bid_value_format")
        ? "bid_value + bid_value_format"
        : "bid_value",
      removalRisk: "medium",
      rationale: "Raw Meta bid amount overlaps operator-normalized bid value; live data confirmed it is derivable when bid_value_format is currency.",
      consumerCounts,
    });
  }

  if (name === "bid_value" && hasColumn(tableColumns, "manual_bid_amount")) {
    return buildCandidate({
      column,
      classification: "canonical",
      suspectedDuplicate: "manual_bid_amount",
      recommendedCanonicalField: hasColumn(tableColumns, "bid_value_format")
        ? "bid_value + bid_value_format"
        : "bid_value",
      removalRisk: "low",
      rationale: "Operator-normalized bid value is canonical; manual_bid_amount is derived at read time when the bid format is currency.",
      consumerCounts,
    });
  }

  if (name.endsWith("_amount")) {
    const valueColumn = `${name.slice(0, -"_amount".length)}_value`;
    if (hasColumn(tableColumns, valueColumn)) {
      return buildCandidate({
        column,
        classification: "unclear",
        suspectedDuplicate: valueColumn,
        recommendedCanonicalField: valueColumn,
        removalRisk: "high",
        rationale: "Amount/value pair needs semantic review before either side becomes canonical.",
        consumerCounts,
      });
    }
  }

  if (name.endsWith("_value")) {
    const amountColumn = `${name.slice(0, -"_value".length)}_amount`;
    if (hasColumn(tableColumns, amountColumn)) {
      return buildCandidate({
        column,
        classification: "unclear",
        suspectedDuplicate: amountColumn,
        recommendedCanonicalField: name,
        removalRisk: "medium",
        rationale: "Value column may be the canonical normalized form, but the pair requires review.",
        consumerCounts,
      });
    }
  }

  if (
    name === "payload_json" ||
    name === "projection_json" ||
    name === "raw_payload" ||
    name === "raw_response" ||
    name.endsWith("_payload_json") ||
    name.endsWith("_projection_json")
  ) {
    return buildCandidate({
      column,
      classification: "raw_payload",
      suspectedSource: name.includes("projection") ? "normalized projection" : "provider/raw payload",
      recommendedCanonicalField: null,
      removalRisk: "high",
      rationale: "Raw/projection JSON is intentionally retained for replay, audit, and compatibility.",
      consumerCounts,
    });
  }

  if (name.startsWith("display_")) {
    const normalizedColumn = `normalized_${name.slice("display_".length)}`;
    if (hasColumn(tableColumns, normalizedColumn)) {
      return buildCandidate({
        column,
        classification: "display_alias",
        suspectedSource: normalizedColumn,
        suspectedDuplicate: normalizedColumn,
        recommendedCanonicalField: normalizedColumn,
        removalRisk: "medium",
        rationale: "Display alias has a normalized sibling and should be derived at read time.",
        consumerCounts,
      });
    }
  }

  if (name.startsWith("normalized_")) {
    const displayColumn = `display_${name.slice("normalized_".length)}`;
    if (hasColumn(tableColumns, displayColumn)) {
      return buildCandidate({
        column,
        classification: "canonical",
        suspectedDuplicate: displayColumn,
        recommendedCanonicalField: name,
        removalRisk: "low",
        rationale: "Normalized column is canonical beside a display alias.",
        consumerCounts,
      });
    }
  }

  if (name.endsWith("_current")) {
    const historicalColumn = `${name.slice(0, -"_current".length)}_historical`;
    if (hasColumn(tableColumns, historicalColumn)) {
      return buildCandidate({
        column,
        classification: "canonical",
        suspectedDuplicate: historicalColumn,
        recommendedCanonicalField: name,
        removalRisk: "low",
        rationale: "Current/historical pair is intentional; current is the serving value.",
        consumerCounts,
      });
    }
  }

  if (name.endsWith("_historical")) {
    const currentColumn = `${name.slice(0, -"_historical".length)}_current`;
    if (hasColumn(tableColumns, currentColumn)) {
      return buildCandidate({
        column,
        classification: "historical_snapshot",
        suspectedSource: currentColumn,
        suspectedDuplicate: currentColumn,
        recommendedCanonicalField: currentColumn,
        removalRisk: "high",
        rationale: "Historical snapshot is intentional compatibility/history data and should not be dropped blindly.",
        consumerCounts,
      });
    }
  }

  if (name === "status" && hasColumn(tableColumns, "effective_status")) {
    return buildCandidate({
      column,
      classification: "compatibility_shadow",
      suspectedDuplicate: "effective_status",
      recommendedCanonicalField: "effective_status",
      removalRisk: "high",
      rationale: "Raw status and effective_status differ semantically; serving usually prefers effective_status.",
      consumerCounts,
    });
  }

  if (name === "effective_status" && hasColumn(tableColumns, "status")) {
    return buildCandidate({
      column,
      classification: "canonical",
      suspectedDuplicate: "status",
      recommendedCanonicalField: "effective_status",
      removalRisk: "low",
      rationale: "Effective status is the canonical serving status when both status fields exist.",
      consumerCounts,
    });
  }

  return null;
}

export function buildDuplicateDerivedCandidates(input: {
  columns: DbColumnDescriptor[];
  consumerCounts?: Map<string, number>;
}) {
  const byTable = buildTableColumnMap(input.columns);
  const candidates: DbDuplicateDerivedCandidate[] = [];
  for (const column of input.columns) {
    const tableColumns = byTable.get(column.tableName);
    if (!tableColumns) continue;
    const candidate = classifyDuplicateDerivedColumn({
      column,
      tableColumns,
      consumerCounts: input.consumerCounts,
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((left, right) =>
    left.tableName.localeCompare(right.tableName) ||
    left.columnName.localeCompare(right.columnName),
  );
}

async function collectPublicSchemaColumns(): Promise<DbColumnDescriptor[]> {
  const sql = getDbWithTimeout(30_000);
  const rows = (await sql.query<{
    table_name: string;
    column_name: string;
    data_type: string | null;
  }>(
    `
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `,
  )) as Array<{ table_name: string; column_name: string; data_type: string | null }>;

  return rows.map((row) => ({
    tableName: row.table_name,
    columnName: row.column_name,
    dataType: row.data_type,
  }));
}

async function collectRefCoverage() {
  const sql = getDbWithTimeout(30_000);
  const refColumns = ["business_ref_id", "provider_account_ref_id"] as const;
  const results: RefCoverageRow[] = [];

  for (const refColumn of refColumns) {
    const tableRows = (await sql.query<{ table_name: string }>(
      `
        SELECT DISTINCT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = $1
        ORDER BY table_name ASC
      `,
      [refColumn],
    )) as Array<{ table_name: string }>;

    for (const row of tableRows) {
      const tableName = String(row.table_name);
      const counts = (await sql.query<{
        total_rows: number | string | null;
        null_ref_rows: number | string | null;
      }>(
        `
          SELECT
            COUNT(*)::bigint AS total_rows,
            COUNT(*) FILTER (WHERE ${quoteIdentifier(refColumn)} IS NULL)::bigint AS null_ref_rows
          FROM ${quoteIdentifier(tableName)}
        `,
      )) as Array<{
        total_rows: number | string | null;
        null_ref_rows: number | string | null;
      }>;

      const totalRows = toNumber(counts[0]?.total_rows);
      const nullRefRows = toNumber(counts[0]?.null_ref_rows);
      results.push({
        tableName,
        refColumn,
        totalRows,
        nullRefRows,
        populatedRefRows: Math.max(0, totalRows - nullRefRows),
        expectedNullRefRows: 0,
        blockingNullRefRows: nullRefRows,
      });
    }
  }

  return results;
}

export function isExpectedNullProviderAccountRef(input: {
  legacyPhase: LegacyCorePhase;
  tableName: string;
  refColumn: "business_ref_id" | "provider_account_ref_id";
  provider: string | null;
  providerAccountId: string | null;
  providerAccountName: string | null;
  businessRefId: string | null;
}) {
  return (
    input.legacyPhase === "removed" &&
    input.tableName === "provider_connections" &&
    input.refColumn === "provider_account_ref_id" &&
    input.provider === "search_console" &&
    input.providerAccountId == null &&
    input.providerAccountName === "Not selected" &&
    input.businessRefId != null
  );
}

async function collectExpectedNullRefs(
  legacyPhase: LegacyCorePhase,
): Promise<ExpectedNullRef[]> {
  if (legacyPhase !== "removed") {
    return [];
  }

  const sql = getDbWithTimeout(30_000);
  const rows = (await sql.query<ExpectedNullRefCandidate>(
    `
      SELECT
        provider,
        provider_account_id::text AS provider_account_id,
        provider_account_name,
        business_ref_id::text AS business_ref_id
      FROM provider_connections
      WHERE provider_account_ref_id IS NULL
    `,
  )) as ExpectedNullRefCandidate[];

  const rowCount = rows.filter((row) =>
    isExpectedNullProviderAccountRef({
      legacyPhase,
      tableName: "provider_connections",
      refColumn: "provider_account_ref_id",
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      providerAccountName: row.provider_account_name,
      businessRefId: row.business_ref_id,
    }),
  ).length;

  if (rowCount === 0) {
    return [];
  }

  return [
    {
      tableName: "provider_connections",
      refColumn: "provider_account_ref_id",
      rowCount,
      reason: "search_console_not_selected",
    },
  ];
}

function applyExpectedNullRefs(
  refCoverage: RefCoverageRow[],
  expectedNullRefs: ExpectedNullRef[],
) {
  const expectedByKey = new Map(
    expectedNullRefs.map((row) => [
      `${row.tableName}:${row.refColumn}`,
      row.rowCount,
    ]),
  );

  return refCoverage.map((row) => {
    const expectedNullRefRows = Math.min(
      row.nullRefRows,
      expectedByKey.get(`${row.tableName}:${row.refColumn}`) ?? 0,
    );
    return {
      ...row,
      expectedNullRefRows,
      blockingNullRefRows: Math.max(0, row.nullRefRows - expectedNullRefRows),
    };
  });
}

async function collectCoreLegacyState(): Promise<CoreLegacyState> {
  const sql = getDbWithTimeout(30_000);
  const doesTableExist = async (tableName: string) => {
    try {
      const rows = (await sql.query<{ exists: boolean | null }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${tableName}`],
      )) as Array<{ exists: boolean | null }>;
      return rows[0]?.exists === true;
    } catch {
      return false;
    }
  };
  const safeCount = async (tableName: string) => {
    if (!(await doesTableExist(tableName))) {
      return null;
    }
    try {
      const rows = (await sql.query<{ value: number | string | null }>(
        `SELECT COUNT(*)::bigint AS value FROM ${quoteIdentifier(tableName)}`,
      )) as Array<{ value: number | string | null }>;
      return toNumber(rows[0]?.value);
    } catch {
      return null;
    }
  };

  const tables: LegacyTableState[] = [
    {
      tableName: "integrations",
      exists: await doesTableExist("integrations"),
      rows: await safeCount("integrations"),
    },
    {
      tableName: "provider_account_assignments",
      exists: await doesTableExist("provider_account_assignments"),
      rows: await safeCount("provider_account_assignments"),
    },
    {
      tableName: "provider_account_snapshots",
      exists: await doesTableExist("provider_account_snapshots"),
      rows: await safeCount("provider_account_snapshots"),
    },
  ];

  return {
    legacyPhase: tables.some((table) => table.exists)
      ? "compat_retained"
      : "removed",
    tables,
    providerConnectionsRows: (await safeCount("provider_connections")) ?? 0,
    businessProviderAccountsRows:
      (await safeCount("business_provider_accounts")) ?? 0,
    snapshotRunsRows:
      (await safeCount("provider_account_snapshot_runs")) ?? 0,
    snapshotItemsRows:
      (await safeCount("provider_account_snapshot_items")) ?? 0,
  };
}

function buildMarkdown(input: {
  capturedAt: string;
  runDir: string;
  refCoverage: RefCoverageRow[];
  expectedNullRefs: ExpectedNullRef[];
  coreLegacyState: CoreLegacyState;
  duplicateDerivedCandidates: DbDuplicateDerivedCandidate[];
  summary: AuditSummary;
}) {
  const lines: string[] = [];
  const refGaps = input.refCoverage.filter(
    (row) => row.totalRows > 0 && row.blockingNullRefRows > 0,
  );

  lines.push("# DB Normalization Audit");
  lines.push("");
  lines.push(`- Captured at: \`${input.capturedAt}\``);
  lines.push(`- Run dir: \`${input.runDir}\``);
  lines.push(
    `- Tables with business ref gaps: ${input.summary.businessBlockingRefGapTables}`,
  );
  lines.push(
    `- Tables with provider-account ref gaps: ${input.summary.providerBlockingRefGapTables}`,
  );
  lines.push(`- Expected null-ref tables: ${input.summary.expectedNullRefTables}`);
  lines.push(`- Expected null-ref rows: ${input.summary.expectedNullRefRows}`);
  lines.push(
    `- Duplicate/derived candidates: ${input.summary.duplicateDerivedCandidateCount}`,
  );
  lines.push(`- Legacy core phase: ${input.coreLegacyState.legacyPhase}`);
  lines.push(
    `- Normalized core rows: connections=${input.coreLegacyState.providerConnectionsRows}, business_provider_accounts=${input.coreLegacyState.businessProviderAccountsRows}, snapshot_runs=${input.coreLegacyState.snapshotRunsRows}, snapshot_items=${input.coreLegacyState.snapshotItemsRows}`,
  );
  lines.push("");

  if (refGaps.length > 0) {
    lines.push("## Ref Gaps");
    for (const gap of refGaps) {
      lines.push(
        `- ${gap.tableName}.${gap.refColumn}: ${gap.blockingNullRefRows}/${gap.totalRows} blocking rows still null`,
      );
    }
    lines.push("");
  }

  if (input.expectedNullRefs.length > 0) {
    lines.push("## Expected Null Refs");
    for (const expected of input.expectedNullRefs) {
      lines.push(
        `- ${expected.tableName}.${expected.refColumn}: ${expected.rowCount} rows intentionally null (${expected.reason})`,
      );
    }
    lines.push("");
  }

  if (input.duplicateDerivedCandidates.length > 0) {
    lines.push("## Duplicate / Derived Field Candidates");
    for (const candidate of input.duplicateDerivedCandidates.slice(0, 80)) {
      const canonical = candidate.recommendedCanonicalField
        ? ` canonical=${candidate.recommendedCanonicalField}`
        : "";
      const duplicate = candidate.suspectedDuplicate
        ? ` duplicate=${candidate.suspectedDuplicate}`
        : "";
      const consumers =
        candidate.consumerCount == null ? "" : ` consumers=${candidate.consumerCount}`;
      lines.push(
        `- ${candidate.tableName}.${candidate.columnName}: ${candidate.classification} risk=${candidate.removalRisk}${canonical}${duplicate}${consumers} - ${candidate.rationale}`,
      );
    }
    if (input.duplicateDerivedCandidates.length > 80) {
      lines.push(
        `- ... ${input.duplicateDerivedCandidates.length - 80} additional candidates in audit.json`,
      );
    }
    lines.push("");
  }

  lines.push("## Legacy Compatibility State");
  if (input.coreLegacyState.legacyPhase === "removed") {
    lines.push("- Legacy core tables are absent, which is the expected post-second-window state.");
  } else {
    for (const table of input.coreLegacyState.tables) {
      lines.push(
        `- ${table.tableName}: ${table.exists ? `retained (${table.rows ?? 0} rows)` : "missing"}`,
      );
    }
  }

  return lines.join("\n");
}

export function buildAuditSummary(input: {
  refCoverage: RefCoverageRow[];
  expectedNullRefs: ExpectedNullRef[];
  coreLegacyState: CoreLegacyState;
  duplicateDerivedCandidates?: DbDuplicateDerivedCandidate[];
}): AuditSummary {
  const blockingRefGaps = input.refCoverage.filter(
    (row) => row.totalRows > 0 && row.blockingNullRefRows > 0,
  );
  const businessBlockingRefGaps = blockingRefGaps.filter(
    (row) => row.refColumn === "business_ref_id",
  );
  const providerBlockingRefGaps = blockingRefGaps.filter(
    (row) => row.refColumn === "provider_account_ref_id",
  );
  const expectedNullRefRows = input.expectedNullRefs.reduce(
    (sum, row) => sum + row.rowCount,
    0,
  );

  return {
    totalRefTables: input.refCoverage.length,
    tablesWithRefGaps: blockingRefGaps.length,
    tablesWithBlockingRefGaps: blockingRefGaps.length,
    businessRefGapTables: businessBlockingRefGaps.length,
    providerRefGapTables: providerBlockingRefGaps.length,
    businessBlockingRefGapTables: businessBlockingRefGaps.length,
    providerBlockingRefGapTables: providerBlockingRefGaps.length,
    expectedNullRefTables: input.expectedNullRefs.length,
    expectedNullRefRows,
    legacyPhase: input.coreLegacyState.legacyPhase,
    retainedLegacyTables: input.coreLegacyState.tables.filter((table) => table.exists)
      .length,
    removedLegacyTables: input.coreLegacyState.tables.filter((table) => !table.exists)
      .length,
    duplicateDerivedCandidateCount: input.duplicateDerivedCandidates?.length ?? 0,
  };
}

async function main() {
  configureOperationalScriptRuntime();
  const parsed = parseCliArgs(process.argv.slice(2));
  const runDir = buildNormalizationRunDir({
    runDir: getOptionalCliValue(parsed, "run-dir", null) ?? undefined,
  });
  const outDir = getOptionalCliValue(parsed, "out-dir", path.join(runDir, "audit"))!;

  const payload = await withOperationalStartupLogsSilenced(async () => {
    const capturedAt = new Date().toISOString();
    const coreLegacyState = await collectCoreLegacyState();
    const expectedNullRefs = await collectExpectedNullRefs(
      coreLegacyState.legacyPhase,
    );
    const refCoverage = applyExpectedNullRefs(
      await collectRefCoverage(),
      expectedNullRefs,
    );
    const publicSchemaColumns = await collectPublicSchemaColumns();
    const duplicateDerivedCandidates = buildDuplicateDerivedCandidates({
      columns: publicSchemaColumns,
    });
    const summary = buildAuditSummary({
      refCoverage,
      expectedNullRefs,
      coreLegacyState,
      duplicateDerivedCandidates,
    });

    return {
      capturedAt,
      runDir,
      outDir,
      summary,
      refCoverage,
      expectedNullRefs,
      coreLegacyState,
      duplicateDerivedCandidates,
    };
  });

  const jsonPath = path.join(outDir, "audit.json");
  const markdownPath = path.join(outDir, "audit.md");
  await writeJsonFile(jsonPath, payload);
  await writeTextFile(
    markdownPath,
    buildMarkdown({
      capturedAt: payload.capturedAt,
      runDir: payload.runDir,
      refCoverage: payload.refCoverage,
      expectedNullRefs: payload.expectedNullRefs,
      coreLegacyState: payload.coreLegacyState,
      duplicateDerivedCandidates: payload.duplicateDerivedCandidates,
      summary: payload.summary,
    }),
  );

  console.log(JSON.stringify(payload, null, 2));
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
