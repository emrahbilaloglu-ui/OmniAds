# Native evidence archive: offline contract and remaining live gates

Status: preparation only. D132 retains D129 canonical identity and the hard
capacity refusal. This is neither a production archive nor a retention policy.

## Implemented local boundary

`lib/creative-decision-engine/native-evidence-archive.ts` builds/verifies a
`native-generation-core-archive.v1` bundle. It has no DB access, filesystem
access, uploader or eviction executor, and production readers do not import it.
The manifest binds one business/job/as-of/epoch, workspace HEAD and dirty marker, captured clock,
actual column/type/nullability and FK definitions, counts and each object digest.
The five core tables are native job runs, contexts, evaluations, input evidence
and daily snapshots. Snapshot/evaluation/context identity is checked across all
composite lineage members. Missing input evidence refuses; older contracts need
an explicit legacy adapter. A job with missing/replaced current cells cannot be
called a complete archived generation. The daily table upserts evaluation/job
identity on each subsequent generation. Thus v1 covers only a generation whose
entire set of daily cells still points to its original evaluations, normally
the last served generation of that day and scope. Partly or fully superseded
same-day generations are refused; their evaluations/contexts/evidence may still
exist, but their original daily snapshots cannot be fabricated from new cells.
Zero remaining snapshots does not prove zero outcome/episode/assignment/action
pins. The retained 11 jobs and 17,300 evaluations are a small observation, not a
population census or evidence that most rows are reclaimable.

### Separate superseded-generation contract

D133 now implements the OFFLINE superseded core transport and a scoped read-only
pin census described in [the pin/reclaim preparation](native-archive-pin-reclaim-preparation.md).
The production parent/reader closure, external destination and reclaim executor
remain unimplemented. The following requirements still govern that live work.

A separate versioned bundle must represent superseded history without claiming
daily-serving snapshot completeness. Its immutable job row_count must equal the
evaluation count, with exact context/input-evidence membership and original
clocks/hashes. It must carry a scoped, timestamped pin decision for snapshots,
outcomes, episodes, controlled assignments, event/action/replay references and
reuse-attempt reused_job_run_id links. A missing/unsupported reference census
refuses eligibility; absence of one FK class is insufficient. Any retained
parent evidence must either remain explicitly pinned in the live store or be
included under a tested lineage contract. Current-serving generations remain
live. The superseded contract is separate from v1, carries no current snapshots
and never approves eviction or restores a missing historical daily snapshot.
Its historical copy can retain known pins; its independent candidate assessment
refuses every such pin. Unknown references refuse both the scoped assessment and
superseded transport. No production pin inventory or reclaim executor is enabled.

Objects store exact `to_jsonb(row)::text` bytes, rather than JSON.parse followed
by JSON.stringify: the latter can round PostgreSQL numeric/bigint evidence.
Routing checks parse only textual identity and row-count fields; original bytes
are carried through transport and restore. Hashes are integrity checks, not
authentication. The reader requires a separately trusted manifest digest,
schema digest and tenant/generation identity. A downloaded manifest cannot
self-authorize itself. Missing/corrupt objects, duplicate identities, extra
objects, schema mismatch or broken lineage refuse the whole bundle.

The verified reader returns historical bytes and original job identity with
providerAuthority=false and reclaimEligible=false. An original authorized_action
inside a row is historical evidence; it must not be handed to an execution path.
Copying or restoring it never updates its clocks or creates current authority.
The reader captures immutable strings so later mutation of downloaded objects
cannot change the verified view.

Source HEAD is not an exact build identity when sourceWorkspaceDirty=true.
The local seam records that state; its changed-file manifest separately binds
the reviewed candidate bytes. A production exporter would have to require a
clean, exact built revision and trusted schema/manifest index. No dirty-workspace
bundle is proof of that future production gate. Manifest ordering uses code-unit
comparison rather than locale-dependent ordering.

`scripts/native-evidence-archive-seam.ts`, called by the existing isolated native
producer seam, serializes a non-empty complete generation to a local0600 file,
reloads it through the trusted reader, restores into a sandbox schema, rebinds
and validates the actual outgoing FK DDL and compares all five core tables
byte-for-byte. All synthetic parent rows are copied from the source sandbox.
This proves DDL rebinding and key-byte parity, not independently complete parent
coverage in the archive: those parents are not in the transported bundle.
Child foreign-evaluation rejection and parent-delete RESTRICT are separate
SQLSTATE23503 probes with an exact one-row child selector. The original bulk
UPDATE probe changed all unique evaluation IDs to one value and did not retain
its error code; it cannot prove the FK accepted a child. Reproducing that bulk
shape in the sandbox yields uniqueness SQLSTATE23505, while a known single
child's foreign evaluation yields the intended lineage SQLSTATE23503. This
explains why checking only code===23503 was an invalid diagnostic. The first
run's actual error code was not retained; r0/r1 log names are copies of that
one run, not two independent failures. No live FK contract is changed.
The helper refuses anything except the random-port loopback native_ad_seam
database; it never obtains DATABASE_URL or runs on a production/tunnel port.
Tenant/credential roots copied in the synthetic sandbox are not exportable
production evidence. Calibration rows, their batches and original job runs are
decision-lineage parents: a real archive must include them or explicitly pin
them in live storage for the archive lifetime. Sequence defaults and synthetic
parent setup belong to the sandbox only.
This is not a deployable import command, a complete DR proof, or an FK migration
of incoming outcome/episode/experiment/event pins.

## Production bundle and reader work still required

Before any removal, inventory the complete incoming/transitive FK closure,
non-FK references and every reader. In particular, evaluation-to-input-evidence
membership is shared and has no DB FK; evidence removal needs a reverse-reference
check across all retained evaluations, not just the selected generation.
Direct RESTRICT pins measured separately are
daily outcomes, daily snapshots, recommendation episodes and controlled random
assignments. Events can in turn pin snapshots; action/proposal/experiment audit
lineage may have non-FK references. Source-account roots or connection credentials
must never be exported by traversing generic parent graphs blindly.

Current generation, pending confirmation, active episodes/experiments, recent
serving fallback, retries/reuse and unresolved actions remain pinned in the live
store. No guessed90-day boundary: the earliest retained evaluation observation
in D099 is July14. Full-generation eviction eligibility must prove coherent
dependent migration and all current-reader requirements, not merely zero direct
FK rows. The current core format deliberately never grants that eligibility.

Reader disposition by path:

| Path | Required before switching storage |
| --- | --- |
| Decision Center current/retained | Exact scope/date/account, original clocks and degraded state; archived source stays review-only. No UI-computed buyer action. |
| Hysteresis/reuse/scheduler | Resolve original evaluation/job and full linked generation; archive availability cannot complete a current slot or acquire freshness. |
| Replay/backtest/outcome | Versioned input/config/metric receipts, episode and source lineage; unknown remains unknown, not measured zero. |
| Action/experiment audit | Original controlled assignment/outcome/action references and legal holds/pins; no dangling IDs or synthetic authority. |
| Unknown reader/unsupported version | Refuse with explicit archive_unavailable/incompatible state. Never silently fall back to empty rows or current semantics. |

The existing live readers remain unchanged. A future archive index needs tenant
authorization, signed/trusted immutable manifest references, encryption/access
rules, object retention/object-lock semantics and a tested missing-object path.
Migration must dual-read compatibility, preserve existing row IDs and bind a
transactional pointer only after durable upload and sampled restore succeeds.
Each supported reader needs positive and negative integration tests; this local
core reader is not those integrations.

## Content-addressed JSON for NEW rows: design, not applied schema

High-volume evaluations repeat creative_input_json, campaign_context_json,
prior_hysteresis_json and decision_output_json. Context rows separately repeat
context/account/data-health/flag JSON. Current input evidence already deduplicates
by contract_version/input_hash. Dedupe must preserve the exact original encoding,
not round numbers, omit clocks or recompute old canonical hashes.

Proposed storage representation: immutable payload objects keyed by
`(storage_encoding_version, sha256(exact_payload_bytes))`, plus per-evaluation
column references. The transport/storage hash is distinct from contextHash,
inputHash and decisionHash; equal transport bytes never prove equal authority.
Hashes require byte equality on collision/conflict, not ON CONFLICT DO NOTHING.
Column/type/encoding markers and actual length belong to the object contract.

Before rollout, measure the unique/duplicate byte distribution of the candidate
payload columns at matched timestamps; high TOAST bytes alone prove no saving.
New representation adds references/indexes and may save nothing on rapidly
changing inputs. The full generation archive here content-addresses whole rows,
whose IDs/clocks often differ: do not claim it reduces new production storage.

Migration sequence: additive payload/object-reference schema with explicit
storage version; dual-write only NEW rows; full same-snapshot inline/reference
read parity and hash recomputation; legacy inline precedence during rollback;
then independently reviewed reader adoption. Encoding-identical JSON may keep
canonical contracts; any canonical field/projection change must version BOTH
the relevant envelope and reader compatibility. No current row is overwritten or
cleared in this phase. Payload GC needs reverse-reference pins, rollback-reader
requirements, durable archive confirmation and separate deletion authority.

## Reclaim, capacity and approval gates

The separate D134 calibration-parent transport and independent real-DDL restore
preparation is described in `native-calibration-parent-archive.md`. It preserves
the original complete batches/cells and producer/replay receipts instead of
borrowing source sandbox parent tables. Its declared scope is not complete
upstream/transitive reader closure or production sustainable-storage approval.

The archive destination, concrete generation/date horizon, external cost and
access/restore policy are not approved. Delegating strategy did not approve
deletion, external resources, a second161GiB budget lift or volume changes.
An immutable upload alone frees no PostgreSQL space. A DELETE alone generally
does not reduce pg_database_size. A physical rewrite/partition migration needs
separate scratch-space, I/O/lock planning and rollback. The measured evaluation
relation is about63GB and DB physical free space about59GB; do not assume a
complete extra relation rewrite fits. Different tables/indexes require separate
planning; aggregate and per-table fences must both admit afterward.

Retained capacity observations bracket closure between07:45:13 admitted and
08:46:27 refused on Sept30. New bridge admission was observed04:56:53, not a
measured three-hour lifetime. Recorded business work ends at08:02:19 in the
accepted process window; healthy processes afterward do not establish business
availability. Mixed effective/physical table subtraction is not writer attribution
or a time-to-full forecast. Keep the admission stop and obtain exact mutation
approval only after a concrete complete bundle/reader/restore/reclaim candidate
is reviewable. Until then sustainable storage and PR329 deployment remain OPEN.

## Strict native reuse: natural acceptance still required

Quiet-window reuse retains every canonical clock. Both the calibration layer
and the decisions layer have independent hourly freshness buckets; unchanged
source bytes alone are insufficient if either bucket or computation changes.
The existing two-tick native fixture holds the other layer constant and isolates
calibration reminting and its hourly boundary; it is not a natural replay receipt.

A bounded future natural witness must retain calibration idempotent_replay=true,
the subsequent decision step actually running, same business/day/account/epoch
and scope, unchanged complete canonical evidence, stable freshness buckets, and
reused_job_run_id pointing to the immutable original success. It must then prove
zero new evaluation writes for the reuse attempt, successful completion on a
subsequent natural tick, and independent provider execution authority. Preserve
each step's run/disposition; replay alone, counts or previous_success cannot be
substituted for the decision receipt. The one prior natural calibration replay
did not establish this chain and its missing reuse cause remains unpaired.

This optimization does not promise reduced growth under active sync or changed
calibration. Storage capacity planning must not rely on quiet-window reuse.
NEW-row content addressing is a separately proposed growth reduction, with its
actual duplicate-byte saving still unmeasured and no runtime schema applied.
