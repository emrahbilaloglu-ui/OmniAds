# D077 production recovery — read-only preflight and exact execution packets (2026-08-30, correction 8)

**Submitted for Codex independent acceptance — not self-accepted.** The
original submission and corrections 1-7 were each independently
REJECTED; ALL EIGHT rejection records (original plus corrections 1-7)
are preserved byte-unchanged and pinned in the current manifest — the
full pin list is in the skill-gate section below. (HISTORICAL: at the
time of correction 3, only the first three records —
`…_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`,
`…_CORRECTION_1_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`,
`…_CORRECTION_2_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, the last
with hash
`da22e9b9e110109f8574627d6ab0fc3d91619681f5ff4a816395f7fbd2ab9b07` —
existed.)
Correction 2 was rejected on three exact blockers, each repaired in
correction 3:
(1) no measured pnpm version — `runtimeVersions.pnpm` is now measured by
the same bounded mechanism (this machine has NO standalone pnpm on PATH;
the corepack shim reports **11.24.0**; disclosure: a
`corepack prepare pnpm@latest --activate` probe run while LOCATING the
executable updated corepack's default before measurement, so the
pre-probe shim value is unknowable — the recorded value is what the
machine now measures, honestly annotated, never hard-coded); (2) the
whole-shell ledger stage reported `passed: 53` (the FIRST nested Vitest
summary — materially misleading for a composite shell) — its `counts`
is now an explicit not-applicable object and a durable machine-readable
`wholeShellProof` is bound to the stage: the exact ordered 38
`{number, title}` headers parsed from the retained log, sequence 01..38
validated, per-source normalized header digests proven EQUAL against
the current `scripts/verify-database-seams.sh` stage declarations,
release-owner proven stage 38 and last, the exact final
`[verify-db-seams] PASS — 38 stages` line, the exact log SHA
`a55e9f431112c557…75cec880` / 494,380 bytes (re-verified from the
retained file before proof generation), and the stage-24
release-boundary evidence (`no cutover pending: deploy/CUTOVER_REQUIRED
absent` marker/manifest agreement + deploy-gate-ordering PASS) — the
generator fails closed on any missing/duplicate/out-of-order/mismatched
header, wrong final PASS, wrong SHA/bytes, or wrong release-owner
position, and the durable hash-contract test rejects deterministic
mutations of every one of those contracts; (3) the DB packet's
`privilegeFacts.verifiedAtUtc` hard-coded the EARLIER transaction's
timestamp — it is removed, and the packet's role/capability provenance
is now copied programmatically from the frozen evidence transaction
(`retrieved_at 2026-08-30 14:30:32.38481+00`, `application_name
d077_recovery_preflight_c1_1788100231481`, read-only/repeatable-read
proofs), with a regression asserting packet↔evidence equality. The
whole-shell run and production evidence were NOT rerun (the retained
log's SHA/bytes were independently rechecked first); no production SQL
ran in correction 3. **Correction 3 was then itself independently
REJECTED** (fourth record,
`…_CORRECTION_3_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, hash
`0c1599943ee9967ef65f0c1b484e9aa45518ef2568362f941ec7454451a00574`) on
three blockers, each repaired in correction 4: (1) the durable artifact
guard was FAIL-OPEN (presence-gated skips/early returns and stored-digest
comparison) — it is now fail-closed: every named artifact, ledger stage,
proof, retained log and seam script MUST exist or the suite fails, and
the whole-shell contract is verified by RECOMPUTING the proof from the
retained log against the CURRENT seam script and deep-comparing it to
the embedded proof, with a regression proving a drifted middle source
header is rejected even while stale stored digest fields still agree;
(2) the pnpm attestation now tells the whole truth as STRUCTURED
provenance: present-tense read-only probes (PATH: no pnpm; the exact
Codex fallback executable
`/Users/harmelek/.cache/codex-runtimes/…/fallback/pnpm` → 11.19.0;
`corepack pnpm` → 11.24.0, an explicitly POST-MUTATION value), the
correction-3 `corepack prepare pnpm@latest --activate` HOST-TOOL
MUTATION disclosed as such (its pre-mutation value unknowable; NOT
restored — restoring Corepack state is out of bounds), and the
earlier retained stages' pnpm runtime marked **UNKNOWN** (no retained
evidence names it; neither current value may be attributed to those
stages); the false blanket no-host/env-mutation claim below is
corrected; (3) the stale pinned counts (a leftover "3/3" and "277
non-self") are replaced with values derived from the current artifacts.
Correction 4 itself performed NO new host/env mutation and did not
restore the earlier side effect. **Correction 4 was then itself
independently REJECTED** (fifth record,
`…_CORRECTION_4_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, hash
`968366de896909ac0895339aa35bd4013d546cc16f637be13f85e7d889adf1db`) on
portability/vacuity/self-containment grounds, each repaired in
correction 5:

1. **Clean-checkout portability.** The permanent guard depended on a
   Claude-session `/private/tmp` capture path. The retained raw log was
   first re-validated read-only (exactly 494,380 bytes, SHA-256
   `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`),
   then preserved byte-for-byte at the repository-relative,
   manifest-pinned path
   `docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-08-30.log`
   (byte-identity proven by `cmp` and by identical SHA/bytes). The
   ledger's `logFile.path` is now that repo-relative, traversal-free
   path — the SOLE runtime input for proof recomputation — and the
   original session path survives only as an `originalCapturePath`
   provenance field. The guard enforces the portable-path rule
   (rejects absolute paths incl. session paths, `..` traversal), asserts
   the log is manifest-pinned with the exact SHA, and a static census
   proves no executable D077 source references the session scratch
   path. WHAT WAS ACTUALLY PROVEN: every runtime input of the guard now
   lives in the repository and is manifest-pinned, and the suite passes
   on THIS host from those repo-relative inputs; no CI run happened and
   none is claimed — Codex will independently exercise the
   clean-checkout contract. The shell was NOT rerun (this is
   preservation of already-verified evidence).
2. **Structured pnpm/Corepack provenance.** The vacuous fields are
   replaced by a typed probe contract
   (`scripts/audits/d077-provenance-contract.ts`, validated fail-closed
   by generator AND guard): per-probe id, command, resolution mechanism,
   resolution enum, absolute resolved path iff resolved, exit
   status/signal/stdout/stderr, typed result class, observation kind
   (present-tense vs retained), timestamp, and cache-safety. The four
   probes: `claude-shell-pnpm` (POSIX `command -v` — UNRESOLVED, no
   pnpm on this shell PATH); `codex-fallback-pnpm` (the exact Codex
   fallback executable, direct spawn → `11.19.0`, exit 0);
   `corepack-program-version` (`/usr/local/bin/corepack --version` →
   `0.34.2` — Corepack's OWN version, cache-safe); and
   `corepack-pnpm-retained-c4` (`11.24.0`, a RETAINED correction-4
   post-mutation observation, deliberately NOT rerun because
   `corepack pnpm` cannot be proven cache-safe). Structured
   conclusions: `earlierRetainedStagesRuntime: "UNKNOWN"`,
   `correction3CorepackMutation {occurred: true, restored: false,
   preMutationValue: "UNKNOWN"}`,
   `correction5ProhibitedMutationCommandExecuted: false`,
   `corepackTrackedStateChanged: "false"` from a SCOPED before/after
   metadata inspection of the two known Corepack tracked paths
   (lastKnownGood.json and v1, both mtime 2026-08-30T14:56:33Z,
   unchanged) — and `globalHostStateClaim: "attestation_only"`: the
   scoped check proves exactly what it inspected; the global
   no-mutation statement remains an attestation, not universal proof.
   The guard validates the exact probe identities, enums and
   cross-field consistency and rejects six contradictory fixtures; no
   assertion tests prose by substring.
3. **Self-contained report.** Retitled at the time to correction 5.
   (HISTORICAL correction-5 numbers, superseded — see the correction-7
   result block below for the CURRENT counts: at correction 5 the suite
   was 12 tests / 12 passed and five rejection records were pinned.)

Correction 5 performed no new host/tool mutation. **Correction 5 was
then itself independently REJECTED** (sixth record,
`…_CORRECTION_5_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, hash
`464997c5d0ef892c1271ba42d0a7a6cb678a65aea412010c1a0c108f67f23f45`) on
provenance-faithfulness grounds, each repaired in correction 6: (1) the
generator now BRANCHES on its own live `command -v pnpm` measurement
(status/stdout/stderr/`result.error` preserved; a resolved path leads to
direct execution of exactly that binary; on this run the probe was
genuinely unresolved with exit 1, and the record says so); (2) the
retained correction-4 Corepack observation now carries ONLY what that
frozen record proved — command `corepack pnpm --version`, output
`11.24.0` — with `resolution: "unmeasured"`, `resolvedPath: null`,
`observedAtUtc: null` and `observationTimeCertainty: "unknown"` (the
invented shim path and invalid timestamp are gone, and the validator
REFUSES them by exact probe-ID binding); (3) the validator now enforces
`version_reported ⇒ present-tense + resolved + non-empty absolute path +
exit 0 + strict ISO-8601 UTC time`, requires the top-level and scoped
change flags to be EQUAL and both to equal the tri-state DERIVED from
the recorded before/after mtimes, validates strict ISO timestamps for
every present-tense observation, and permits a null time only for a
retained observation with unknown certainty; a nine-case
would-have-failed matrix proves each previously-accepted contradiction
is now rejected; (4) the stale correction-4 durable-guard paragraph is
replaced with correction-6's own recorded results (below). Correction 6
performed no new host/tool mutation and did not restore the
correction-3 Corepack side effect. **Correction 6 was then itself
independently REJECTED** (seventh record,
`…_CORRECTION_6_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, hash
`4257f116659dd7f383bca6d7509bec298d263cf7e301b132bedfd4a397d5d10c`) and
correction 7 repairs its four blockers: (1) the successful resolver
branch now preserves BOTH measurements — the schema carries a
`resolutionStep` and a `directExecutionStep`, each with its own exact
executable/argv/commandForm, exit status, signal, stdout, stderr,
spawn-error code and message (nullable, separate) and its own strict
observation timestamp; pure injectable builders
(`buildPathLookupProbe`/`buildExplicitPathProbe`/`buildRetainedC4Probe`)
normalize raw spawn data so tests exercise the resolved, not-found and
resolver-error branches without touching the host, and the builders
themselves refuse a direct execution on a failed resolution (and vice
versa); (2) every correction-6 validator bypass is closed:
calendar-impossible instants are rejected by component round-trip (not
Date.parse normalization); `not_found` requires a failed resolver with
no absolute-path stdout and no direct execution, and stays
distinguishable from `resolver_error` (spawn-error code required);
every exact probe ID is bound to its allowed resolver command/argv,
resolution kind, frozen paths (`codex-fallback-pnpm` must name exactly
the frozen fallback path; `/tmp/fake-pnpm` fails), result classes and
resolved-path↔executed-binary equality; retained C4 is bound on EVERY
field incl. its exact mechanism text, empty stderr and null
exit/signal; the scoped inspection must contain exactly the two frozen
tracked paths once each with strict calendar-valid or null mtimes; and
`correction3CorepackMutation.command` is bound by EXACT equality to
`corepack prepare pnpm@latest --activate` — an `echo …` wrapper fails;
(3) the tri-state is unknown-dominant (any unknown mtime ⇒ unknown,
then any difference ⇒ true, else false) with a mixed unknown+changed
regression; (4) chronology: `generatedAtUtc` is stamped strictly AFTER
observation collection and a focused assertion proves every exact
present-tense observation ≤ generatedAtUtc and calendar-valid.
(HISTORICAL correction-7 numbers, superseded — see the correction-8
result block below for the CURRENT counts: at correction 7 the suite
was 16 tests — final post-freeze 16 of 16 passed; the correction-7
pre-freeze run against the stale correction-6 artifacts failed exactly
the 5 provenance/chronology tests, 11 of 16 — that correction's
would-have-failed proof. Freeze-integrity disclosure: the
first correction-7 freeze was INVALIDATED before submission — after its
manifest was generated, a read-back scan found a stale current-sounding
"all three rejection records" summary still standing in this report's
opening paragraph, so the report was corrected and the final manifest
regenerated (ledger and packets byte-unchanged). In that invalidated
first freeze, the mid-freeze run had failed EXACTLY 1
manifest-dependent test (packet/manifest count equality), 15/16, and
its post-freeze battery had passed in full. The redo's mid-freeze run,
before the redone final manifest, passed the full suite — the suite's
manifest-dependent contract is count equality, which the invalidated
manifest already satisfied — and that manifest's staleness was instead
proven externally by per-file SHA recomputation showing drift on
exactly one pinned file (this corrected report). No pinned file was
written after the redone final manifest.) Correction 7 performed no new
host/tool mutation and did not restore the correction-3 side effect.
**Correction 7 was then itself independently REJECTED** (eighth record,
`…_CORRECTION_7_CODEX_INDEPENDENT_REJECTION_2026-08-30.md`, hash
`3e402717474920eb8a91f64fc628984a339150ff22c1d2f1bd9131ba3729b85a`) on
ONE blocker — the two-step validator still trusted redundant summary
fields piecemeal instead of recomputing a canonical probe state, so
eleven enumerated in-memory mutations passed — repaired in correction 8
by replacing the patchwork implications with ONE canonical, exhaustive
state machine: (1) `deriveCanonicalProbe` is the single pure transition
function used by BOTH the generator's builders and the validator — the
validator re-derives the complete canonical probe from the strictly
validated tagged measurements (resolver step, explicit-path existence
observation, direct execution step, or the retained record) and
deep-compares the serialized probe against it with EXACT key sets at
every level, so every summary field (command, mechanism, commandForm,
resolution, resultClass, resolvedPath, reportedVersion, top observation
time) is derived, never trusted; unknown/legacy keys fail; (2) exact
measurement-tuple invariants: each step allows exactly one coherent
outcome — exited (integer status ≥ 0, null signal, null spawn-error
pair), signaled (null status, non-empty signal, null pair), or
spawn-error (both pair fields non-empty, null status/signal) — mixed
tuples and a code-without-message (or vice versa) are refused, and
commandForm must render exactly from executable+argv; (3) exhaustive
path-lookup transitions: resolver success requires exit 0 with exactly
one newline-free, whitespace-free, NUL-free absolute POSIX path and
empty stderr (a malformed resolver measurement — exit 0 with empty
stdout, multi-line output, a relative path, or nonzero exit with output
— is REFUSED outright, never converted to not_found); ordinary
not_found requires a clean nonzero exited resolver; a spawn-error or
signaled resolver is resolver_error; resolved requires exactly one
direct execution of the exact resolved path with argv ['--version'] at
a later-or-equal timestamp; direct success (version_reported) is
exactly exit 0, empty stderr, null signal/error pair and an anchored
semver stdout — every other coherent direct outcome derives
execution_error; (4) the fallback existence check is its own exact
tagged object ({path, exists, observation-error pair, timestamp});
exists=true derives resolved and requires the exact-path direct step,
exists=false forbids execution, and an observation ERROR is
resolver_error — never reduced to absent; (5) frozen audit-package
bindings: codex-fallback-pnpm must report exactly 11.19.0 and
corepack-program-version exactly 0.34.2, and claude-shell-pnpm must
remain the faithfully measured unresolved not_found — a changed tool
version STOPS generation and requires an explicit new audit update;
retained C4 is one closed constant object (extra legacy keys fail); the
mutation record and scoped inspection are closed exact-key structures
with the frozen command/when/scope-note texts; (6) chronology: the top
observation time must equal the terminal canonical measurement time and
the direct step may not precede the resolver/existence observation. The
focused guard adds a table-driven transition matrix over every allowed
path-lookup/explicit-path/retained outcome plus malformed tuples, a
correction-8 would-have-failed matrix covering every mutation the
correction-7 rejection proved accepted, and property-style single-field
mutation coverage that mutates, deletes, and foreign-key-pollutes EVERY
serialized field of the frozen provenance and requires refusal.
**Correction-8 focused-guard results (the ONLY current counts): the
suite is 19 tests — final post-freeze 19/19 passed, 0 failed, 0
skipped; the correction-8 mid-freeze run (before the final manifest)
failed EXACTLY 1 manifest-dependent test (packet/manifest count
equality — the packet now expects 286 non-self files including the
correction-7 rejection record, while the stale manifest still pinned
285), 18/19; the correction-8 pre-freeze run against the stale
correction-7 artifacts failed exactly the 6 provenance-dependent tests
(13/19) — the would-have-failed proof.** Correction 8 performed no new
host/tool mutation and did not restore the correction-3 side effect.
This is the correction-8 record; the full D077/D078 history stands.

**Decisions first.**

- **Release/deploy: NO_GO** — the two candidate battery reds stay
  CLEARED (correction 1); the remaining verified blocker stands:
  `automated_missing` serving surfaces on all three release canaries
  (re-verified in the refreshed RR/RO evidence, §2). Host env
  preconditions remain preconditions.
- **DB recovery: GO_WITH_EXACT_LIMITS** — A1a (superuser install of the
  UNTRUSTED pgstattuple) and **A1b now bound to the exact read role
  `adsecute_app`** (server-produced `quote_ident` identifier; exact
  GRANT/REVOKE/`has_function_privilege` read-back in the packet), plus
  A3 scheduling. **No valid production plan exists; totals UNKNOWN**; A4
  sequence-blocked. The long planner was NOT rerun.

Operating class: **PREPARE + PRODUCTION READ-ONLY** plus this
correction's bounded audit/harness/ledger fixes. No commit, push, PR,
dispatch, deploy, image publish, migration/DDL, extension install, role
grant/revoke, compaction/DELETE/VACUUM/REINDEX, provider/Meta write,
activation, or automation enablement. Host/tool state: correction 3 DID
mutate Corepack's default via `corepack prepare pnpm@latest --activate`
(disclosed above; not restored — restoration is out of bounds);
correction 4 performed read-only version/path probes only and made no
new host/env mutation. Automation remains OFF and effective fail-closed
for all six businesses.

Skill gate: bridge
`03a0790396b65596d4a9de7df223a900374a89319ffad924fbbe5ad29b57d88b`,
canonical
`985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`;
rejection pins — all eight records, recomputed and matching at task
start: original `fac881de3…f504d9d`, correction 1 `5d9e8de06…3a3cef`,
correction 2 `da22e9b9e…ab9b07`, correction 3 `0c1599943…a00574`,
correction 4 `968366de8…adf1db`, correction 5 `464997c5d…f23f45`,
correction 6 `4257f1166…d5d10c`, correction 7
`3e402717474920eb8a91f64fc628984a339150ff22c1d2f1bd9131ba3729b85a`.

Labels: **[fact]**, **[inference]**, **[assumption]**, **[unknown]**.

## 1. Candidate identity

[fact] Branch `codex/meta-disabled-readiness-20260829`; HEAD = local
`main` = `origin/main` = `babf158e150fd33057117b39b175da044ac62d2e`.
The final corrected tree is pinned by the manifest generated LAST
(v3 contract, self-excluded): **286 pinned non-self files** (89 runtime,
94 tests-only, 2 migration, 1 deploy config, 2 runtime deletions, 16 ops
scripts, 10 audit scripts, 28 docs, 44 generated evidence — the counts
the generator asserts equal between the release packet and the manifest
at generation time), including ALL EIGHT Codex rejection records
(original `fac881de3…f504d9d`, correction 1 `5d9e8de06…3a3cef`,
correction 2 `da22e9b9e…ab9b07`, correction 3 `0c1599943…a00574`,
correction 4 `968366de8…adf1db`, correction 5 `464997c5d…f23f45`,
correction 6 `4257f1166…d5d10c`, correction 7
`3e402717474920eb8a91f64fc628984a339150ff22c1d2f1bd9131ba3729b85a`),
the PORTABLE canonical whole-shell log, the fail-closed portable guard,
the `d077-whole-shell-proof.ts` builder and the canonical
`d077-provenance-contract.ts` state machine. Earlier counts (217/265;
219/276/275; 220/278/277; 220/280/279; 220/281/280; 220/284/283;
220/285/284; 220/286/285) are historical context only.

## 2. Production read-only evidence (refreshed under the bounded runner)

Mechanism [fact]: ONE `REPEATABLE READ READ ONLY` transaction over the
repository tunnel (untouched), `SET LOCAL
statement_timeout='120000ms'`, unique `application_name
d077_recovery_preflight_c1_1788100231481`, in-transaction proof of
read-only/isolation/timeout/app-name, ROLLBACK via sentinel; the
collector run itself was executed under the correction-2 bounded runner
(external timeout 540 s, did not fire; 75.5 s; teardown read-back
recorded in the ledger). Retrieved **2026-08-30 14:30:32.38481+00**.

All previously verified facts re-confirmed unchanged [fact]: fence
5,368,750,080 B vs 5,368,709,120 B; ingestion admission-refused since
2026-08-22 14:53:48Z; D075/D077 schema absent; pgstattuple 1.4/1.5
`trusted=false, superuser=true`, not installed; six-business outcome
rows 0; automation effective fail-closed for all six (IwaStore
`stopped_kill_switch` with `auto_execution_enabled=false`,
`readiness_tier='manual_review'`; five `fail_closed_not_configured`);
serving freshness INSIDE the same transaction: canaries IwaStore 3 /
TheSwaf 3 / Grandmix 23 `automated_missing`, non-canaries 0; coverage
checksum recomputed live =
`18ea0e86085f2086d4d113a9239af9439648a2cec4aecd9907262ef2fff7fc39`
(pinned algorithm; collector refuses on mismatch); `n_live_tup`/
`n_dead_tup` labeled planner estimates.

**New in correction 2 [fact]**: the collector captures the exact role
identity in-transaction — `current_user = adsecute_app`,
`quote_ident(current_user) = adsecute_app` — a role name, not a
credential; no password/DSN/token/cookie/approval token is serialized
anywhere. Capabilities unchanged: non-superuser, database CREATE=true
(irrelevant for an untrusted extension), NOT a member of
`pg_stat_scan_tables` or `pg_monitor`. The A1a/A1b split therefore
stands on refreshed evidence, and packet A1b now carries the exact
executable SQL:
`GRANT EXECUTE ON FUNCTION pgstattuple_approx(regclass) TO adsecute_app;`
(alternative `GRANT pg_stat_scan_tables TO adsecute_app;`), the exact
REVOKEs, and the role-specific
`has_function_privilege('adsecute_app', 'pgstattuple_approx(regclass)',
'EXECUTE')` before/after read-back with a read-only smoke.

## 3. Planner provenance (unchanged from correction 1)

No valid plan; totals UNKNOWN. The 300 s attempt timed out honestly; the
600 s no-output planner processes were terminated by the Codex
supervisor after bounded waiting (final planner SIGINT); zero output,
zero writes. The `sleep 900` watcher history is recorded. The planner
was not rerun in correction 2.

## 4. Canonical database-seam proof — the ACTUAL whole shell

[fact] `bash scripts/verify-database-seams.sh` was executed as ONE
serial command on the final code under a bounded supervisor (configured
timeout 1800 s, did not fire; new process group; stdout+stderr to a log
FILE, never a captured pipe): **exit 0, 488.4 s, all 38 canonical stage
headers in order, final line `[verify-db-seams] PASS — 38 stages`**. The
log (494,380 bytes) is content-hashed in the ledger
(`a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`)
and carries the release-boundary evidence the correction-1 extraction
missed executing: the stage-24 header "Ordinary deploy refuses a
cutover-required release", the marker/manifest agreement line
`no cutover pending: deploy/CUTOVER_REQUIRED absent` (with
`cutover_required=no` pinned in the wrapper-manifest line), the
runbook/installed-wrapper checks, and release-owner as the LAST stage.
**This whole-shell run is the authoritative database-seam equivalence
proof.** The correction-1 51-command extraction is retained ONLY as
supplemental historical detail, explicitly labeled non-equivalent (it
omitted the executable lines 184–216 shell logic).

The known task-owned `sleep 900` watcher reappeared after the shell had
already exited 0: its provenance was proven first (PGID = this run's
process group 84464; PPID 1 orphaned; cwd the repo; fd1/fd2 open on THIS
run's log file), then it alone received SIGTERM; the log content hash
was unchanged after, so no shell/test/DB result was affected. The daily
`adsecute-runtime-pg-*` temp directories (mtimes 03:35 on Aug 28/29/30)
are NOT task-owned and were left untouched. The 15432 tunnel (pid
38894) was never touched.

## 5. Verification ledger — repaired truth model

`generated/d077-correction1-verification-ledger-2026-08-30.json`
(contract `adsecute.d077.correction2-verification-ledger.v2`) [fact]:

- `stages`: uniformly-schema'd, timestamped, EXECUTED correction-2
  stages — every entry has exact command, start/end UTC, duration, exit
  code, counts or an explicit not-applicable object,
  `timeout{configuredSeconds, timedOut}` and teardown evidence; the
  generator refuses any entry missing a field. Includes: the refreshed
  production collector (75.5 s / 540 s timeout), the whole-shell
  canonical run (488.4 s / 1800 s), the watcher termination record,
  focused tests (route-authority 5/5, tombstone 2/2, launchpad contract
  43/43), check:workflows, typecheck, changed-file ESLint,
  `git diff --check`, side-effect scan, and D078 closure guards 45/45.
- `historicalFailFirstEvidence`: the RAW correction-1 fail-first logs
  embedded verbatim and content-hashed (route-authority red; the exact
  `{"ok":false,"refusal":"execution_not_ready"}` launchpad refusal),
  with timing explicitly UNKNOWN — a recorded limitation, not invented
  evidence.
- `supplementalCorrection1Records`: the 71 correction-1 records,
  explicitly limited (no timeout/teardown captured; reasons recorded)
  and explicitly NOT the canonical seam equivalent. The prior full
  unit-suite green (13,683 passed / 0 failed) is preserved there as
  historical proof and was deliberately not rerun to repair audit
  metadata.
- `teardownReadback`: distinguishes no task-owned processes / no
  ephemeral DB listeners / the untouched pre-existing tunnel / the
  INTENTIONALLY RETAINED Claude evidence scratchpad (fail-first logs,
  runner sources, planner logs — embedded or hashed where required;
  retained evidence, not database/process residue).

The durable guard
`lib/meta/__tests__/d077-artifact-hash-contract.test.ts` recomputes
every embedded hash under its declared basis, asserts manifest
self-exclusion and packet/manifest count equality, validates the
portable whole-shell evidence by fresh proof recomputation, validates
the structured pnpm/Corepack provenance contract, the pinned coverage
checksum, and the exact A1b role binding. The CURRENT focused-guard
counts are stated exactly once, in the correction-8 result block of the
preamble; no other section restates them. (HISTORICAL, superseded:
correction 6 ran 13 tests, correction 7 ran 16 — their exact splits are
recorded in their own labelled preamble blocks above.)

## 6. Data quality (unchanged verdicts)

Recovery-readiness preflight SUFFICIENT; decision-quality INSUFFICIENT
(8-day-stale generations); observed-outcome INSUFFICIENT (six-business
outcome rows ZERO); offline policy/counterfactual INSUFFICIENT; causal
INSUFFICIENT. No concealment: outcome evidence is zero.

## 7. Packets

Both regenerated by the inspected generator, every embedded hash
declaring algorithm+basis and recomputing from the written file:

- Release packet (v2 contract, **NO_GO**): cleared-blocker ledger,
  remaining verified serving blocker, preconditions-not-read-backs,
  final-tree reference (286 non-self, class totals asserted equal to
  the manifest at generation), workflow inputs, migration safety,
  canary order, read-backs, rollback `babf158e1…`, stop conditions.
- DB-recovery packet (v2 contract, **GO_WITH_EXACT_LIMITS**): verified
  privilege facts with the EXACT role; A1a superuser install; A1b exact
  quoted grant/revoke/read-back for `adsecute_app` (NOT executed); A2
  release dependency; A3 exact dry-run command; A4 execution contract
  (max deletions bound to the fresh plan; deletion irreversibility);
  A5 ordinary-vacuum honesty (raw bytes may not fall; no silent
  VACUUM FULL/pg_repack/shrink); A6 re-admission observation; A7
  separate physical-shrink approval. Planner insufficient until BOTH
  extension availability AND executable measurement are proved.

Generation order held: focused verification → refreshed evidence →
ledger+packets → this report → manifest LAST; no pinned file written
afterward.

## 8. Remaining blockers

Release: the serving `automated_missing` canary blocker (operator triage
or explicit acceptance) + host-env precondition reads. DB recovery: A1a,
A1b (exact SQL ready), then release → A3 fresh plan → A4 under zero-write
drift refusals. Automation activation stays a separate, later operator
decision — nothing here authorizes it.
