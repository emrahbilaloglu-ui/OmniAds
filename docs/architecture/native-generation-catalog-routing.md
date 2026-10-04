# Finite generation catalog routing (D145)

Status: source preparation. This is no live activation, production archive
capture, all-reader/pin closure, retirement or measured physical-space reuse.
The existing natural original generation, offline copy, compiled proof, source
release and actual authenticated HTTP acceptance have separate receipts.

## Contracts and exact route ordering

`ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED` defaults OFF. While OFF,
the existing v1/v2/v3 direct catalog path and resolver remain unchanged. Turning
the original historical reader OFF still performs no archive read at all.

While ON, only the explicit filesystem transport is admitted. Configure an
absolute canonical read-only `ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT` and an
independently pinned `ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256`. Keep the
existing encryption and original catalog configuration. The new root's legacy
digest MUST equal `ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256`; no route can choose
an alternative legacy version. The original legacy bytes are copied under their
exact digest into the routing directory, not reserialized or replaced.

1. Read `native-historical-generation-routing.v1` root first. It binds the frozen
   legacy digest/length/sorted exact job set and up to256 sorted bucket references.
2. A declared legacy job reads only that exact legacy catalog. Its complete job
   set must match the root, and the old exact resolver must match the request.
   Missing/mismatched legacy evidence refuses, without shard/leaf fallback.
3. Any other job selects `SHA256(jobRunId).slice(0,2)` and exactly one declared
   `native-historical-generation-shard.v1`. Validate EVERY record in that shard:
   exact shape, matching bucket, sorted unique full job key, no legacy job,
   valid tenant/job/date/engine and independently pinned leaf digest/length.
   Multiple ordinary jobs sharing an8-bit prefix are valid and required.
4. The selected record's FULL generation, including business, equals the request
   BEFORE reading its leaf. A missing record, tenant/date/epoch mismatch or absent
   bucket refuses. Unselected shards/leaves are not loaded or listed. Offline
   publication validates all files; runtime validation is the selected path.
5. Open the exact digest-bound, complete single-generation v3 leaf using the
   unchanged full catalog verifier. All entries have the record's generation,
   at most one coverage group and at most128 total entries. Whole and fragment
   entries cannot mix. Original root/membership/AAD/row-count checks still hold.
6. Resolve the exact original evaluation to ONE object and validate through the
   existing worker/response. Provider authority, current-decision eligibility and
   reclaim eligibility stay FALSE. No new core, fallback, clock normalization,
   ID/hash rewrite or original receipt change.

ROOT and selected-shard metadata mix tenant IDs only on the server. Neither
responses nor route errors/logs expose other records' IDs, paths or source bytes.
The existing route authorization and business admission run before preparation.

## Fixed bounds and finite capacity

| Component | Bytes |
| --- | ---: |
| Root | 32,768 |
| Frozen legacy catalog while routing ON | 16,384 |
| Selected shard | 32,768 |
| Single-generation v3 leaf | 966,656 (944 KiB) |
| Root + max(legacy, shard + leaf) | 1,032,192 |
| Unchanged aggregate metadata bound | 1,048,576 |

Caps fail before allocation/read/parsing. There is no dynamic remainder coupled
to the legacy file size and no double legacy+routed lookup. Root and shard byte
lengths count toward the aggregate even on a metadata-cache hit.

The offline publisher refuses duplicate full jobs, legacy overlap, incomplete
leaf coverage, ANY shard overflow, root overflow or leaf overflow. It never
drops records, truncates leaves, moves jobs to a different bucket, expands256
prefixes or raises a cap. Larger fan-out needs an explicit new root contract.

The original1800-row current fixture's951,034B leaf fits944KiB with15,622B
headroom. That selected result is not a general evaluation-count guarantee.
An individually larger original root still refuses regardless of fragmenting
the ciphertext. A compact/Merkle commitment contract is separate work.

The plan review estimated20k–22k generations using250–300B records and roughly
uniform bucketing. That is an assumption, not a measured publishable population
or lifetime. Real records/engine lengths, bucket imbalance, frozen legacy job
set and future frequency determine the first byte-bound refusal. No
13-businesses × one-per-day or "few years" claim is made. The contract is finite.

Envelope bounds stay8MiB decoded/2MiB compressed (legacy pilot unchanged),
worker5s/128MiB old/16MiB young/4MiB stack, response256KiB, request10s and the
existing admission/evidence-cache/window budgets. No safety limit is lifted.

## Verified metadata and entry identity

A process-local LRU holds at most2MiB of original metadata source bytes, two
leaves and32 total metadata entries. That source-byte weight is not actual JS
object heap, a measured peak heap, concurrent throughput or a CPU/SLA guarantee.

Only successfully verified metadata enters. Cache keys bind kind, exact
digest/declared length, routing contract/gate, compiled worker-asset digest,
configured directory, root/legacy digest and selected shard/generation context.
A new root, component or asset misses. Gate OFF clears the routing cache.
Hot metadata remains a trusted immutable copy of its pinned bytes; filesystem
permissions/inodes are checked on actual cold reads, not rechecked for a hit.

Catalogs and every nested root/entry are deeply frozen. Only a private WeakMap
populated by the complete catalog verifier stores precomputed entry identity.
Generic mutable or merely shallow-frozen caller objects cannot register a
fingerprint; their original full-content fingerprint is computed every time.
Configuration/key/credential/asset changes still separate ciphertext/evidence
identity. No additional decrypted-evidence cache is introduced. Failed or late
aborted verification cannot populate trusted metadata.

Cold near944KiB parse/verify/freeze/fingerprint timing and hot/eviction/digest
guards must be recorded using actual compiled Node20 code. Synthetic metadata
guards and previous D144 measurements do not substitute for that new receipt.

## Filesystem and offline persistence

Names are configured root + fixed `root|legacy|shard|leaf` directory +
`<validated SHA256>.json`. Never a caller path, directory listing or latest lookup.
Canonical realpaths/no directory symlinks, common root ownership and no
group/other write are required. Opens use O_NOFOLLOW and require regular file,
nlink1, owner, bounded exact length, single exact read and digest equality.
Final inode/directory/size/time/link/mode readbacks reject a changed read.

ONE genuinely outstanding filesystem operation is shared with evidence reads.
Its5s deadline/outer cancellation fences subsequent I/O until the underlying
operation closes its descriptor. Sequential root/shard/leaf reads receive the
existing10s outer request signal. This does not guarantee kernel I/O cancellation.

The explicit offline persistence helper first rebuilds/verifies the ENTIRE
publication inventory. In a caller-owned staging root it writes new temporary
files, fsyncs, makes0440 immutable files and uses no-replace hard-link publication;
only its own temporary names are removed. Retry verifies an exact existing file,
never overwrites a corrupt one. It changes no environment, original catalog,
DB source row, capture, provider or budget. These owned-fixture writes are not
production storage permission or independent disaster recovery.

## Activation, rollback and remaining proof

Each newly pinned routing ROOT changes environment trust. Production activation
requires a concrete reviewed operator/fresh exact service and capacity admission,
read-only mount/source-key recovery, old legacy compatibility, new web start
baseline and independent readback/original HTTP bodies. No signed-root shortcut,
automatic root rewrite or implicit rebuild/deploy is provided.

Pinned de76 R4 legacy198 protocol with all nine authenticated original PRE and
POST bodies runs FIRST before D143/D144/D145 deployments. Its unresolved Chrome
block is separate from an authenticated Hetzner console. Never bypass that
handoff or claim a local response as live HTTP.

Recovery retains the old code/catalog/key and reader-OFF policy. New routing
files do not authorize deleting their legacy source. Incoming/non-FK/transitive
pins, original independent parents/restore, natural producer archive capture,
strict positive reuse and actual physical-space reuse remain distinct. Items3
and7 remain OPEN; this contract is no all-eight acceptance or unlimited storage.
