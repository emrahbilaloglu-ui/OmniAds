# Historical read cost gates and narrower evaluation/context measurement

D136 adds real resource controls to D135's default-off explicit historical reader.
D137 prepares a SELECT-only removal-unit measurement. Neither changes current
serving, decision formulas, epochs, canonical clocks or provider execution
authority. Neither activates production storage or authorizes data removal.

## D136 runtime limits

Business authorization occurs before archive access. Historical evidence requires
`collaborator` membership; ordinary current evidence retains its existing `guest`
minimum. No user-selected path, key, bucket, version fallback or credential chain
is introduced. Disabled remains disabled; an unavailable package returns409 and
never substitutes current data. Temporary admission/budget overload returns429,
`Retry-After:60`, and `Cache-Control:private, no-store`. A package permanently
outside the pilot bounds returns unavailable409, rather than a retry loop.

Per process, the immutable limits are:

| Resource | Limit |
| --- | --- |
| Original plaintext / returned evidence | 2MiB /256KiB |
| Catalog / entry count | 1MiB /128 |
| Active requests / requests per business | 8 /2 |
| Concurrent validations / per business | 2 /1, no queue |
| Total request / network / worker validation deadline | 10s /5s /5s |
| Verified ciphertext / evidence cache | 8MiB /4MiB,32 entries each,5min TTL |
| Requests per15min / per business | 512 /64 |
| Download bytes per15min / per business | 128MiB /32MiB |
| Response bytes per15min / per business | 32MiB /8MiB |
| Budget business entries | 256 |

Admission and request budget are charged before catalog/key/artifact loading.
Trusted download size is reserved before GET, including transfers that fail.
Response budgets include verified-cache hits. Exact duplicate identities share
one in-flight verification. Cache identity binds the independently pinned catalog,
key and credential configuration, compiled validator SHA, immutable VersionId,
content/schema hashes and requested original tuple. Only fully verified bytes and
authority-free evidence enter caches; caller mutation and expired/error/late
results cannot upgrade trust. Cache clearing does not reset rate budgets.

AES-GCM, plaintext parse and full core/parent validation run in a dedicated worker.
The web process still performs bounded catalog parsing, ciphertext hashing and
response serialization; it is not a zero-CPU path. The worker receives copied
encrypted bytes and this object's key, with `NODE_ENV=production` only. It has
128MiB old-generation/16MiB young-generation/4MiB stack limits; timeout/error/abort
terminates it. These V8 limits do not bound all native allocation or host RSS.
Logs contain fixed event names and numeric duration/byte cost, never identities,
URLs, paths, payloads, keys or credentials. Per-process budgets are not distributed
or host-wide limits and do not establish production throughput or a financial cap.

`build-native-historical-worker.mjs` bundles the actual source as a Node20 CJS
artifact plus its byte count/SHA manifest. Tests build this source before running;
production build also verifies the exact standalone asset by running its separate
worker against a public synthetic encrypted fixture and original-row expectation.
Next standalone tracing and both image layouts carry that artifact. Runtime opens
bounded regular files without final symlinks/group-other write access, checks the
digest, and executes the verified bytes; missing/bad artifacts refuse, without a
synchronous TypeScript fallback. This is an exact-file/digest guard, not a blanket
filesystem TOCTOU or host-compromise guarantee. The adjacent manifest establishes
artifact integrity, not independent source authenticity; pinned reviewed source
and the trusted image digest establish that trust. Before merging this phase, the
production Node20 Linux build must execute the standalone worker proof and record
its actual Node version, platform and artifact digest. Both final image layouts
must retain the same artifact; Node22-only local/CI execution does not close this gate.

The two-MiB fixture tests an actual maximum-size compiled-worker read and duplicate
coalescing. Local event-loop/latency/RSS observations are diagnostics, not a live
SLA. The64MiB transport format remains readable by separate local verification
tools; the runtime pilot refuses larger packages and has no implicit chunker.

## D137 measurement and preservation contract

The proposed smaller unit consists of one complete original native generation's
evaluation rows and their exclusively owned contexts. Original job/dependency/
reuse ledgers, shared input evidence, calibration parents, provider roots, current
snapshots, outcomes, action/workflow/proposal/Launchpad evidence stay live.
No original job `row_count` is rewritten, and archived history never supplies
current authority or native reuse.

`readNativeEvaluationContextUnit` requires a caller-owned pinned READ ONLY
REPEATABLE READ transaction, positive statement timeout at most7.5s, exact
business/job/day/epoch and complete original row count capped at10,000. It counts
every catalog incoming FK to the selected evaluation/context set, including
unclassified ZERO and positive cross-schema edges, and checks the exact eleven-
column internal lineage. A distinct action-lineage count includes all four typed
operator/controlled evaluation and snapshot references. These action columns do
not have direct evaluation FKs; optional episode/assignment links cannot replace
their explicit counts. Each action is counted once, with missing required columns
remaining unknown. Context sharing, all terminal/nonterminal workflow state
and journal references, native proposal raw/JSON identities and possible Launchpad
entity handoffs veto the measured pin-free state. Malformed/missing contracts and
declared unclosed consumers remain unknown rather than measured ZERO.

Launchpad's `mdd_<24hex>` is an entity hash, not an evaluation UUID. Its conservative
possible-identity count is not an exact evaluation pin or unique reclaimable byte
estimate. A caller-supplied inventory digest and empty unknown list are not a
production census or transitive consumer closure. The SQL timeout is per statement;
the caller still owns pool admission, whole-transaction deadline, cancellation and
ROLLBACK. There is no production caller, removal executor or physical-byte query.
Every assessment keeps `providerAuthority=false`, `reclaimEligible=false`,
`productionConsumerClosureProved=false` and `physicalBytesReclaimed="0"`.

Original-job evaluation reads may expose existing context-leading indexes through
the complete eleven-column evaluation/context join. This redundant route requires
a same-schema validated, nondeferrable FK, every child key NOT NULL, all four
internal RI triggers enabled, and an origin replication session in the same pinned
read-only snapshot. Missing, ambiguous or unsafe catalog metadata preserves the
original global job scan. No business/date/epoch subset is added to conceal foreign
rows. Completeness, foreign membership, every incoming/typed/JSON pin count and the
global cross-generation shared-input count remain required. Normal PostgreSQL
constraint integrity is assumed; catalog flags are not an audit of historical
superuser/replication bypass. Existing-index EXPLAIN costs are not measured latency,
and global retained-input scans may still exceed the unchanged7.5s bound.

The owned actual-migrations PostgreSQL guard first copies a byte-complete original
superseded archive. It observes a nonempty newer current generation, hysteresis
lineage and reuse header/rows through the real production SQL. A fixture-only,
rolled-back evaluation/context deletion preserves those exact outputs, original
job count, shared input root and authority-free historical bytes. This is a
one-evaluation sensitivity proof; the existing501-row producer/archive seam remains
separate. Neither proves a production removal population, every transitive reader,
rare natural path, physical reclamation, retention horizon or sustainable growth.

## Remaining activation and storage gates

Actual account/private target/cost/access, exact-version provider compatibility,
negative least-privilege/retention probes, independent key/catalog recovery and
durable readback/restore are still required. Full production consumer/pin closure,
measured population/horizon, new-row growth control and a concrete reclamation unit
with fresh scratch/WAL/lock/restore evidence remain separate. No resource, upload,
reader activation, eviction, disk/index maintenance or additional budget authority
follows from this code or source/image gates. Roll back by disabling the historical
gate or reverting this additive phase; existing current data/readers remain live.


### Complete snapshot membership through existing evaluation lineage

A separate SELECT-only snapshot selector requires the exact validated, nondeferrable,
fully nonnullable fifteen-key snapshot/evaluation FK, including job_run_id, with
all four RI triggers enforced in an origin session. The full evaluation selector
retains its own eleven-key guard/fallback. The resulting join returns all original
snapshot bytes; unsafe snapshot metadata retains the complete direct job scan.
Only the exact same-schema snapshot.job_run_id -> job.id incoming edge restricts
its child through this selector. Other/unknown/cross-schema child edges retain
all rows, including a snapshot owned by another job that independently references
the selected job. Parent snapshot/action counts also retain complete membership.

The actual third source read completed evaluation membership in25ms but failed
snapshot census at7501ms/57014 and completed ROLLBACK; no encrypted archive formed.
The exact failed SQL digest matches the snapshot child job-FK query. A parent-only
materialized proposal still scans snapshots and has a worse estimated cost, so it
is not an accepted fix. The twenty-index metadata inventory is capped, not a full
production index census. Local original-row parity/unsafe-FK/cross-job sensitivity
tests do not prove production speed, physical reclaim, admission or reader closure.
Normal historical constraint integrity is assumed; prior superuser/replication
bypass and every transitive consumer are outside this guard's proof.
