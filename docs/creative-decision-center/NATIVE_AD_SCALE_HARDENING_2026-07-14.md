# Native Ad Scale Hardening - 2026-07-14

## Trigger

The production native-ad shadow epoch exposed two systemic scheduling/runtime
defects during the all-business verification, beyond the four named audit
businesses:

- Bilsem Zeka: 3,133 native ads; decisions failed after 41,759 ms with
  `Database query timed out after 30000ms.`
- Enise: no assigned Meta account, but the Meta-native chain repeatedly ran and
  failed with an unproven empty hydration error.

The decision formulas, labels, authority rules, and engine versions are not
changed by this hardening.

## Read-only production diagnosis

The live tunnel was used with SELECT-only code paths. No cron, provider, or
database write was issued.

An exact Bilsem hydration replay with a diagnostic 120-second query timeout
resolved 3,136/3,136 manifest identities in 71,290 ms. Stage timings showed the
scale issue was distributed across multiple large statements:

| Stage                          |  Duration |
| ------------------------------ | --------: |
| Global present-state seed scan | 10,431 ms |
| Complete-manifest receipt      |  1,592 ms |
| Hydration SQL                  | 21,278 ms |
| Entity-state SQL               | 20,321 ms |

`EXPLAIN ANALYZE` showed the global seed path reading 240,283 shared blocks,
sorting 604,792 history rows with an external merge, and taking 8,388 ms. This
path was unnecessary when a complete current manifest already supplied the
exact ad identity set.

## Systemic fix

1. Complete manifests now drive present-state and hydration reads by exact ad
   identity instead of scanning the complete entity-state history.
2. The listed per-identity complete-manifest producer paths are bounded to 500
   identities per SQL statement: hydration, state, hysteresis lineage,
   evaluation persistence, snapshot persistence, previous snapshot reads, and
   change-event reconciliation. This does not claim that account-level receipt
   aggregation or the manifest-wide prune identity payload is batched. The
   incomplete-receipt fallback is also intentionally not covered by this bound;
   see the limitation below.
3. Complete-manifest state reads use the full binding identity (business,
   provider-account reference, external account ID, and ad ID) and a lower
   capture boundary anchored to the receipt generation. A pre-generation
   tombstone cannot override a present row captured by the current complete
   run merely because the tombstone has a later provider-observed timestamp.
4. The first complete-manifest state read is reused as status evidence; it is
   not queried a second time.
5. Every batch shares one `REPEATABLE READ` transaction snapshot. Any later
   failure rolls back all earlier batches, preserving daily snapshot
   atomicity.
6. Snapshot lookup, persistence, and change-event reconciliation use the full
   provider-account-reference plus scope identity, preventing historical
   external-account reuse from associating rows across bindings.
7. Incomplete/unproven manifests retain the existing fail-closed fallback. The
   optimization does not manufacture completeness.
8. The native Meta scheduler now admits only active, engine-enabled businesses
   with an actual `business_provider_accounts.provider = 'meta'` binding.
   Unbound businesses no longer create false native-chain failures.

### Conditional limitation retained by design

When a same-day complete receipt is missing or unproven and no explicit ad
filter was requested, hydration still uses the pre-existing account-wide
fallback. That statement can remain large and may time out for a large account.
It is deliberately non-authoritative and fail-closed: it cannot prune or turn
missing source proof into a high-confidence decision. This release hardens the
normal complete-manifest producer path; it does not claim unconditional scale
for an incomplete producer epoch.

## Verification evidence

The optimized Bilsem SELECT-only hydration replay succeeded with the production
30-second per-statement limit:

- 3,136 expected
- 3,136 hydrated
- authoritative manifest: true
- total hydration time: 48,181 ms
- no individual statement timeout

The real-PostgreSQL seam now proves both sides of the critical boundary:

- 501 identities hydrate through the production `WarehouseDataSource` path
  with a 501/501 authoritative receipt while a pre-generation tombstone exists;
- a forced failure on the 501st change-event row proves two separate insert
  statements (`500 + 1`) were attempted, the first 500 rows roll back, no
  failed-job authority rows survive, the durable job attempt is marked failed,
  and the 501-row prior-day baseline remains intact.

Focused unit coverage currently passes 106 tests across six files. It proves
the `500 + 1` boundary for hydration/state, evaluation, snapshot, hysteresis,
and change-event paths; missing receipt timestamps fail closed; reused external
account/ad identities remain isolated by provider-account reference; and a
fully Meta-unbound cohort stops before history/job work. Typecheck, lint, the
real-PostgreSQL seam, and `git diff --check` also pass at this review checkpoint.
Full repository gates and post-deploy natural-schedule evidence are recorded in
the release PR.

## Pre-commit closure - 2026-07-15

The first independent Claude Code review returned `STOP_AND_FIX` for the
generation-window tombstone mismatch and the lack of real-PostgreSQL batching
and rollback proof. Those findings were reproduced independently. The proposed
relaxation of complete-manifest state coverage was rejected because it would
weaken the current-generation contract; the implementation instead added the
exact provider-account reference and receipt capture boundary.

After the fixes, a fresh Claude Code session re-read the required documents,
inspected the current diff, ran local gates and a separate PostgreSQL isolation
probe, found no P1/P2, and returned `CONTINUE`. Non-blocking review notes were
resolved or bounded: the READ COMMITTED compatibility retry is now documented
as outside the native job's REPEATABLE READ concurrency path, the incomplete
fallback and manifest-wide exceptions to the 500-row statement claim are
explicit, and focused test counts are current.

Final pre-commit gates after the last provider-reference prune fix:

- full Vitest: 573 files passed, 4 skipped; 4,861 tests passed, 61 skipped,
  61 todo;
- six focused native files: 106 tests passed;
- `npm run typecheck`: passed;
- `npm run lint`: passed;
- `npm run test:migrations-from-zero`: passed twice against a fresh PostgreSQL
  cluster (from-zero and idempotent replay);
- `node --import tsx scripts/ephemeral-postgres-native-ad-decision-seam.ts`:
  passed the generation-bound 501-row hydration and distinct 500+1 statement
  rollback proof;
- `npm run build`: passed; 220 routes;
- release-authority preflight and Creative V2 archive safety: passed;
- `git diff --check`: passed.

This section records pre-commit evidence only. Exact commit/PR/CI, deploy SHA,
and passive natural-scheduler SELECT-only evidence remain release-stage proof.
