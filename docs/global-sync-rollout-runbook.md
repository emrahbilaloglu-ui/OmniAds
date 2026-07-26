# Global sync rollout runbook

**Status: NOT EXECUTED. This describes the rollout; nothing here has been run
against production.**

## Why there is no canary

There is one user. A one-business canary would not reduce the blast radius —
it would run two schemas against one database while the same risk waits. What
replaces it is the ability to stop everything, verify, and resume in one
action. Every step below exists because of a specific failure this change could
otherwise cause.

## Preconditions

- The branch is `codex/sync-reliability-isolated`, built from `c46d91c2a`.
- CI is green, including the three real-PostgreSQL seams
  (`test:provider-fixture-seam`, `test:sync-retention-seam`,
  `test:schema-upgrade-seam`) and `test:migrations-from-zero`.
- You have a restorable backup and have actually restored it somewhere.

## 1. Kill switch: stop everything that writes

Lanes default to **off**. Nothing needs to be set to stop; something must be
set to start. Confirm the switch is absent or off everywhere:

```bash
grep -E 'ADSECUTE_SYNC_(GLOBAL|LANE)' .env.production || echo "no sync lane enabled"
```

Lanes: `meta_sync`, `google_sync`, `shopify_sync`, `cron_enqueue`,
`assignment_mutation`, `retention`. The master switch is
`ADSECUTE_SYNC_GLOBAL_ENABLED=enabled` and each lane additionally needs
`ADSECUTE_SYNC_LANE_<LANE>_ENABLED=enabled`. The master switch is deliberately
not a blanket grant, so resuming sync cannot resume retention.

Also disable the external cron trigger. An in-process switch stops the work;
it does not stop something calling the endpoint.

## 2. Quiesce ALL old writers together

Do **not** roll hosts one at a time. During the `is_selected` cutover the
column default is TRUE for exactly as long as it takes to prove the column and
flip it to FALSE; an old writer inserting a binding outside that window is the
one case the ordering cannot protect. More generally, an old host writing raw
snapshots while the new schema exists produces rows with no `content_key` that
are indistinguishable from genuine legacy rows.

Stop every web and worker process, then prove nothing holds a lease and
nothing is mid-flight:

```sql
SELECT count(*) FILTER (WHERE lease_owner IS NOT NULL) AS meta_leases FROM meta_sync_partitions;
SELECT count(*) FILTER (WHERE lease_owner IS NOT NULL) AS google_leases FROM google_ads_sync_partitions;
SELECT count(*) FROM sync_runner_leases WHERE lease_expires_at > now();
SELECT count(*) FROM provider_sync_jobs WHERE status = 'running';
SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'omniads%' AND state <> 'idle';
```

All five must be zero. If a lease is held by a process you have already
stopped, wait for expiry rather than clearing it by hand — clearing a lease a
live process still believes it holds is how two workers end up on one
partition.

## 3. Backup and fingerprints

Take a backup, then verify it by restoring to a scratch database. An unverified
backup is not a rollback plan.

Record, before and after, so the migration can be shown not to have changed
anything it should not have:

```sql
SELECT current_database(), system_identifier FROM pg_control_system();
SELECT pg_database_size(current_database());
SELECT relname, pg_relation_filenode(oid), pg_total_relation_size(oid)
FROM pg_class WHERE relname IN ('meta_raw_snapshots','shopify_raw_snapshots');
SELECT count(*) FROM meta_raw_snapshots;
SELECT count(*) FROM shopify_raw_snapshots;
SELECT count(*), count(*) FILTER (WHERE is_selected) FROM business_provider_accounts;
```

Preflight the host. The application cannot see the database host's filesystem,
so this has to be read on the host itself:

```bash
df -B1 /var/lib/postgresql
du -sb /var/lib/postgresql/*/main/pg_wal
```

Free space must exceed 40 GiB — the concurrent index builds on the 19.8 GB and
13.9 GB relations need room, and WAL will grow during them. Pass the measured
value to the application so the fence stops reporting volume headroom as
unknown:

```
SYNC_GROWTH_FENCE_VOLUME_AVAILABLE_BYTES=<bytes from df>
SYNC_GROWTH_FENCE_VOLUME_CAPACITY_BYTES=<bytes from df>
```

## 4. Migrate

The migration is expand-only: additive columns, two new tables, new indexes.
Nothing is dropped, renamed, backfilled or rewritten, which is what makes it
safe to run while the old build could still theoretically read.

```bash
npm run migrate
```

Watch for, in order:

- `migrations_preflight` — the resolved `lock_timeout` (15s by default) and the
  database/WAL sizes it started from.
- `CREATE INDEX CONCURRENTLY` on the two content-identity indexes. These are the
  long steps. They take SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE, so reads
  and writes continue — but they can take a long time on 19.8 GB.
- `migrations_schema_verified` with `verifiedObjects: 22`.
- `migrations_completed`.

If it fails, it fails loudly and completion is not announced. Re-run it: the
migration is idempotent and repairs an index left INVALID by an interrupted
concurrent build rather than silently accepting it. This is proven by U7 and U9
in the upgrade seam.

Then confirm by hand what the verifier asserted:

```sql
SELECT indexrelid::regclass, indisvalid, indisready, indislive
FROM pg_index
WHERE indexrelid::regclass::text IN (
  'meta_raw_snapshots_content_identity',
  'shopify_raw_snapshots_content_identity',
  'idx_business_provider_accounts_selected'
);
SELECT count(*) FILTER (WHERE is_selected) FROM business_provider_accounts;
SELECT column_default FROM information_schema.columns
WHERE table_name = 'business_provider_accounts' AND column_name = 'is_selected';
```

Every index valid/ready/live, the selected count equal to what you recorded in
step 3, and the default `false`.

## 5. Deploy everywhere, still disabled

Deploy the new web and worker to every host with all lanes still off. The new
build understands both shapes: legacy rows with NULL `content_key` read as a
single self-observation, and resume falls back to the legacy partition column.

Only once **no old process remains** is the selection contract fully settled.
Until then the DEFAULT FALSE is the only thing standing between an old writer
and a silently deselected account, which is why step 2 is a hard barrier rather
than a rolling restart.

## 6. Verify, then enable everything in one action

Before enabling anything:

```bash
curl -fsS "$BASE_URL/api/healthz"
curl -fsS "$BASE_URL/api/build-info"
```

Then check readiness with lanes still off — the growth fence and the retention
readiness contract both evaluate without any lane being enabled:

- The fence must report `allowed: true` with `warning: true`. **Warning is
  expected**: the live database is 136.45 GiB against a 150 GiB budget and the
  85% band opens at 127.5 GiB. A quiet admission here would mean the budget is
  wrong, not that the database is healthy.
- Retention readiness must report ready.

Enable every sync lane in one action (retention stays off):

```
ADSECUTE_SYNC_GLOBAL_ENABLED=enabled
ADSECUTE_SYNC_LANE_META_SYNC_ENABLED=enabled
ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED=enabled
ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED=enabled
ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED=enabled
ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED=enabled
```

Re-enable the external cron trigger. Then verify durable results, not just the
absence of errors:

```sql
-- New writes are two-layer, and legacy rows are untouched.
SELECT count(*) FILTER (WHERE content_key IS NOT NULL) AS modern,
       count(*) FILTER (WHERE content_key IS NULL) AS legacy
FROM meta_raw_snapshots;
SELECT count(*) FROM meta_raw_snapshot_observations;

-- Historical days write no current evidence. These must not grow while a
-- backfill runs.
SELECT count(*) FROM meta_entity_state_history;
SELECT count(*) FROM meta_campaign_config_history;

-- Partitions complete rather than sitting leased.
SELECT status, count(*) FROM meta_sync_partitions GROUP BY status;
```

Watch for `[db-growth-fence] admitted with warning` — expected — and for
`account_authority_unknown` or `meta_account_selection_revoked`, which are not.
A revocation on an account you believe is selected means the cutover did not
land as intended; stop and re-check step 4.

## 7. Retention stays dry-run

`ADSECUTE_SYNC_LANE_RETENTION_ENABLED` stays unset. Retention is the only path
that deletes, and its first production run should be argued for separately with
its own evidence. The legacy cleanup planner is plan-only and ships no
executor, so it cannot delete regardless.

## Rollback

**The rollback target is a forward-compatible build, not `c46d91c2a`.**

Once the new build has written anything, the old build cannot correctly read
it. New canonical rows carry no `partition_id` — attribution lives on receipts
the old code does not know about — so old resume finds nothing and re-fetches
work that was already done, and old retention cannot attribute those rows at
all. A deselected account is invisible to a build that does not know
`is_selected` exists, so it would resume syncing.

To roll back:

1. Turn off every lane (the kill switch alone is the fastest safe action, and is
   usually enough — it stops the writing without touching the schema).
2. If you must revert code, revert to a build that understands `is_selected`
   and receipts. If no such earlier build exists, the rollback is
   forward-only: fix and redeploy.
3. The schema does not need reverting. It is additive: extra columns and tables
   a reverted-but-compatible build ignores.
4. Restore from backup only if data is actually wrong. That loses everything
   written since the backup, so it is the last option, not the first.
