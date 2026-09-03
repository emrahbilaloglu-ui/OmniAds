# D077 production-recovery preflight correction 7 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 7 as an acceptance/freeze package.** Correction 7
closes every specifically enumerated correction-6 mutation, introduces separate
resolver/direct-execution measurements, fixes chronology and report summaries,
and freezes a coherent current ledger. Its replacement validator nevertheless
still trusts redundant summary fields instead of deriving one canonical state
from the measured steps, so additional material contradictions pass. Release
remains `NO_GO`; automation remains OFF/effective fail-closed; no valid
production D077 plan exists; plan hash, removable rows and protection totals
remain `UNKNOWN`; A4 remains sequence-blocked. This record authorizes no deploy,
production SQL, DDL, extension/grant, compaction, provider write, activation,
historical replay or host/tool-state change.

Claude's correction-7 response was final and the Adsecute chat was `Idle` before
review. Codex and one bounded independent Codex auditor performed read-only
checks. No production SQL ran.

## Acceptance blocker

**The two-step validator is still fail-open because it validates fields
piecemeal rather than recomputing a canonical probe state.** Independent
in-memory mutations proved that all of the following are accepted:

- a path-lookup `not_found` with resolver exit `0` and empty stdout; the rule
  rejects exit 0 only when stdout starts with `/`
  (`d077-provenance-contract.ts:491-510`);
- invented live top-level `command` and `resolutionMechanism`; neither is
  generically validated or bound by the live ID rules (`:401-445`, `:530-599`);
- invented `ExecutedStep.commandForm`; validation requires only a non-empty
  string rather than equality with executable+argv (`:360-386`);
- resolved `codex-fallback-pnpm` with `explicitPathExists=false`; resolved state
  does not require the existence observation to be true (`:555-579`);
- `execution_error` despite direct exit 0, no signal/error and otherwise
  successful output; no execution-error implication is enforced (`:471-527`);
- an arbitrary `99.99.99` result under the exact fallback ID when direct stdout
  is changed to match; the version check is only an unanchored semver fragment;
- top-level `observedAtUtc` differing from the terminal measured-step timestamp;
- a resolved path lookup whose resolver exited nonzero;
- resolver stdout containing two newline-separated absolute paths, with the
  combined string reused as resolvedPath/executable; success checks only
  `startsWith("/")` (`:217-245`, `:543-547`);
- non-null `spawnErrorMessage` with null `spawnErrorCode`; only field types are
  checked (`:373-379`);
- retained C4 carrying extra legacy `stderr`/`signal` properties, because
  unknown object keys are accepted despite the every-field claim (`:600-619`).

Correction 8 must replace the patchwork implications with one canonical,
exhaustive state machine. For each exact probe ID, derive resolution,
resultClass, resolvedPath, reportedVersion and top observation time solely from
strictly validated tagged measurement steps; compare any serialized summary to
that derivation (or remove redundant summaries). Require exact object key sets,
exact command/mechanism bindings and canonical command rendering; strict
single-absolute-path resolver stdout; coherent status/signal/error-code/error-
message tuples; explicit-path existence state; success/error class exclusivity;
terminal-step time equality; and the frozen current version outputs for this
audit package. Invalid/malformed measurements must be refused, never converted
to `not_found`. Add one table-driven transition matrix covering every allowed
state and all contradictions above, plus property-style single-field mutation
coverage of the frozen valid probes. This should be the final validator design,
not another list of independent substring checks.

Regenerate/freeze narrowly after the state machine passes. Preserve the
portable whole-shell log byte-for-byte. Pin all eight rejection records
(original plus corrections 1-7), generate the manifest last, and do not write a
pinned file afterward. Do not rerun production SQL, the planner, canonical
whole-shell command or historical replay.

## Checks that passed

- Focused guard: one file, **16/16 passed**, zero skip/failure.
- Every explicitly named correction-6 mutation now rejects: impossible calendar
  date; exit-0+absolute-path not_found; fake fallback path; altered retained
  mechanism; arbitrary scoped path; wrapped mutation command. Unknown-dominant
  tri-state returns `unknown`.
- Current ledger chronology and serialized observations are coherent; every
  exact observation precedes `generatedAtUtc`.
- External SHA-256: report
  `7e4c9218a7f6f45bbd05b4a1919b8c5bb2e6fc1fe0a3755c90f7c460c1bde989`,
  ledger `393e27b0196cd3ad8aa0b5736721836e550760e35314625e2af350fdf6e77568`,
  release packet
  `f6934d61ad17359785860f73dcfad599d5506a995ead916495557ff58bed1931`,
  DB packet
  `03cd5c33ea96334a5a6801761e956f13257d65d30993aefb8a10e6b9c3a91dd5`,
  manifest
  `8c55edf62cdd8826306a6443a6ee0bf1259ce507db3b92784b41d75f67682903`,
  evidence unchanged
  `eb9c94fb37a6eea131de16e5866206b21c6b22fabe805bb7faa7b4056f5a1cd1`.
- Manifest: 285 non-self / 286 expanded / 220 porcelain; exact path/status/SHA
  and classes; self-exclusion; packet equality; all seven prior rejection pins;
  redone manifest last with no later pinned mtime.
- Report current summaries are coherent: seven pins, one current 16/16 block,
  285 non-self; older values are explicitly historical. The invalidated first
  freeze and redo are disclosed.
- Portable log remains repository-relative and manifest-pinned: 494,380 bytes,
  SHA-256
  `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`;
  fresh 38-stage proof passed.
- DB RR/RO provenance, exact `adsecute_app`, untrusted pgstattuple and
  unexecuted A1a/A1b remain coherent. High-confidence secret scan was clean;
  `git diff --check` was clean. No task-owned D077/Vitest/test-PostgreSQL/
  watcher residue remained; the pre-existing SSH tunnel PID 38894 on
  `127.0.0.1:15432` was untouched.

Correction 8 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will independently mutation-test the canonical transition
matrix once, then either accept or report a concrete artifact inconsistency.
