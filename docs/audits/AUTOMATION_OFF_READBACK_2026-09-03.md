# Meta automation OFF — pre/post-deploy READ-ONLY readback

**2026-09-03, for the D077–D088 release candidate.**

Run this against production **before** the deploy and again **after** it. It
proves from production itself that automatic Meta execution is disabled for
every business; existing rows are not assumed OFF, they are measured.

It is SELECT-only, runs inside one `REPEATABLE READ READ ONLY` transaction with
a bounded statement timeout, and ends in `ROLLBACK`. It contains no INSERT,
UPDATE, DELETE, DDL, GRANT or provider call, so running it cannot change a
control row, a guardrail, a mode or a claim.

Every section returns a `verdict` column. Proceed only when every verdict is
`PASS` (or `PASS (pre-migration)` on the pre-deploy run). A section that returns
no rows is **not** a pass — the read did not happen; run it again.

> Kept as Markdown rather than a bare `.sql` file on purpose: the D081
> acceptance guard asserts that no untracked `.sql` file exists, because a new
> SQL file in this tree means a new migration. This is an operational readback,
> not a migration.

```sql
-- =====================================================================
-- Meta automation OFF — pre/post-deploy READ-ONLY readback
-- 2026-09-03, for the D077–D088 release candidate.
--
-- PURPOSE
--   Prove, from production itself, that automatic Meta execution is
--   disabled for EVERY business — before the deploy and again after it.
--   Existing rows are not assumed OFF: this measures them.
--
-- SAFETY
--   SELECT-only. Runs inside one REPEATABLE READ READ ONLY transaction
--   with a bounded statement timeout and ends in ROLLBACK. It contains no
--   INSERT, UPDATE, DELETE, DDL, GRANT, or provider call. Running it
--   cannot change a control row, a guardrail, a mode, or a claim.
--
-- HOW TO READ IT
--   Every section returns a `verdict` column. The deploy is safe to
--   proceed only when every verdict is 'PASS'. A section that returns no
--   rows is NOT a pass — it means the read did not happen; re-run it.
--
-- WHAT THIS CANNOT PROVE
--   The release gate `META_AUTOMATION_LIVE_WRITES` is an ENVIRONMENT
--   variable, not a database row. Section 7 tells you the exact command
--   to read it on the host. Without that check the database evidence is
--   incomplete: a business row could be OFF while the gate is open, or
--   the reverse.
-- =====================================================================

BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'automation_off_readback_2026_09_03';

-- 0. Prove this session really is read-only and isolated. ---------------
SELECT
  'transaction_posture'                       AS section,
  current_setting('transaction_read_only')    AS read_only,
  current_setting('transaction_isolation')    AS isolation,
  current_setting('statement_timeout')        AS statement_timeout,
  current_setting('application_name')         AS application_name,
  CASE
    WHEN current_setting('transaction_read_only') = 'on'
     AND current_setting('transaction_isolation') = 'repeatable read'
    THEN 'PASS' ELSE 'FAIL' END               AS verdict;

-- 1. THE MASTER SWITCH, per business. -----------------------------------
--    `auto_execution_enabled` is the business-wide master automatic-
--    execution flag. Budget is the only decision type with an automatic
--    executor today, and it reads this column.
--    `to_jsonb(c) ->> '<column>'` is used for columns this release ADDS, so
--    the same file runs unchanged before and after the migration: a column
--    that does not exist yet reads as NULL instead of aborting the read.
SELECT
  'master_switch'                                          AS section,
  count(*)                                                 AS control_rows,
  count(*) FILTER (WHERE c.auto_execution_enabled)         AS enabled_rows,
  count(*) FILTER (
    WHERE to_jsonb(c) ->> 'auto_execution_provider_account_id' IS NOT NULL
  )                                                        AS account_bound_rows,
  CASE WHEN count(*) FILTER (WHERE c.auto_execution_enabled) = 0
       THEN 'PASS' ELSE 'FAIL — see section 1b' END        AS verdict
FROM meta_automation_business_controls c;

-- 1b. If section 1 failed, these are the exact businesses. Empty is good.
SELECT
  'master_switch_offenders'                       AS section,
  b.id::text                                      AS business_id,
  b.name                                          AS business_name,
  c.auto_execution_enabled                        AS enabled,
  to_jsonb(c) ->> 'auto_execution_provider_account_id' AS activated_account,
  c.updated_by::text                              AS enabled_by,
  c.updated_at                                    AS enabled_at,
  'FAIL'                                          AS verdict
FROM meta_automation_business_controls c
JOIN businesses b ON b.id = c.business_id
WHERE c.auto_execution_enabled
ORDER BY b.name;

-- 2. THE DRY-RUN GUARDRAIL. `dryRunOnly` must not be false anywhere. -----
--    Absent is safe: the reader treats a missing key as TRUE.
SELECT
  'dry_run_guardrail'                                            AS section,
  count(*)                                                       AS control_rows,
  count(*) FILTER (WHERE guardrails_json ->> 'dryRunOnly' = 'false')
                                                                 AS lifted_rows,
  CASE WHEN count(*) FILTER (WHERE guardrails_json ->> 'dryRunOnly' = 'false') = 0
       THEN 'PASS' ELSE 'FAIL' END                               AS verdict
FROM meta_automation_business_controls;

-- 3. THE SECOND KEY: no decision type may stand at Tier 3 (auto). --------
SELECT
  'decision_type_modes'                              AS section,
  count(*)                                           AS mode_rows,
  count(*) FILTER (WHERE mode = 'auto')              AS auto_rows,
  count(*) FILTER (WHERE mode = 'auto' AND decision_type = 'budget')
                                                     AS budget_auto_rows,
  CASE WHEN count(*) FILTER (WHERE mode = 'auto') = 0
       THEN 'PASS' ELSE 'FAIL — see section 3b' END  AS verdict
FROM meta_automation_decision_type_modes;

-- 3b. Exact offenders. Empty is good.
SELECT
  'decision_type_mode_offenders'  AS section,
  business_id::text               AS business_id,
  decision_type,
  mode,
  updated_by::text                AS updated_by,
  updated_at,
  'FAIL'                          AS verdict
FROM meta_automation_decision_type_modes
WHERE mode = 'auto'
ORDER BY business_id, decision_type;

-- 4. THE READINESS TIER. `auto_execute` is the business-wide composite's
--    second condition; nothing should stand there before a deliberate
--    activation.
SELECT
  'readiness_tier'                                        AS section,
  count(*) FILTER (WHERE readiness_tier = 'auto_execute') AS auto_execute_rows,
  count(*) FILTER (WHERE kill_switch_engaged)             AS stopped_rows,
  CASE WHEN count(*) FILTER (WHERE readiness_tier = 'auto_execute') = 0
       THEN 'PASS' ELSE 'FAIL' END                        AS verdict
FROM meta_automation_business_controls;

-- 5. SCHEMA DEFAULTS. A new business must arrive OFF. --------------------
--    Pre-deploy the activated-account column does not exist yet; its verdict
--    is then 'PASS (pre-migration)'. Post-deploy it must be nullable with no
--    default, so an existing row enables nothing.
SELECT
  'schema_defaults'                                    AS section,
  max(column_default) FILTER (WHERE column_name = 'auto_execution_enabled')
                                                       AS auto_execution_default,
  count(*) FILTER (WHERE column_name = 'auto_execution_provider_account_id')
                                                       AS activated_account_present,
  max(is_nullable)    FILTER (WHERE column_name = 'auto_execution_provider_account_id')
                                                       AS activated_account_nullable,
  max(column_default) FILTER (WHERE column_name = 'auto_execution_provider_account_id')
                                                       AS activated_account_default,
  max(column_default) FILTER (WHERE column_name = 'readiness_tier')
                                                       AS readiness_tier_default,
  CASE
    WHEN max(column_default) FILTER (WHERE column_name = 'auto_execution_enabled') <> 'false'
      THEN 'FAIL'
    WHEN count(*) FILTER (WHERE column_name = 'auto_execution_provider_account_id') = 0
      THEN 'PASS (pre-migration)'
    WHEN max(is_nullable) FILTER (WHERE column_name = 'auto_execution_provider_account_id') = 'YES'
     AND max(column_default) FILTER (WHERE column_name = 'auto_execution_provider_account_id') IS NULL
      THEN 'PASS'
    ELSE 'FAIL' END                                    AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'meta_automation_business_controls';

-- 5b. The guardrails_json column DEFAULT must still ship dryRunOnly TRUE.
SELECT
  'schema_guardrail_default'                                       AS section,
  column_default                                                   AS guardrails_default,
  CASE WHEN column_default LIKE '%"dryRunOnly": true%'
       THEN 'PASS' ELSE 'FAIL' END                                 AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'meta_automation_business_controls'
  AND column_name = 'guardrails_json';

-- 6. NOTHING IN FLIGHT. A budget proposal must not be mid-execution
--    across the deploy.
SELECT
  'budget_queue'                                                    AS section,
  count(*)                                                          AS budget_proposals,
  count(*) FILTER (WHERE status = 'claimed')                        AS claimed,
  count(*) FILTER (WHERE status = 'reconcile')                      AS reconcile,
  count(*) FILTER (
    WHERE to_jsonb(p) ->> 'dispatch_started_at' IS NOT NULL
  )                                                                 AS dispatch_started,
  CASE WHEN count(*) FILTER (WHERE status IN ('claimed', 'reconcile')) = 0
       THEN 'PASS' ELSE 'FAIL' END                                  AS verdict
FROM meta_automation_proposals p
WHERE p.proposed_action = 'budget';

-- 6b. The write journal must hold no verified provider budget write.
--     A row here means a budget write already reached Meta.
--    THE JOURNAL TABLE IS CREATED BY THIS RELEASE, so it is ABSENT before the
--    deploy. A `to_regclass(...) IS NOT NULL` guard does NOT help: PostgreSQL
--    resolves every relation in a statement at PARSE time, before any runtime
--    condition is evaluated, so a statement that merely MENTIONS the missing
--    table aborts the transaction with 42P01 and every later section with it.
--
--    The guard therefore has to run in the CLIENT. `\gset` captures the answer
--    into a psql variable and `\if` selects which statement is ever sent, so
--    the absent table is never named on the pre-migration run.
SELECT (to_regclass('public.meta_budget_write_journal') IS NOT NULL)
       AS journal_present \gset

\if :journal_present
SELECT
  'budget_write_journal'                                     AS section,
  true                                                       AS table_present,
  count(*)                                                   AS journal_rows,
  count(*) FILTER (WHERE provider_attempted)                 AS provider_attempted,
  count(*) FILTER (WHERE result_class = 'verified')          AS verified_writes,
  CASE WHEN count(*) FILTER (WHERE provider_attempted) = 0
       THEN 'PASS' ELSE 'REVIEW — a provider budget write exists' END AS verdict
FROM meta_budget_write_journal;
\else
SELECT
  'budget_write_journal'   AS section,
  false                    AS table_present,
  0                        AS journal_rows,
  0                        AS provider_attempted,
  0                        AS verified_writes,
  'PASS (pre-migration)'   AS verdict;
\endif

ROLLBACK;

-- =====================================================================
-- 7. THE ENVIRONMENT GATE — not readable from SQL.
--
-- `META_AUTOMATION_LIVE_WRITES` must be UNSET or anything other than the
-- exact string "true" (case-insensitive, trimmed). While it is unset the
-- scheduled budget sweep returns `release_gate_closed` before it reads
-- the database at all, and every manual approval is forced to dry-run.
--
-- Read it on the host WITHOUT writing anything:
--
--   docker compose exec -T web \
--     node -e 'const v=process.env.META_AUTOMATION_LIVE_WRITES; \
--              console.log(JSON.stringify({present: v!==undefined, value: v ?? null}))'
--
--   grep -c '^META_AUTOMATION_LIVE_WRITES=' /var/www/adsecute/.env.production
--
-- PASS = `present:false` (and grep prints 0). Any other result means the
-- gate may be open and this readback's database verdicts are not enough.
--
-- Also confirm the incident switch is available:
--   grep -c '^META_ADS_WRITE_KILL_SWITCH=' /var/www/adsecute/.env.production
-- (Absent is fine — it is an opt-in emergency stop, not a gate.)
-- =====================================================================
```
