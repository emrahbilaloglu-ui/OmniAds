/**
 * PRE-DEPLOY AUDIT — the Phase A -> B capability-open preflight, machine-run.
 *
 * `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md` is an operator
 * document: SELECT-only SQL, meant to be pasted into `psql` by hand, that
 * proves every business's automation posture from production itself. It is
 * the right evidence and it is not automatable as written — the capability
 * workflow needs a machine-parseable verdict, not a human reading a table.
 *
 * This module reuses that EXACT SQL (via `extractReadbackSql`, the same
 * function `scripts/automation-off-readback-seam.ts` already proves against a
 * real PostgreSQL in both schema states) and adds the one thing the doc
 * cannot express on its own: named verdicts for the six frozen target
 * businesses, not just "is anything, anywhere, enabled".
 *
 * Every function that touches a database is a thin wrapper around a PURE
 * evaluator. The evaluators are what is unit-tested; the wrappers are what
 * the workflow actually calls.
 */
import { readFileSync } from "node:fs";
import { extractReadbackSql } from "@/scripts/automation-off-readback-seam";

export const AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT =
  "meta.automation-capability-preflight.v1" as const;

/**
 * The six frozen target businesses, by exact ID — read from
 * `docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json`
 * (`businesses[].businessId` / `.providerAccountId`), the same bundle D082 is
 * pinned to by SHA-256. `TheSwaf` carries two provider accounts in that
 * bundle; both are named so a control row bound to either is caught.
 */
export const AUTOMATION_CAPABILITY_TARGET_BUSINESSES = [
  {
    name: "Bilsem Zeka",
    businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3",
    providerAccountIds: ["act_840779107261785"],
  },
  {
    name: "ColorFullWorldsTR",
    businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7",
    providerAccountIds: ["act_3554615364751964"],
  },
  {
    name: "Grandmix",
    businessId: "5dbc7147-f051-4681-a4d6-20617170074f",
    providerAccountIds: ["act_805150454596350"],
  },
  {
    name: "IwaStore",
    businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
    providerAccountIds: ["act_1087566732415606"],
  },
  {
    name: "IwaTR",
    businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51",
    providerAccountIds: ["act_2335220976649516"],
  },
  {
    name: "TheSwaf",
    businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    providerAccountIds: ["act_822913786458311", "act_921275999286619"],
  },
] as const;

export const READBACK_DOC_PATH = "docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md";

/**
 * Every section the readback SQL prints, and what a PASS looks like.
 *
 * `requiredVerdict` is the exact string the section's OWN `verdict` column
 * must equal. `"PASS"` only — NOT `"PASS (pre-migration)"` — because the
 * capability workflow runs strictly after migrations have completed; a
 * pre-migration verdict at capability-open time is itself a blocker, not a
 * pass. `mustBeEmpty: true` sections are the `_offenders` detail queries:
 * present ONLY when the paired top-level section already failed, and any row
 * in one is itself a named blocker.
 */
const READBACK_SECTION_CONTRACT: ReadonlyArray<
  { section: string; requiredVerdict?: string; mustBeEmpty?: true }
> = [
  { section: "transaction_posture", requiredVerdict: "PASS" },
  { section: "master_switch", requiredVerdict: "PASS" },
  { section: "master_switch_offenders", mustBeEmpty: true },
  { section: "dry_run_guardrail", requiredVerdict: "PASS" },
  { section: "decision_type_modes", requiredVerdict: "PASS" },
  { section: "decision_type_mode_offenders", mustBeEmpty: true },
  { section: "readiness_tier", requiredVerdict: "PASS" },
  { section: "schema_defaults", requiredVerdict: "PASS" },
  { section: "schema_guardrail_default", requiredVerdict: "PASS" },
  { section: "budget_queue", requiredVerdict: "PASS" },
  { section: "budget_write_journal", requiredVerdict: "PASS" },
];

export interface ParsedReadbackRow {
  section: string;
  verdict: string;
}

/**
 * A single CSV data line -> fields, honouring double-quoted fields that may
 * contain a comma (a business name, an activated-account id). Minimal on
 * purpose: this reads `psql --csv` output, whose quoting rules are exactly
 * RFC 4180's.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { fields.push(field); field = ""; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Parse `psql --csv -f <readback.sql>` output into `{section, verdict}` rows.
 *
 * `psql --csv` prints one CSV table per SELECT: a header line naming its
 * columns, then its data lines, then a blank line before the next table.
 * Every SELECT in the readback doc names `section` as its FIRST column and
 * `verdict` as its LAST — proven by the section contract above, which lists
 * every section the doc declares — so a header line is identified by its
 * first field literally being the string `section` (never a real section
 * value, which is always a snake_case name like `master_switch`) and
 * skipped; every other non-blank line is a data row.
 */
export function parseReadbackCsv(output: string): ParsedReadbackRow[] {
  const rows: ParsedReadbackRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim().length === 0) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    if (fields[0] === "section") continue; // the header line
    rows.push({ section: fields[0]!, verdict: fields[fields.length - 1]! });
  }
  return rows;
}

export interface ReadbackEvaluation {
  ok: boolean;
  blockers: string[];
  sectionsSeen: string[];
}

/**
 * Pure. Every blocker names the section AND, for a `_offenders` table, the
 * row count — so a refusal is diagnosable from the artifact alone.
 */
export function evaluateReadbackRows(rows: ReadonlyArray<ParsedReadbackRow>): ReadbackEvaluation {
  const blockers: string[] = [];
  const byCanonicalSection = new Map<string, ParsedReadbackRow[]>();
  for (const row of rows) {
    const list = byCanonicalSection.get(row.section) ?? [];
    list.push(row);
    byCanonicalSection.set(row.section, list);
  }

  for (const contract of READBACK_SECTION_CONTRACT) {
    const present = byCanonicalSection.get(contract.section) ?? [];
    if (contract.mustBeEmpty) {
      if (present.length > 0) {
        blockers.push(`${contract.section}: ${present.length} offending row(s) present`);
      }
      continue;
    }
    if (present.length === 0) {
      blockers.push(`${contract.section}: no row returned — the read did not happen`);
      continue;
    }
    if (present.length > 1) {
      blockers.push(`${contract.section}: expected exactly one row, got ${present.length}`);
      continue;
    }
    if (present[0]!.verdict !== contract.requiredVerdict) {
      blockers.push(
        `${contract.section}: verdict is '${present[0]!.verdict}', required '${contract.requiredVerdict}'`,
      );
    }
  }

  return { ok: blockers.length === 0, blockers, sectionsSeen: [...byCanonicalSection.keys()] };
}

/** The SQL an operator would paste, unmodified, ready for `psql --csv -f`. */
export function readbackSqlForCsv(): string {
  return extractReadbackSql(readFileSync(READBACK_DOC_PATH, "utf8"));
}

// ── The six-business check, on top of the shared readback ──────────────────

export interface BusinessControlRow {
  business_id: string;
  auto_execution_enabled: boolean | null;
  auto_execution_provider_account_id: string | null;
}

export type PerBusinessStatus = "row_absent" | "off" | "ENABLED";

export interface PerBusinessVerdict {
  name: string;
  businessId: string;
  status: PerBusinessStatus;
  boundProviderAccountId: string | null;
}

/** The exact IN-list SQL for the six frozen IDs, LEFT JOINed so absence reads as absence. */
export function perBusinessControlQuery(): string {
  const ids = AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => `'${b.businessId}'`).join(", ");
  return `
    SELECT b.id::text AS business_id, c.auto_execution_enabled,
           to_jsonb(c) ->> 'auto_execution_provider_account_id' AS auto_execution_provider_account_id
      FROM (VALUES (${AUTOMATION_CAPABILITY_TARGET_BUSINESSES.map((b) => `'${b.businessId}'::uuid`).join("), (")})) AS b(id)
      LEFT JOIN meta_automation_business_controls c ON c.business_id = b.id
      WHERE b.id::text IN (${ids})`;
}

/** Pure. `rows` is a LEFT JOIN result: one row per target business, present or not. */
export function evaluatePerBusinessRows(
  rows: ReadonlyArray<BusinessControlRow>,
): { ok: boolean; blockers: string[]; perBusiness: PerBusinessVerdict[] } {
  const blockers: string[] = [];
  const byId = new Map(rows.map((row) => [row.business_id, row]));
  const perBusiness: PerBusinessVerdict[] = [];

  for (const target of AUTOMATION_CAPABILITY_TARGET_BUSINESSES) {
    const row = byId.get(target.businessId);
    if (!row || row.auto_execution_enabled === null) {
      perBusiness.push({
        name: target.name, businessId: target.businessId,
        status: "row_absent", boundProviderAccountId: null,
      });
      continue;
    }
    if (row.auto_execution_enabled === true) {
      blockers.push(
        `${target.name} (${target.businessId}) has auto_execution_enabled = TRUE`
        + (row.auto_execution_provider_account_id
          ? ` bound to ${row.auto_execution_provider_account_id}` : ""),
      );
      perBusiness.push({
        name: target.name, businessId: target.businessId, status: "ENABLED",
        boundProviderAccountId: row.auto_execution_provider_account_id,
      });
      continue;
    }
    perBusiness.push({
      name: target.name, businessId: target.businessId, status: "off",
      boundProviderAccountId: row.auto_execution_provider_account_id,
    });
  }
  /*
    Every target business must be accounted for by an ACTUAL input row — a
    query that silently dropped one from a LEFT JOIN result would otherwise
    read as a quiet pass, because `perBusiness` above is always built to
    length 6 (one entry per DECLARED target, "not found in `rows`" already
    folding into `row_absent`). The check belongs on `rows.length`, the raw
    thing the database actually returned, not on the always-six output.
  */
  if (rows.length !== AUTOMATION_CAPABILITY_TARGET_BUSINESSES.length) {
    blockers.push(
      `expected ${AUTOMATION_CAPABILITY_TARGET_BUSINESSES.length} target-business rows, got ${rows.length}`,
    );
  }
  return { ok: blockers.length === 0, blockers, perBusiness };
}

export interface AutomationCapabilityPreflightResult {
  contract: typeof AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT;
  ok: boolean;
  blockers: string[];
  sectionsSeen: string[];
  perBusiness: PerBusinessVerdict[];
}

/**
 * Combine both evaluators into one verdict. Pure — the two raw inputs are
 * whatever the caller already read (from a real `psql --csv` run, or from a
 * test fixture). `readbackCsvOutput === null` and `businessRows === null`
 * are UNKNOWN, never treated as empty-and-passing: a preflight that could
 * not run is a preflight that refused.
 */
export function evaluateAutomationCapabilityPreflight(input: {
  readbackCsvOutput: string | null;
  businessRows: ReadonlyArray<BusinessControlRow> | null;
}): AutomationCapabilityPreflightResult {
  const blockers: string[] = [];
  let sectionsSeen: string[] = [];
  let perBusiness: PerBusinessVerdict[] = [];

  if (input.readbackCsvOutput === null) {
    blockers.push("readback_unreadable: the automation-off readback could not be executed");
  } else {
    const parsed = evaluateReadbackRows(parseReadbackCsv(input.readbackCsvOutput));
    sectionsSeen = parsed.sectionsSeen;
    blockers.push(...parsed.blockers);
  }

  if (input.businessRows === null) {
    blockers.push("target_businesses_unreadable: the six-business control read could not be executed");
  } else {
    const perBiz = evaluatePerBusinessRows(input.businessRows);
    perBusiness = perBiz.perBusiness;
    blockers.push(...perBiz.blockers);
  }

  return {
    contract: AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT,
    ok: blockers.length === 0,
    blockers,
    sectionsSeen,
    perBusiness,
  };
}

// ── Runtime DB path — no psql, no docs file, ships in the worker image ─────
//
// The shipped worker image (Dockerfile's `worker-runner` stage) copies
// `app/`, `lib/`, `providers/`, `scripts/`, `deploy/`, `src/`, `store/`,
// `hooks/`, `components/` and a handful of root config files — it never
// copies `docs/`, and the base `node:20-alpine` image never installs a
// `psql` client. `readbackSqlForCsv()` above and `scripts/automation-
// capability-preflight-cli.ts`'s old `spawnSync("psql", ...)` path both
// depended on one or the other; run for real inside that container, the
// docs read throws ENOENT and the psql spawn fails with ENOENT too — the
// preflight could refuse but could never PASS, so capability-open could
// never succeed on an actual deploy. This is the fix: the same SELECT text
// as `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md`, extracted ONCE
// (verbatim, not retyped — `automation-capability-preflight.test.ts`'s
// "runtime SQL matches the operator doc" cases assert byte-identical
// equality against the doc's own fenced block) and run through the app's
// own `getDb()`/`runDbTransaction()` — the same bounded
// `REPEATABLE READ READ ONLY` + `SET LOCAL statement_timeout` +
// unique-`application_name` pattern
// `scripts/audits/d077-production-recovery-readonly-preflight.ts` already
// proves against real production. The two psql meta-commands the document
// needs (`\gset` / `\if` around the budget-write-journal section, since
// naming a not-yet-migrated table aborts the whole transaction at PARSE
// time) are not valid SQL and cannot be sent to the server; they are
// replaced by the exact same client-side branch, in real JS control flow,
// in `runRuntimeReadback` below.
export const RUNTIME_READBACK_SQL_STATEMENTS: ReadonlyArray<{ section: string; sql: string }> = [
  { section: "transaction_posture", sql: "-- 0. Prove this session really is read-only and isolated. ---------------\nSELECT\n  'transaction_posture'                       AS section,\n  current_setting('transaction_read_only')    AS read_only,\n  current_setting('transaction_isolation')    AS isolation,\n  current_setting('statement_timeout')        AS statement_timeout,\n  current_setting('application_name')         AS application_name,\n  CASE\n    WHEN current_setting('transaction_read_only') = 'on'\n     AND current_setting('transaction_isolation') = 'repeatable read'\n    THEN 'PASS' ELSE 'FAIL' END               AS verdict;" },
  { section: "master_switch", sql: "-- 1. THE MASTER SWITCH, per business. -----------------------------------\n--    `auto_execution_enabled` is the business-wide master automatic-\n--    execution flag. Budget is the only decision type with an automatic\n--    executor today, and it reads this column.\n--    `to_jsonb(c) ->> '<column>'` is used for columns this release ADDS, so\n--    the same file runs unchanged before and after the migration: a column\n--    that does not exist yet reads as NULL instead of aborting the read.\nSELECT\n  'master_switch'                                          AS section,\n  count(*)                                                 AS control_rows,\n  count(*) FILTER (WHERE c.auto_execution_enabled)         AS enabled_rows,\n  count(*) FILTER (\n    WHERE to_jsonb(c) ->> 'auto_execution_provider_account_id' IS NOT NULL\n  )                                                        AS account_bound_rows,\n  CASE WHEN count(*) FILTER (WHERE c.auto_execution_enabled) = 0\n       THEN 'PASS' ELSE 'FAIL \u2014 see section 1b' END        AS verdict\nFROM meta_automation_business_controls c;" },
  { section: "master_switch_offenders", sql: "-- 1b. If section 1 failed, these are the exact businesses. Empty is good.\nSELECT\n  'master_switch_offenders'                       AS section,\n  b.id::text                                      AS business_id,\n  b.name                                          AS business_name,\n  c.auto_execution_enabled                        AS enabled,\n  to_jsonb(c) ->> 'auto_execution_provider_account_id' AS activated_account,\n  c.updated_by::text                              AS enabled_by,\n  c.updated_at                                    AS enabled_at,\n  'FAIL'                                          AS verdict\nFROM meta_automation_business_controls c\nJOIN businesses b ON b.id = c.business_id\nWHERE c.auto_execution_enabled\nORDER BY b.name;" },
  { section: "dry_run_guardrail", sql: "-- 2. THE DRY-RUN GUARDRAIL. `dryRunOnly` must not be false anywhere. -----\n--    Absent is safe: the reader treats a missing key as TRUE.\nSELECT\n  'dry_run_guardrail'                                            AS section,\n  count(*)                                                       AS control_rows,\n  count(*) FILTER (WHERE guardrails_json ->> 'dryRunOnly' = 'false')\n                                                                 AS lifted_rows,\n  CASE WHEN count(*) FILTER (WHERE guardrails_json ->> 'dryRunOnly' = 'false') = 0\n       THEN 'PASS' ELSE 'FAIL' END                               AS verdict\nFROM meta_automation_business_controls;" },
  { section: "decision_type_modes", sql: "-- 3. THE SECOND KEY: no decision type may stand at Tier 3 (auto). --------\nSELECT\n  'decision_type_modes'                              AS section,\n  count(*)                                           AS mode_rows,\n  count(*) FILTER (WHERE mode = 'auto')              AS auto_rows,\n  count(*) FILTER (WHERE mode = 'auto' AND decision_type = 'budget')\n                                                     AS budget_auto_rows,\n  CASE WHEN count(*) FILTER (WHERE mode = 'auto') = 0\n       THEN 'PASS' ELSE 'FAIL \u2014 see section 3b' END  AS verdict\nFROM meta_automation_decision_type_modes;" },
  { section: "decision_type_mode_offenders", sql: "-- 3b. Exact offenders. Empty is good.\nSELECT\n  'decision_type_mode_offenders'  AS section,\n  business_id::text               AS business_id,\n  decision_type,\n  mode,\n  updated_by::text                AS updated_by,\n  updated_at,\n  'FAIL'                          AS verdict\nFROM meta_automation_decision_type_modes\nWHERE mode = 'auto'\nORDER BY business_id, decision_type;" },
  { section: "readiness_tier", sql: "-- 4. THE READINESS TIER. `auto_execute` is the business-wide composite's\n--    second condition; nothing should stand there before a deliberate\n--    activation.\nSELECT\n  'readiness_tier'                                        AS section,\n  count(*) FILTER (WHERE readiness_tier = 'auto_execute') AS auto_execute_rows,\n  count(*) FILTER (WHERE kill_switch_engaged)             AS stopped_rows,\n  CASE WHEN count(*) FILTER (WHERE readiness_tier = 'auto_execute') = 0\n       THEN 'PASS' ELSE 'FAIL' END                        AS verdict\nFROM meta_automation_business_controls;" },
  { section: "schema_defaults", sql: "-- 5. SCHEMA DEFAULTS. A new business must arrive OFF. --------------------\n--    Pre-deploy the activated-account column does not exist yet; its verdict\n--    is then 'PASS (pre-migration)'. Post-deploy it must be nullable with no\n--    default, so an existing row enables nothing.\nSELECT\n  'schema_defaults'                                    AS section,\n  max(column_default) FILTER (WHERE column_name = 'auto_execution_enabled')\n                                                       AS auto_execution_default,\n  count(*) FILTER (WHERE column_name = 'auto_execution_provider_account_id')\n                                                       AS activated_account_present,\n  max(is_nullable)    FILTER (WHERE column_name = 'auto_execution_provider_account_id')\n                                                       AS activated_account_nullable,\n  max(column_default) FILTER (WHERE column_name = 'auto_execution_provider_account_id')\n                                                       AS activated_account_default,\n  max(column_default) FILTER (WHERE column_name = 'readiness_tier')\n                                                       AS readiness_tier_default,\n  CASE\n    WHEN max(column_default) FILTER (WHERE column_name = 'auto_execution_enabled') <> 'false'\n      THEN 'FAIL'\n    WHEN count(*) FILTER (WHERE column_name = 'auto_execution_provider_account_id') = 0\n      THEN 'PASS (pre-migration)'\n    WHEN max(is_nullable) FILTER (WHERE column_name = 'auto_execution_provider_account_id') = 'YES'\n     AND max(column_default) FILTER (WHERE column_name = 'auto_execution_provider_account_id') IS NULL\n      THEN 'PASS'\n    ELSE 'FAIL' END                                    AS verdict\nFROM information_schema.columns\nWHERE table_schema = 'public'\n  AND table_name = 'meta_automation_business_controls';" },
  { section: "schema_guardrail_default", sql: "-- 5b. The guardrails_json column DEFAULT must still ship dryRunOnly TRUE.\nSELECT\n  'schema_guardrail_default'                                       AS section,\n  column_default                                                   AS guardrails_default,\n  CASE WHEN column_default LIKE '%\"dryRunOnly\": true%'\n       THEN 'PASS' ELSE 'FAIL' END                                 AS verdict\nFROM information_schema.columns\nWHERE table_schema = 'public'\n  AND table_name = 'meta_automation_business_controls'\n  AND column_name = 'guardrails_json';" },
  { section: "budget_queue", sql: "-- 6. NOTHING IN FLIGHT. A budget proposal must not be mid-execution\n--    across the deploy.\nSELECT\n  'budget_queue'                                                    AS section,\n  count(*)                                                          AS budget_proposals,\n  count(*) FILTER (WHERE status = 'claimed')                        AS claimed,\n  count(*) FILTER (WHERE status = 'reconcile')                      AS reconcile,\n  count(*) FILTER (\n    WHERE to_jsonb(p) ->> 'dispatch_started_at' IS NOT NULL\n  )                                                                 AS dispatch_started,\n  CASE WHEN count(*) FILTER (WHERE status IN ('claimed', 'reconcile')) = 0\n       THEN 'PASS' ELSE 'FAIL' END                                  AS verdict\nFROM meta_automation_proposals p\nWHERE p.proposed_action = 'budget';" },
];

/** Section 6b's client-side guard, ported: probe first, branch in JS, never SQL. */
export const BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL = "SELECT (to_regclass('public.meta_budget_write_journal') IS NOT NULL)\n       AS journal_present";

export const BUDGET_WRITE_JOURNAL_PRESENT_SQL = "SELECT\n  'budget_write_journal'                                     AS section,\n  true                                                       AS table_present,\n  count(*)                                                   AS journal_rows,\n  count(*) FILTER (WHERE provider_attempted)                 AS provider_attempted,\n  count(*) FILTER (WHERE result_class = 'verified')          AS verified_writes,\n  CASE WHEN count(*) FILTER (WHERE provider_attempted) = 0\n       THEN 'PASS' ELSE 'REVIEW \u2014 a provider budget write exists' END AS verdict\nFROM meta_budget_write_journal;";

/** Mirrors the doc's `\else` branch exactly — a static row, no query sent. */
export const BUDGET_WRITE_JOURNAL_ABSENT_ROW: ParsedReadbackRow = {
  section: "budget_write_journal",
  verdict: "PASS (pre-migration)",
};

/**
 * A single statement's result: the rows array directly — matching what THIS
 * repo's own `getDb()` wrapper returns from `db.query(text)`
 * (`lib/db.ts`'s `DbClient.query` is typed `Promise<TRow[]>`, an array, not
 * a `{rows}` envelope like raw `pg`). This is the ONLY thing
 * `runRuntimeReadback` needs from a database client, so it is injectable:
 * real callers pass `(sql) => db.query(sql)` directly; tests pass a
 * fixture-backed fake, no real connection required to prove the branching
 * logic.
 */
export type RuntimeQueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Runs every `RUNTIME_READBACK_SQL_STATEMENTS` entry plus the budget-write-
 * journal client-side branch, ONE statement per `query()` call (never a
 * batched multi-statement string), and maps every returned row into
 * `{section, verdict}` — reading the columns directly, no CSV round-trip.
 * A statement returning zero rows yields no row for that section (the pure
 * evaluator already treats "no row returned" as a named blocker, matching
 * the doc's own "empty is NOT a pass" contract for the top-level sections;
 * the `_offenders` sections are SUPPOSED to be empty when healthy).
 */
export async function runRuntimeReadback(query: RuntimeQueryFn): Promise<ParsedReadbackRow[]> {
  const rows: ParsedReadbackRow[] = [];
  for (const statement of RUNTIME_READBACK_SQL_STATEMENTS) {
    const resultRows = await query(statement.sql);
    for (const row of resultRows) {
      rows.push({ section: String(row.section), verdict: String(row.verdict) });
    }
  }

  const presenceRows = await query(BUDGET_WRITE_JOURNAL_PRESENCE_PROBE_SQL);
  const journalPresent = presenceRows[0]?.journal_present === true;
  if (journalPresent) {
    const resultRows = await query(BUDGET_WRITE_JOURNAL_PRESENT_SQL);
    for (const row of resultRows) {
      rows.push({ section: String(row.section), verdict: String(row.verdict) });
    }
  } else {
    rows.push(BUDGET_WRITE_JOURNAL_ABSENT_ROW);
  }

  return rows;
}

/**
 * The six-business control read, via the injected query function — same
 * SQL as `perBusinessControlQuery()`, run for real instead of through psql.
 */
export async function runRuntimePerBusinessQuery(query: RuntimeQueryFn): Promise<BusinessControlRow[]> {
  const resultRows = await query(perBusinessControlQuery());
  return resultRows.map((row) => ({
    business_id: String(row.business_id),
    auto_execution_enabled:
      row.auto_execution_enabled === null || row.auto_execution_enabled === undefined
        ? null
        : row.auto_execution_enabled === true,
    auto_execution_provider_account_id:
      row.auto_execution_provider_account_id == null
        ? null
        : String(row.auto_execution_provider_account_id),
  }));
}

/**
 * Combine both runtime reads into one verdict — the row-based sibling of
 * `evaluateAutomationCapabilityPreflight` above, which takes CSV text.
 * `null` for either input is UNKNOWN, never empty-and-passing, matching
 * that function's own contract exactly.
 */
export function evaluateAutomationCapabilityPreflightFromRows(input: {
  readbackRows: ReadonlyArray<ParsedReadbackRow> | null;
  businessRows: ReadonlyArray<BusinessControlRow> | null;
}): AutomationCapabilityPreflightResult {
  const blockers: string[] = [];
  let sectionsSeen: string[] = [];
  let perBusiness: PerBusinessVerdict[] = [];

  if (input.readbackRows === null) {
    blockers.push("readback_unreadable: the automation-off readback could not be executed");
  } else {
    const parsed = evaluateReadbackRows(input.readbackRows);
    sectionsSeen = parsed.sectionsSeen;
    blockers.push(...parsed.blockers);
  }

  if (input.businessRows === null) {
    blockers.push("target_businesses_unreadable: the six-business control read could not be executed");
  } else {
    const perBiz = evaluatePerBusinessRows(input.businessRows);
    perBusiness = perBiz.perBusiness;
    blockers.push(...perBiz.blockers);
  }

  return {
    contract: AUTOMATION_CAPABILITY_PREFLIGHT_CONTRACT,
    ok: blockers.length === 0,
    blockers,
    sectionsSeen,
    perBusiness,
  };
}
