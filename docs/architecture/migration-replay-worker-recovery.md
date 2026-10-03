# Completed migration replay and previous-worker recovery

The October 3 PR339 attempt failed before applying R1 or recreating services.
It asked for a state-history build/WAL reserve despite all five receipt-related
indexes already satisfying their exact public catalog contracts. The measured
6,243,614,720-byte relation required 61,680,517,120 bytes including the existing
40 GiB floor; the sample had 58,262,749,184 bytes. Refusing a genuine build at
that measurement is correct. Requiring that reserve for a completed replay is
not. The failed attempt also left its stopped previous worker down while the
workflow restored the scheduler.

The migration now omits that particular heavy-step reservation only when all
five indexes match the expected table and complete PostgreSQL definition and
are valid, ready and live. Missing, unknown, invalid, partial, nonunique,
different-key or otherwise mismatched evidence keeps the original physical
guard before any repair. Ordinary size measurements, repair steps, unswallowed
postconditions and the source growth fence remain. No capacity limit, override,
receipt format, provider authority or decision identity changes.

The actual migration phase records the immutable identity/configuration of its
previous running worker, then stops that exact container. A failed migration or
caught TERM/INT/HUP starts that existing container at most once, with no image
pull, recreation or environment change, and preserves the original failure.
Changed identity/configuration refuses recovery. A worker initially stopped or
absent is not started. Success leaves the previous worker stopped for canonical
service recreation. A private, target-bound durable ID/fingerprint lets the
cross-host coordinator also recover earlier successful hosts if a later host
fails or scheduler restoration aborts the window. The state binds the target and
GitHub run/attempt (or one generated manual-window ID), so a separate authorized
purpose for the same SHA cannot consume a previous run's record. A durable start-attempt marker
prevents a second start across the exit handler and coordinator. A still-running
migrator or cutover refuses recovery. Subshell traps keep scheduler restoration separate.
SIGKILL, host loss or an unsuccessful recovery still require status diagnosis;
an unsuccessful start is never blindly repeated.

The previous worker was recovered once on October 3 at 10:19 UTC and independently
read as healthy on the unchanged a89 image/configuration. R1's object table and
reference column had not been applied. This recovery is not a new release or a
transfer of the old process-stability baseline.

Local guards reproduce both defects on the original source, exercise the actual
shell phase, and execute real catalog/no-op index statements in isolated
PostgreSQL. The six catalog mutations are fixture-only. Their small relations
prove that mismatches request the guard; the production-size refusal calculation
is separately exercised with the retained measured shape. They do not prove a
production release, disk savings, reference writes or natural positive reuse.

Release requires final exact-source review, canonical QA/build/CI/image gates,
fresh actual admission and one new exact-target canonical deployment with
migrations. The failed b07 dispatch stays consumed. Rollback is to the accepted
a89 inline writer only while R1 has no referenced data, retaining additive
schema. No storage removal or new resource is authorized by this repair.
