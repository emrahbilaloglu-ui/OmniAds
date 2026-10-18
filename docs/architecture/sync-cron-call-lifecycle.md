# Normal cron caller lifecycle

D194 addresses a completed public latency pass whose whole cron response was lost
at the caller's existing five-minute deadline while native jobs kept running.
The new operator is `scripts/operator/sync-cron-call-lifecycle.py`; it defaults to
inspection and never calls the sync endpoint.

After exact CI, normal deployment, compatible runtime installation and source
review, ship the exact reviewed operator to a root-private host path. Inspect it
without `--apply`. Keep the returned current/proposed/outside hashes, the source
SHA and all three role build identities in the release evidence.

Applying requires `--apply`, `--expected-crontab-sha`,
`--expected-operator-sha` and `--expected-build`. The operator reads the pre-state
again, verifies current credentials without printing them, saves the original
root crontab at a private path, performs one atomic crontab replacement and reads
back its exact bytes. Never print the command, bearer token, environment or backup.
It refuses an already guarded block; inspection remains idempotent.

The schedule stays every ten minutes. A nonblocking root-owned file lock admits
one normal caller. The shell opens the response log only after obtaining that
lock. A skipped tick exits75 and leaves the in-flight log untouched. The client
deadline becomes24minutes; individual native jobs still require investigation
when running longer than15minutes. On a long pass, subsequent scheduled ticks can
be delayed; configured cadence is not proof of provider or decision freshness.
The next normal tick after release must prove actual progress. Do not force one.

Independently inspect the configured block after apply. Observe a natural pass,
the full private response summary without storing names/customer data, public
status/workspace/evidence5/5/2s and exact generation/manifest/hash/no-store/cleanup.
Final native acceptance still requires a positive job starting after the final
runtime/index/configuration boundary, its valid positive calibration dependency,
natural Meta success, durable Shopify success window and current non-overridden
capacity. No healthy-process or old-generation substitution.

Rollback compares the current full crontab SHA against the installed receipt,
then restores the recorded private original and independently checks its SHA.
If another actor changed the crontab, refuse and reconcile; preserve other work.
An application rollback must retain the matching reference-aware runtime and
permanent erasure configuration. No data, archive, key or index rollback is needed.
