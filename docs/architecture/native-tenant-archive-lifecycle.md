# Tenant native archive infrastructure (D174)

This is infrastructure, not an enabled automatic lifecycle or production
capacity acceptance. No new publisher is scheduled by this change. Enabling a
later automatic caller requires durable independent copies, private full-DDL
restore, authenticated HTTP, exact source/role/physical/pin proofs and actual
cadence acceptance. The dedicated archive role owns publication; the web role
remains read-only and provider workers remain archive-free.

## Incremental storage and compatibility

Routing root v2 explicitly selects `tenant-sharded.v1`; active pointer v2 selects
the fixed `routing-cas-v1` namespace. Root/shard/leaf wire, decode, request, worker
and cache bounds are unchanged. Root v1, pointer v1 and archive v1-v3 remain
readable. A complete old forest can be verified and copied once. Each append
writes just one immutable tenant leaf, its changed hash bucket and a new root.
Unchanged leaves and ciphertext are never copied again on every append.

New compact v4 objects explicitly use `tenant.v1` keys:
`native/v2/<business UUID>/<cipher SHA>.bin`. The exact generation is already
authenticated by GCM AAD. Catalog validation, fixed digest paths, same-owner
directory chains, no symlinks/hardlinks, exact byte/hash and end-descriptor
checks all remain. Legacy flat object paths remain supported. Staging alone
does not activate a pointer, confer decision authority or retire any source.

## Whole original scope

The existing finite v3 batch and unit config v2 remain capped at 1,134 rows.
They explicitly refuse the new compact unit config v3. A separate compact
config requires the exact gzip-root and tenant-object markers and permits one
whole original of at most 3,200 evaluations and four contexts. The independent
32MiB encoded/64MiB plaintext limits, query/deadline/catalog/pin/producer-lock
bounds, unknown-consumer vetoes, immutable parent/snapshot preservation and C3
parent challenge remain. A 3,200-row original may still refuse a byte or pin
bound; a subset is never silently archived or retired.

Compact maintenance admission is a separate typed scope. In addition to every
existing maintenance condition, it requires a fresh separate-replica physical
sample with a 16GiB floor, an 8GiB app floor, the existing 40GiB source floor
and 512MiB reserve. This module does not supply the copy/restore/HTTP evidence
or grant provider work by setting a boolean. A later reviewed caller must
derive all those fields from real operations.

## Paged offboarding

The hidden-business queue and publisher share the same global exclusion.
Existing legacy flat content retains its 256-entry/16MiB census. The new
namespace is separately inspected: at most 1,024 global root/shard/legacy files
and 16MiB metadata, without enumerating or decoding foreign tenant leaves.
The current graph is fully verified and selected tenant records removed.
Obsolete routing metadata is redundant routing, not original evidence; only
metadata outside the new verified graph is removed after its atomic pointer
publication and the existing readers' complete 10s deadline plus 1s grace.

Each durable page freezes at most four selected leaves, authenticates their
complete encrypted parts and removes exact frozen leaf/object paths. The
planner is bounded to 2,048 proof entries and 16,384 cumulative live input keys.
Each at-most-400 input-key read must have a parameterized two-key index plan;
an unconstrained index/heap scan refuses. Only actual live full-row hashes from
new tenant pages are carried to database GC. Missing keys are not accumulated
for decades: D150 already proves each retired zero-reference key absent, while
the final business transaction captures every live owned evaluation key and
uses the unchanged indexed GLOBAL reference proof under writer exclusion.
The legacy saga retains its original absent-key drift checks.

A completed page resets only its crash-attempt counter and persists the next
page marker. A crash resumes the exact frozen plan; it never rediscovers a
partly removed original. The absolute 30-minute operation budget, three failed
crash recoveries, owner-only failures and immediate ordinary-user hiding stay
unchanged. Database erasure remains blocked until every selected routed record,
inactive identifying metadata, leaf and ciphertext is independently absent.
Future private copies and replicas MUST join that same owner-only barrier
before their automatic publisher is enabled; this infrastructure has no such
publisher or copies yet.

## Capacity credit and rollback

Only measured reusable MAIN free space is credited. Credit is capped so the
normal physical assessor can reserve the complete resulting headroom, even if
it is spent in another table, above the unchanged floor plus 512MiB reserve.
Full proven free and uncredited free are reported separately. Raw allocation,
163GiB deployment budget, independent table ceilings, no emergency override
and stale/invalid physical refusal remain. Dead tuples, TOAST and indexes are
never estimated as reusable credit.

Before any new format is published, an image revert is available. Afterwards,
disable the new caller while retaining the v2-pointer/v4/tenant-capable readers,
current atomic pointer, keys and all original copies. A source-code rollback
cannot point readers at deleted offboarding content. Credit rollback may
correctly return the system to capacity-idle; it cannot restore deleted sources.

## Evidence

Owned PG16 with actual full migrations and real statfs telemetry restored all
3,200 original rows/four contexts, verified every table/row hash, executed the
C3 parent challenge, removed exactly the original and 3,199 globally unshared
input keys, and retained the one shared input plus foreign and retained roots.
Its 740,950-byte leaf and four ciphertext parts stayed inside all old wire and
decode bounds. This is owned evidence, not production acceptance. The actual
2,517-row Grandmix read-only feasibility result is recorded in D173.
