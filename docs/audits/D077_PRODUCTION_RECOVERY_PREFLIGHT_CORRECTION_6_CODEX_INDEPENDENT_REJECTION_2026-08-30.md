# D077 production-recovery preflight correction 6 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 6 as an acceptance/freeze package.** Correction 6
faithfully represents the currently unresolved Claude-shell probe and the
retained correction-4 observation, closes the three contradictions identified
in the correction-5 rejection, and passes its current 13-test suite. The
successful resolver branch nevertheless still discards part of its own
measurement, the validator accepts additional material contradictions, and the
pinned report contains stale rejection/count summaries. Release remains
`NO_GO`; automation remains OFF/effective fail-closed; no valid production D077
plan exists; plan hash, removable rows and protection totals remain `UNKNOWN`;
A4 remains sequence-blocked. This record authorizes no deploy, production SQL,
DDL, extension/grant, compaction, provider write, activation, historical replay
or host/tool-state change.

Claude's correction-6 response was final and the Adsecute chat was `Idle` before
review. Codex and one bounded independent Codex auditor performed read-only
checks. No production SQL ran.

## Acceptance blockers

1. **The successful `command -v pnpm` branch does not preserve both
   measurements.** The generator branches on the actual resolver result, but
   when resolution succeeds it serializes only the later direct `--version`
   execution's status/signal/stdout/stderr/error fields
   (`d077-correction1-artifact-generator.ts:107-143`). The resolver's own exit
   status, stdout, stderr, signal and `result.error` are discarded. This is not
   the correction-5 rejection's required faithful two-step record and
   contradicts the report's claim that resolver status/stdout/stderr/error are
   preserved. Represent resolution and direct execution as separate structured
   measurements; do not overload one field set.

2. **The validator remains materially fail-open.** Independent in-memory
   mutation tests proved that all of the following are accepted:

   - calendar-impossible `2026-02-31T12:00:00Z` as a strict timestamp, because
     regex plus `Date.parse` normalizes it (`d077-provenance-contract.ts:84-88`);
   - `resultClass="not_found"` + unresolved with exit status `0` and an absolute
     pnpm path in stdout; the rule checks only resolution (`:189-190`);
   - a live exact probe ID with invented command, mechanism, path and version;
     live-ID binding checks only present-tense/not-unmeasured (`:220-226`);
   - the retained C4 probe with invented stderr, signal and resolution
     mechanism, despite the validator claiming an exact binding (`:202-219`);
   - arbitrary inspected paths and invalid non-null mtime strings; the scoped
     inspection validates only non-empty array/enums (`:228-258`);
   - `correction3CorepackMutation.command="echo corepack prepare was not
     executed"`, because the mutation proof uses only a substring check
     (`:239-242`).

   Exact probe IDs must be bound to explicit per-step schemas and allowed
   commands/paths/results. `not_found` must require a failed resolver
   measurement and no resolved-path stdout; execution errors must remain
   distinguishable. Validate actual calendar instants by round-trip, bind the
   two exact Corepack tracked paths and strict/null mtimes, and bind the known
   correction-3 mutation command exactly rather than by substring.

3. **The scoped tri-state violates the required unknown-dominant rule.** With
   one inspected path having an unknown before/after mtime and another path
   changing, `deriveScopedChange` returns `"true"` because change is checked
   before unknown (`:94-108`). The governing rule is: any required mtime unknown
   => `unknown`; otherwise any difference => `true`; otherwise `false`. Add a
   negative/regression case for the mixed unknown+changed input.

4. **The pinned report is not self-consistent.** Its skill-gate rejection
   summary lists only the first three rejection pins
   (`D077_PRODUCTION_RECOVERY_PREFLIGHT_2026-08-30.md:187-193`) even though a
   later section lists six. It retains a 12/12 + five-rejection-record paragraph
   at `:126-132` while the current result is 13/13 at `:326-340`. It also says
   the release packet references 283 non-self files at `:354-358`, while the
   packet and manifest both contain 284. Correction 7 must present prior-stage
   numbers only as explicitly historical facts and make every current summary
   use the final correction-7 counts and all seven rejection records (original
   plus corrections 1-6).

5. **Regenerate/freeze narrowly.** Change only the two-step probe schema and
   construction, validator/tests, stale report text and derived artifacts.
   Preserve the portable whole-shell log byte-for-byte. Add would-have-failed
   tests for every accepted contradiction above. Run focused checks serially;
   regenerate ledger/packets/report; pin all seven rejection records; generate
   the manifest last and do not write a pinned file afterward. Do not rerun
   production SQL, the planner, the canonical whole-shell command or historical
   replay.

## Checks that passed

- Focused guard: one file, **13/13 passed**, zero skip/failure.
- All five embedded hashes recomputed under their declared basis: evidence
  `74c0078d…e90e1`, ledger `ec9fedea…5468`, release packet
  `471d7834…02f`, DB packet `ab320c27…dd1e`, manifest
  `62808a09…175e`.
- Manifest external SHA-256
  `28b7b463618934e7d3b4a3b0e847b7ae2bb680f95b2933986f32fa34bccd39f6`:
  284 non-self / 285 expanded / 220 porcelain; exact path/status/per-file
  SHA and classes; release-packet equality; self-exclusion; all six prior
  rejection pins; no later pinned mtime.
- Portable log: repository-relative, manifest-pinned, 494,380 bytes, SHA-256
  `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`;
  fresh 38-stage proof recomputation passed.
- Current ledger values themselves are coherent: Claude shell unresolved;
  direct fallback pnpm `11.19.0`; Corepack program `0.34.2`; retained C4
  `11.24.0` with unmeasured path/null time.
- DB RR/RO provenance, exact `adsecute_app`, untrusted pgstattuple and
  unexecuted A1a/A1b remain coherent. Coverage recomputes to seven selected
  accounts across six businesses with checksum
  `18ea0e86085f2086d4d113a9239af9439648a2cec4aecd9907262ef2fff7fc39`.
- High-confidence secret scan was clean. `git diff --check` was clean. No
  task-owned D077/Vitest/test-PostgreSQL/watcher residue remained; the
  pre-existing SSH tunnel PID 38894 on `127.0.0.1:15432` was untouched.

Correction 7 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will independently mutation-test the complete two-step
provenance contract before acceptance.
