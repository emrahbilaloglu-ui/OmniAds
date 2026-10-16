# Lossless native history lifecycle (D175)

This is an opt-in caller of D174 and the existing whole-original capture,
private full-DDL restore and C3 parent-challenge retirement kernels. It changes
no decision math, provider writes, native epoch/clocks, DB budget, physical floor,
snapshot retention, old snapshot compatibility or generic retention permission.

## Authority and sequence

`scripts/business-archive-erasure-worker.ts` invokes one finite original only
when the business-erasure queue is empty. The existing global publisher/erasure
advisory lock serializes all archive changes. Source identity, image/OCI labels,
reviewed runtime source inventory and explicit native-archive lane are mandatory.
The ordinary provider worker has no archive or restore socket mount. Web's
archive/control mounts remain read-only. Container health is liveness only.

Metadata selection reads at most64 job headers, never hot evaluation rows.
Preserve typed unsupported/oversize/pinned refusals. One supported original has
at most3200 evaluations/four contexts; all old32MiB encoded/64MiB decoded,
per-object, per-wire/catalog/cache, source query/lock and full-byte checks stay.
A day must be closed38h with a later distinct-day success. Every retained
snapshot and action/workflow/outcome/assignment/event reference remains a pin.

The durable30m purpose records intent before work. Capture yields two immutable
local private packages. Each stores cipher parts and a v4 leaf once, plus a
bounded hashed gzip of the original unit config and a small descriptor. This
avoids repeated expanded trust roots per part. Both complete packages are
decrypted/authenticated/reassembled and compared; an isolated socket-only PG16
companion receives the actual full schema and every original row. Its derived
plaintext target is dropped and independently proved absent. Restart cleanup
can drop only the deterministic target owned by this exact purpose journal.

A fixed DB-root daemon pulls that complete encrypted package over a restricted
forced SSH command, verifies every file and fsyncs it on a volume separate from
source PG data/WAL. The key never goes to that host. Both offline key copies
must match the pinned key SHA. Copy ACKs are bound to the exact manifest, host,
device, file bytes and purpose and expire; a heartbeat/list/file is never ACK.
Idle ticks scrub one whole encrypted original. Telemetry is owner-only.

Only then may the publisher append one tenant leaf/bucket/root, after admission
for the actual serialized bytes. The old small graph is converted once. Superseded
root/bucket metadata waits the existing10s reader deadline plus1s before unlink.
No unbounded forest copies or accumulating per-append expanded coverage roots.

The real authenticated HTTP evidence route must return complete matching original
rows with all historical-only authority flags. Full bodies are retained encrypted
with tenant/job/root/phase AAD. Temporary session hashes are journaled before
insertion and exact owned sessions are deleted/proved absent. Normal current
GET results are recorded separately before/after; history grants no current
execution authority and this work does not declare the earlier409 repaired.

Fresh pin census, source/role/consumer/producer/fence/physical/copy/HTTP evidence
precede C3. The parent checks the actual nonce-bound prepared transaction and
full original/retained/input partition proofs before one COMMIT challenge.
It never re-queries the two AX-locked tables from another connection. A lost
COMMIT reply or dispatched-unit restart is status-only owner attention, never
automatic re-execution or fabricated success. Independent source absence,
retained/shared bytes, historical HTTP and current GET parity follow the actual
COMMIT ACK. No claimed OS disk shrink follows a DELETE.

## Bounds and storage balance

Default off: `NATIVE_COLD_LIFECYCLE_ENABLED` and the `native_archive` lane.
Broad retention stays separate/off. Preserve the163GiB business budget,
40GiB source physical floor and512MiB maintenance reserve; add app8GiB and
independent replica16GiB floors. D174 limits proven reusable native MAIN credit
by actual physical spare. Dead tuple, TOAST and index estimates grant no credit.

One successful original starts at most every5min. The rolling15min automation
budget is48/64 historical requests and24/32MiB potential downloads per business,
reserving human capacity. Existing server bounds remain authoritative. Retry
budget refusals and busy producers within the same finite purpose; never force
provider jobs, fake a day/cutoff or turn evidence booleans into permission.

The existing unchanged-Meta-publication reuse and native result reuse prevent
unchanged source captures accumulating first. New eligible superseded native
originals move to compact encrypted history, not the hot DB. No finite disks can
retain arbitrarily growing history forever. Report measured generation rate,
package footprint and remaining archive horizon; a floor/refusal or unsupported
backlog is owner attention, not a claim of unlimited or proven future capacity.

## Offboarding and rollback

Once installed, `NATIVE_COLD_REPLICA_REQUIRED=true` is a lifetime erasure
requirement even when the new writer/lane is disabled. The ordinary user still
sees immediate deletion; no backend cleanup details enter that flow. The same
hidden-business/publisher barrier prevents new copies. The single replica
process prioritizes permanent tenant erase intents over older copy requests.
Actual remote absence ACK must precede exact local private copies, encrypted
HTTP proofs, journals, temporary sessions and derived plaintext target cleanup.
Global cursor/read/veto/success/failure identifiers are removed too. Corrupt or
partial redundant bytes remain owned and cannot escape explicit tenant erasure.
Foreign/shared history is preserved; final DB cleanup requires the cold proof.

Before first new-format publication, the old image remains a deployment rollback.
After publication/retirement, disable the new caller and lane while retaining
this compatible reader, active pointer, key, copies, replica daemon and erasure
requirement. Never revert to an old image lacking pointerv2/tenant support or
restore the old env wholesale. Upgrade only with no active finite purpose;
otherwise finish it first or retain its status-only owner journal.

## Deployment acceptance

Canonical40-stage real-PG checks and exact image CI are prerequisites, not live
acceptance. Closed host installers verify pinned files, actual separate devices,
private PG image/socket/network and whitelisted role observations. Preserve old
authorized keys/settings; add only one restricted mirror key. No source PG
maintenance, index rebuild, paid expansion, provider write or budget change.

Actual acceptance needs automatic completed units with restore/replica/C3/absence/
historical/current proofs, natural sync and native success/reuse observations,
fresh fence/physical samples and measured storage horizon. A previously existing
409, provider quota failure, unobserved new generation or unbounded future growth
must remain explicitly limited rather than inferred from healthy workers.
