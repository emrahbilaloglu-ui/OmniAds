/**
 * PRE-DEPLOY AUDIT — the D088 budget schema, proven rather than attempted.
 *
 * Every statement that builds the budget-write schema swallows its own error,
 * which is the right default for a re-runnable DDL registry and the wrong one
 * for objects a provider WRITE depends on. A lock race on any of them would be
 * reported as a successful migration, and the application would then start
 * against a schema that cannot support the feature — the action constraint
 * would reject every budget proposal, or the occurrence index would be absent
 * and idempotency would stop being enforced by the database.
 *
 * This is the postcondition. It runs immediately after the registry and it
 * THROWS, so a migration that could not build the schema is not announced as
 * migrated.
 *
 * ## What the previous version could not see
 *
 * It checked NINE journal columns by name. The table has 26, and the ones it
 * skipped are the ones a half-applied migration actually costs you: the
 * currency and its exponent (a wrong exponent moves money by a factor of 100),
 * the actor, the request fingerprint, the three timestamps, and the three
 * safety DEFAULTS — `provider_attempted`, `rollback_eligible` and
 * `blockers_json` — each of which is the value the runtime relies on when it
 * inserts a row without naming the column. It checked no TYPE and no
 * NULLABILITY at all, so a `before_amount_minor` created NOT NULL (which would
 * make every unknown-before write fail) or a `currency_exponent` created as
 * `text` both passed. It never looked for `idx_meta_budget_write_journal_entity`,
 * so the index the state-latest read depends on could be absent while the
 * migration reported success.
 *
 * And two constraint checks were scoped to nothing but a NAME:
 * `SELECT count(*) FROM pg_constraint WHERE conname = '…'` is satisfied by a
 * constraint of that name on ANY table in ANY schema in the database. A
 * same-named constraint left on a scratch or restored table therefore proved
 * the real one existed. Every constraint here is now resolved through
 * `pg_class`/`pg_namespace` to the exact schema and table it must sit on.
 *
 * ## What it deliberately does NOT do
 *
 * It does not fail on columns beyond the 26 required ones. A lock race can
 * leave a column MISSING or wrong; it cannot invent one. Failing on extras
 * would turn every future additive migration into a false alarm, and a check
 * that cries wolf is a check someone eventually weakens.
 */
import type { getDb } from "@/lib/db";

export const D088_BUDGET_SCHEMA_CONTRACT =
  "meta.d088-budget-schema-verification.v2" as const;

/**
 * The complete `meta_budget_write_journal` column contract.
 *
 * `type` is the `information_schema.columns.data_type` spelling. `nullable`
 * and `defaultContains` are stated only where they are DECISION-RELEVANT, and
 * every one that is stated is explained:
 *
 *  - the three amount columns: `before` and `readback` MUST be nullable,
 *    because "we could not read it" is a real state and a NOT NULL column
 *    would force a fabricated zero; `intended` must NOT be, because a write
 *    with no intended amount is not a write;
 *  - `provider_attempted`, `rollback_eligible`: FALSE defaults. These are the
 *    values an INSERT that omits them takes, and both are safety-negative —
 *    "we did not call the provider", "this cannot be rolled back";
 *  - `blockers_json`: an empty ARRAY default, so a reader never has to
 *    distinguish null from "no blockers";
 *  - `parent_campaign_id`, `provider_http_status`, `rolled_back_at`,
 *    `completed_at`: nullable, because each is genuinely absent on a real row.
 */
export const D088_JOURNAL_COLUMN_CONTRACT = [
  { name: "id", type: "uuid", nullable: false, defaultContains: "gen_random_uuid" },
  { name: "contract", type: "text", nullable: false },
  { name: "proposal_id", type: "uuid", nullable: false },
  { name: "idempotency_key", type: "text", nullable: false },
  // CHAR(64): a sha256 hex digest, fixed width by construction.
  { name: "request_fingerprint", type: "character", nullable: false, maxLength: 64 },
  { name: "business_id", type: "text", nullable: false },
  { name: "provider_account_id", type: "text", nullable: false },
  { name: "owner_grain", type: "text", nullable: false },
  { name: "entity_id", type: "text", nullable: false },
  { name: "parent_campaign_id", type: "text", nullable: true },
  { name: "budget_field", type: "text", nullable: false },
  { name: "currency", type: "text", nullable: false },
  { name: "currency_exponent", type: "smallint", nullable: false },
  { name: "actor_user_id", type: "uuid", nullable: false },
  { name: "before_amount_minor", type: "bigint", nullable: true },
  { name: "intended_amount_minor", type: "bigint", nullable: false },
  { name: "readback_amount_minor", type: "bigint", nullable: true },
  { name: "provider_attempted", type: "boolean", nullable: false, defaultContains: "false" },
  { name: "provider_http_status", type: "integer", nullable: true },
  { name: "result_class", type: "text", nullable: false },
  { name: "blockers_json", type: "jsonb", nullable: false, defaultContains: "[]" },
  { name: "rollback_eligible", type: "boolean", nullable: false, defaultContains: "false" },
  { name: "rolled_back_at", type: "timestamp with time zone", nullable: true },
  { name: "requested_at", type: "timestamp with time zone", nullable: false },
  { name: "completed_at", type: "timestamp with time zone", nullable: true },
  { name: "created_at", type: "timestamp with time zone", nullable: false, defaultContains: "now()" },
] as const;

/** Kept for callers that only need the names. */
export const D088_JOURNAL_REQUIRED_COLUMNS =
  D088_JOURNAL_COLUMN_CONTRACT.map((column) => column.name);

/** `[index name, unique?, ordered column expressions]`. */
export const D088_JOURNAL_INDEX_CONTRACT = [
  {
    name: "meta_budget_write_journal_occurrence",
    unique: true,
    columns: ["business_id", "provider_account_id", "idempotency_key"],
    why: "ONE attempt per idempotency key per account — the constraint the orchestrator loses a concurrent race against",
  },
  {
    name: "idx_meta_budget_write_journal_entity",
    unique: false,
    columns: [
      "business_id", "provider_account_id", "owner_grain", "entity_id",
      "requested_at DESC", "id DESC",
    ],
    why: "the state-latest read, which touches the most rows of any readiness statement",
  },
] as const;

/** `[constraint name, the exact table it must sit on]`. */
export const D088_SCOPED_CONSTRAINT_CONTRACT = [
  {
    name: "meta_automation_proposals_action_budget_check",
    table: "meta_automation_proposals",
    mustContain: ["'pause'", "'resume'", "'bid'", "'duplicate'", "'budget'"],
    why: "without it the database rejects every budget proposal",
  },
  {
    name: "meta_automation_proposals_budget_envelope_check",
    table: "meta_automation_proposals",
    mustContain: ["budget_envelope_json"],
    why: "a budget proposal with no envelope is not executable",
  },
  {
    name: "meta_budget_write_journal_rollback_check",
    table: "meta_budget_write_journal",
    mustContain: ["rollback_eligible", "before_amount_minor"],
    why: "a row may not claim it is rollback-eligible without the value it would restore",
  },
] as const;

export interface D088SchemaVerification {
  contract: typeof D088_BUDGET_SCHEMA_CONTRACT;
  verified: string[];
}

export class D088BudgetSchemaError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(`D088 budget schema verification failed: ${failures.join("; ")}`);
    this.name = "D088BudgetSchemaError";
    this.failures = failures;
  }
}

type Sql = Pick<ReturnType<typeof getDb>, "query">;

/** Normalise an index definition for comparison: one space, no schema noise. */
function indexColumns(indexdef: string): string[] {
  const open = indexdef.lastIndexOf("(");
  const close = indexdef.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  return indexdef
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

export async function assertD088BudgetSchema(sql: Sql): Promise<D088SchemaVerification> {
  const failures: string[] = [];
  const verified: string[] = [];

  // ── 1. the activation column: present, TEXT, nullable, no default ────────
  const activation = (await sql.query<{
    data_type: string; is_nullable: string; column_default: string | null;
  }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'meta_automation_business_controls'
        AND column_name = 'auto_execution_provider_account_id'`,
  )) as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
  if (activation.length !== 1) {
    failures.push(
      "meta_automation_business_controls.auto_execution_provider_account_id is absent",
    );
  } else {
    const column = activation[0]!;
    if (column.data_type !== "text") {
      failures.push(
        `auto_execution_provider_account_id is ${column.data_type}, not text`,
      );
    }
    if (column.is_nullable !== "YES") {
      failures.push("auto_execution_provider_account_id must be nullable: unactivated is unknown");
    }
    if (column.column_default !== null) {
      failures.push(
        `auto_execution_provider_account_id must have no default, found ${String(column.column_default)}`,
      );
    }
    verified.push("auto_execution_provider_account_id (text, nullable, no default)");
  }

  // ── 2. the master switch keeps its FALSE default and NOT NULL ────────────
  const master = (await sql.query<{ is_nullable: string; column_default: string | null }>(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'meta_automation_business_controls'
        AND column_name = 'auto_execution_enabled'`,
  )) as Array<{ is_nullable: string; column_default: string | null }>;
  if (master.length !== 1) {
    failures.push("meta_automation_business_controls.auto_execution_enabled is absent");
  } else {
    if (master[0]!.is_nullable !== "NO") failures.push("auto_execution_enabled must be NOT NULL");
    if ((master[0]!.column_default ?? "").toLowerCase() !== "false") {
      failures.push(
        `auto_execution_enabled default is ${String(master[0]!.column_default)}, not false`,
      );
    }
    verified.push("auto_execution_enabled default");
  }

  // ── 3. the proposal envelope column ──────────────────────────────────────
  const envelope = (await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'meta_automation_proposals'
        AND column_name = 'budget_envelope_json'`,
  )) as Array<{ n: string }>;
  if (Number(envelope[0]?.n ?? 0) !== 1) {
    failures.push("meta_automation_proposals.budget_envelope_json is absent");
  } else verified.push("budget_envelope_json");

  // ── 4. every constraint, resolved to its EXACT schema and table ──────────
  const constraints = (await sql.query<{ conname: string; relname: string; def: string }>(
    `SELECT c.conname, t.relname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND c.contype = 'c'
        AND t.relname IN ('meta_automation_proposals', 'meta_budget_write_journal')`,
  )) as Array<{ conname: string; relname: string; def: string }>;
  for (const required of D088_SCOPED_CONSTRAINT_CONTRACT) {
    const onTheRightTable = constraints.find(
      (row) => row.conname === required.name && row.relname === required.table,
    );
    if (!onTheRightTable) {
      /*
        Named precisely, because the previous check would have PASSED here:
        a constraint of this name on a different table satisfied a bare
        `WHERE conname = …`, so this exact absence read as present.
      */
      const elsewhere = constraints.find((row) => row.conname === required.name);
      failures.push(
        `${required.name} is absent from ${required.table}`
        + (elsewhere ? ` (a same-named constraint exists on ${elsewhere.relname})` : "")
        + ` — ${required.why}`,
      );
      continue;
    }
    for (const fragment of required.mustContain) {
      if (!onTheRightTable.def.includes(fragment)) {
        failures.push(
          `${required.name} does not constrain ${fragment}: ${onTheRightTable.def}`,
        );
      }
    }
    verified.push(`${required.table}.${required.name}`);
  }

  // No NARROWER legacy action check may still stand beside the widened one.
  const legacyCheck = constraints.filter(
    (row) =>
      row.relname === "meta_automation_proposals"
      && row.def.includes("duplicate")
      && !row.def.includes("budget"),
  );
  if (legacyCheck.length > 0) {
    failures.push(
      `a narrow legacy action constraint still stands: ${legacyCheck.map((r) => r.conname).join(", ")}`,
    );
  } else verified.push("no narrow legacy action constraint");

  // ── 5. the write journal's COMPLETE column contract ──────────────────────
  const journalColumns = (await sql.query<{
    column_name: string; data_type: string; is_nullable: string;
    column_default: string | null; character_maximum_length: number | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'meta_budget_write_journal'`,
  )) as Array<{
    column_name: string; data_type: string; is_nullable: string;
    column_default: string | null; character_maximum_length: number | null;
  }>;
  if (journalColumns.length === 0) {
    failures.push("meta_budget_write_journal is absent");
  } else {
    const byName = new Map(journalColumns.map((row) => [row.column_name, row]));
    for (const required of D088_JOURNAL_COLUMN_CONTRACT) {
      const found = byName.get(required.name);
      if (!found) {
        failures.push(`meta_budget_write_journal.${required.name} is absent`);
        continue;
      }
      if (found.data_type !== required.type) {
        failures.push(
          `meta_budget_write_journal.${required.name} is ${found.data_type}, not ${required.type}`,
        );
      }
      const isNullable = found.is_nullable === "YES";
      if (isNullable !== required.nullable) {
        failures.push(
          `meta_budget_write_journal.${required.name} is ${isNullable ? "nullable" : "NOT NULL"},`
          + ` expected ${required.nullable ? "nullable" : "NOT NULL"}`,
        );
      }
      if ("maxLength" in required && found.character_maximum_length !== required.maxLength) {
        failures.push(
          `meta_budget_write_journal.${required.name} width is`
          + ` ${String(found.character_maximum_length)}, expected ${String(required.maxLength)}`,
        );
      }
      if ("defaultContains" in required) {
        const actual = found.column_default ?? "";
        if (!actual.includes(required.defaultContains as string)) {
          failures.push(
            `meta_budget_write_journal.${required.name} default is ${actual || "absent"},`
            + ` expected one containing ${String(required.defaultContains)}`,
          );
        }
      }
    }
    verified.push(
      `meta_budget_write_journal (${D088_JOURNAL_COLUMN_CONTRACT.length} required columns,`
      + ` ${journalColumns.length} present)`,
    );
  }

  // ── 6. both journal indexes, by definition rather than by existence ──────
  const indexes = (await sql.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'meta_budget_write_journal'`,
  )) as Array<{ indexname: string; indexdef: string }>;
  for (const required of D088_JOURNAL_INDEX_CONTRACT) {
    const found = indexes.find((row) => row.indexname === required.name);
    if (!found) {
      failures.push(`${required.name} is absent — ${required.why}`);
      continue;
    }
    const isUnique = /CREATE UNIQUE INDEX/i.test(found.indexdef);
    if (isUnique !== required.unique) {
      failures.push(
        `${required.name} is ${isUnique ? "UNIQUE" : "not UNIQUE"},`
        + ` expected ${required.unique ? "UNIQUE" : "not UNIQUE"}: ${found.indexdef}`,
      );
    }
    /*
      Ordered comparison, not membership. `(a, b, c)` and `(c, b, a)` are
      different indexes: the second cannot serve a prefix lookup on `a`, and
      for the entity index the trailing `requested_at DESC, id DESC` is the
      whole point — it is what makes "latest per entity" a scan of one row.
    */
    const actual = indexColumns(found.indexdef);
    const expected = [...required.columns];
    if (actual.length !== expected.length || actual.some((column, at) => column !== expected[at])) {
      failures.push(
        `${required.name} columns are (${actual.join(", ")}), expected (${expected.join(", ")})`,
      );
    }
    verified.push(`${required.name}${required.unique ? " (unique)" : ""}`);
  }

  /*
    ── 7. ROLLBACK COMPATIBILITY ──────────────────────────────────────────
    The campaign-context table must still carry the legacy three-column unique
    the PREVIOUS production image upserts on. A partial index cannot satisfy a
    bare `ON CONFLICT (business_id, campaign_id, as_of_date)`, so dropping it
    made the migration one-way.
  */
  const legacyUnique = (await sql.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = 'engine_v3_campaign_context_daily'
        AND c.contype = 'u'
        AND pg_get_constraintdef(c.oid) = 'UNIQUE (business_id, campaign_id, as_of_date)'`,
  )) as Array<{ def: string }>;
  if (legacyUnique.length !== 1) {
    failures.push(
      "engine_v3_campaign_context_daily lost UNIQUE (business_id, campaign_id, as_of_date) — the previous image could not upsert",
    );
  } else verified.push("campaign-context legacy unique (rollback compatibility)");

  if (failures.length > 0) throw new D088BudgetSchemaError(failures);
  return { contract: D088_BUDGET_SCHEMA_CONTRACT, verified };
}
