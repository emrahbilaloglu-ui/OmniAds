# Global sync rollout runbook

**Status: NOT EXECUTED. This describes the rollout; nothing here has been run
against production.**

## Why there is no canary

There is one user. A one-business canary would not reduce the blast radius —
it would run two schemas against one database while the same risk waits. What
replaces it is the ability to stop everything, verify, and resume in one
action. Every step below exists because of a specific failure this change could
otherwise cause.

## How this is actually run

**The production host has psql, docker and docker compose. It has no Node, no
npm and no `node_modules`.** So `npm run rollout:enable` cannot be run there, and
any instruction to do so is an instruction that cannot be followed. Everything
below is driven by `.github/scripts/hetzner-sync-cutover.sh`, which uses only
what the host has and reaches the repository's TypeScript by executing it inside
the already-pinned worker image with `/var/www/adsecute` bind-mounted.

It takes an `flock`, records each completed phase in a durable state file under
`/var/lib/adsecute-cutover`, and refuses to repeat a completed phase. An
interrupted cutover resumes; it does not restart.

```bash
DEPLOY_SHA=<exact commit sha> ./.github/scripts/hetzner-sync-cutover.sh preflight
```

Phases, in order: `preflight`, `quiesce`, `fingerprint-pre`, `migrate`,
`verify-contract`, `fingerprint-post`, `deploy-disabled`, `enable`,
`resume-scheduler`. Plus `emergency-disable` and `status`, which need no
predecessor.

**Preflight is old-schema safe on purpose.** It checks images, the env file, the
backup manifest, the scheduler and database identity — none of which depend on
the migration having run. The post-migration schema contract is its own phase,
`verify-contract`, after `migrate`. An earlier version ran that contract inside
preflight, which made the graph impossible to traverse: preflight required
objects the migration had not created yet, and migrate required preflight.

**The application and the database are on separate hosts.** The app host has the
Compose project and no local PostgreSQL socket; the database host has PostgreSQL
and no Compose project. Set `SYNC_CUTOVER_DB_SSH` to the database host; every
SQL statement and the backup-manifest check go there.

**Declare the scheduler.** `SYNC_CUTOVER_SCHEDULER` takes `systemd:<unit>`,
`cron:<file>`, `compose:<service>` or `none`. If it is unset the script tries to
detect one and REFUSES at preflight when it cannot — rather than accepting a
missing scheduler during quiesce and then requiring a nonexistent systemd unit
when resuming.

## Preconditions

- The branch is `codex/sync-reliability-isolated`, built from `c46d91c2a`.
- CI is green, including the three real-PostgreSQL seams
  (`test:provider-fixture-seam`, `test:sync-retention-seam`,
  `test:schema-upgrade-seam`) and `test:migrations-from-zero`.
- You have a restorable backup and have actually restored it somewhere.

## 1. Kill switch: stop every contract-violating writer

**What this switch does and does not cover.** It admits external-source
ingestion (Meta, Google, Shopify including its webhooks, GA4, Search Console),
the enqueue paths that create durable work, account-selection mutation, and
destructive retention. It does not claim to stop ordinary bookkeeping — request
logs, cache rows, derived decision records. For the migration's true zero-writer
interval the authority is step 2, physically stopping the processes; this switch
keeps work from RESUMING when they come back.

Lanes default to **off**. Nothing needs to be set to stop; something must be
set to start. Confirm the switch is absent or off everywhere:

```bash
grep -E 'ADSECUTE_SYNC_(GLOBAL|LANE)' .env.production || echo "no sync lane enabled"
```

Lanes: `meta_sync`, `google_sync`, `shopify_sync`, `source_ingest` (GA4,
Search Console), `cron_enqueue`, `assignment_mutation`, `retention`. The master switch is
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

Physical headroom is no longer something you transcribe. `adsecute-db-healthcheck.timer`
samples `/var/lib/postgresql` every 15 minutes into `system_capacity_snapshots`,
and the growth fence reads that row **in the same statement** as the logical
sizes. There is no environment variable to set, and there is no way to assert
free space the fence cannot check for itself.

Confirm the sampler is running and its latest row is fresh — the fence refuses
every write without one:

```bash
systemctl status adsecute-db-healthcheck.timer
```

```sql
SELECT id, sampled_at, now() - sampled_at AS age,
       payload->'database'->>'name' AS db,
       jsonb_path_query_first(payload, '$.disks[*] ? (@.path == "/var/lib/postgresql")') AS data_disk
FROM system_capacity_snapshots
WHERE source = 'db_host_healthcheck'
ORDER BY sampled_at DESC, id DESC
LIMIT 1;
```

Required: age under 35 minutes, `db` equal to the database the app connects to,
and `availableBytes` above 40 GiB — the concurrent index builds on the 19.8 GB
and 13.9 GB relations need room and WAL grows during them. The fence additionally
refuses if consuming the remaining logical budget would take free space below
that floor, so a raised budget cannot authorise growth the disk cannot hold.

## 4. Migrate

The migration is expand-only: additive columns, two new tables, new indexes.
Nothing is dropped, renamed, backfilled or rewritten, which is what makes it
safe to run while the old build could still theoretically read.

Run it from the pinned image — there is no `npm run migrate`, and no npm on the
host:

```bash
DEPLOY_SHA=<sha> ./.github/scripts/hetzner-sync-cutover.sh migrate
```

Watch for, in order:

- `migrations_preflight` — the resolved `lock_timeout` (15s by default) and the
  database/WAL sizes it started from.
- `CREATE INDEX CONCURRENTLY` on the two content-identity indexes. These are the
  long steps. They take SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE, so reads
  and writes continue — but they can take a long time on 19.8 GB.
- `migrations_schema_verified` with `verifiedObjects: 24`.
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
  expected**: the live database is 136.44 GiB against a 160 GiB budget whose
  85% band opens at 136.00 GiB. A quiet admission here would mean the budget is
  wrong, not that the database is healthy. 160 GiB is the largest budget whose
  band still fires today; anything larger starts silent, and anything smaller
  would be assuming the ~63 GiB config trio can be reclaimed, which it
  currently cannot — it has verified backups but no safe compaction path, and
  the cleanup planner ships no executor.
- Retention readiness must report ready.

### 160 GiB is a fail-closed cutover ceiling, not a sustainability claim

160 GiB is the largest whole-GiB ceiling whose 85% band is already active at
the current 136.439 GiB, and it sits below the ~210 GiB volume minus the 40 GiB
reserve. That is all it establishes. It does **not** mean this database is
sustainable:

- there is no measured post-fix daily growth rate, so there is no time-to-cap;
- filesystem bytes are not 1:1 with logical bytes, and the reason for the gap
  is not established;
- the config trio is 62.596 GiB against 24/24/23 GiB ceilings — 8.404 GiB of
  slack between them;
- that space cannot currently be reclaimed. The trio has verified backups but
  no safe compaction path, and the cleanup planner ships no executor.

The per-table ceilings are hard stops and stay. The system stops itself before
the hard limits, which is what replaces a canary here.

### Collect the growth baseline immediately after enabling

Without a canary, the measurement IS the safety net. Record a baseline within
minutes of enabling, then repeat on a schedule and compute the trend:

```sql
SELECT now() AS at,
       pg_database_size(current_database()) AS database_bytes,
       relname,
       pg_total_relation_size(c.oid) AS table_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE relname IN (
  'meta_config_snapshots','meta_campaign_config_history','meta_adset_config_history',
  'meta_raw_snapshots','shopify_raw_snapshots','meta_entity_state_history',
  'meta_raw_snapshot_observations','shopify_raw_snapshot_observations'
)
ORDER BY table_bytes DESC;
```

From two samples compute, and write down:

- bytes/day for the database and for each fenced table;
- **time-to-warning**: `(136.00 GiB − current) / bytes-per-day` — negative means
  already warning, which is expected;
- **time-to-hard-cap**: `(160 GiB − current) / bytes-per-day` for the aggregate,
  and the same per table against its own ceiling.

If time-to-hard-cap is short, the answer is to reduce what is written or to
solve compaction — not to raise the budget. Raising it removes the only signal
before refusal.

Enable every sync lane in one action (retention stays off):

Use the wrapper rather than hand-editing. It preserves every unrelated key in
`.env.production`, takes a checksummed backup, writes all six lanes or none, and
then recreates both containers from that same configuration:

```bash
DEPLOY_SHA=<sha> ./.github/scripts/hetzner-sync-cutover.sh enable
```

**The file change is not the runtime change.** A temp-file rename makes the FILE
change atomic; it does nothing for the runtime, because web and worker read their
environment when the container is created. The recreate is the runtime change,
and it is not atomic either — the two containers come up one after the other.
What makes that safe is that both are already running the new build with every
lane off, so the interval between them is two disabled processes rather than a
half-migrated one.

The wrapper then reads the EFFECTIVE container environment back (key presence
only, never values) to prove the recreate took effect, and refuses if retention
turned up enabled.

Re-enable the external scheduler LAST, once both processes are proven:

```bash
DEPLOY_SHA=<sha> ./.github/scripts/hetzner-sync-cutover.sh resume-scheduler
```

Then verify durable results, not just the absence of errors:

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

1. Stop everything:

   ```bash
   ./.github/scripts/hetzner-sync-cutover.sh emergency-disable
   ```

   It disables the scheduler and stops autoheal, web and worker — autoheal
   first, because it restarts unhealthy containers and would otherwise bring a
   stopped worker back. It reports success only after LIVE state is confirmed
   stopped; a command that returned 0 is not the same as nothing running. It
   needs no state file and no database, so it works when the cutover is
   half-done and when the database is unreachable.
2. If you must revert code, revert to a build that understands `is_selected`
   and receipts. If no such earlier build exists, the rollback is
   forward-only: fix and redeploy.
3. The schema does not need reverting. It is additive: extra columns and tables
   a reverted-but-compatible build ignores.
4. Restore from backup only if data is actually wrong. That loses everything
   written since the backup, so it is the last option, not the first.
