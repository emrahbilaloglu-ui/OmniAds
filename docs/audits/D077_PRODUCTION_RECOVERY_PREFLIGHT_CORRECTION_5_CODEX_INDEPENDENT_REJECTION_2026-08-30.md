# D077 production-recovery preflight correction 5 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 5 as an acceptance/freeze package.** Correction 5
successfully made the retained whole-shell evidence repository-relative,
manifest-pinned and clean-checkout portable. All current hashes, manifest rows,
DB provenance and 12 positive tests pass. The new pnpm/Corepack provenance chain
is nevertheless not faithful to its own probes, invents retained facts that the
prior frozen record did not contain, and its validator accepts material
contradictions. The report also retains a stale correction-4 paragraph. Release
remains `NO_GO`; automation remains OFF/effective fail-closed; no valid
production D077 plan exists; plan hash, removable rows and protection totals
remain `UNKNOWN`; A4 remains sequence-blocked. This record authorizes no deploy,
production SQL, DDL, extension/grant, compaction, provider write, activation,
historical replay or host/tool-state change.

Claude's correction-5 response was final and the Adsecute chat was `Idle` before
review. Codex and one bounded independent Codex auditor performed read-only
checks. No production SQL ran.

## Acceptance blockers

1. **The generator discards the result of its own `command -v pnpm` probe.** It
   runs the command at `d077-correction1-artifact-generator.ts:103-104`, but
   unconditionally serializes `resolution: "unresolved"`, `resolvedPath: null`
   and `resultClass: "not_found"` at `:105-119`, regardless of exit status and
   stdout. A successful resolution can therefore never be represented. The
   current Codex shell returns the fallback path with exit 0; Claude's earlier
   generator shell reported no path, but environment differences do not cure a
   source mechanism that ignores its measurement. Branch on the actual
   resolution result and preserve its status/stdout/stderr/error. If resolved,
   execute only the proven direct binary with `--version` under the declared
   cache-safety rule; if unresolved, record that exact result. `spawnSync` ENOENT
   must be handled through `result.error`/status, not a `try/catch` that
   `spawnSync` normally never triggers.

2. **The retained correction-4 Corepack probe invents path and time facts.** The
   correction-4 frozen ledger/rejection recorded `resolvedPath: null`; correction
   5 hard-codes `/usr/local/lib/node_modules/corepack/shims/pnpm` without rerunning
   or citing a prior measurement (`generator:201-215`). It also assigns
   `2026-08-30T18:00Z (correction-4 generation window)`, which is not a valid pure
   UTC timestamp and is chronologically impossible beside the correction-5
   ledger generated at about `15:32Z`. Preserve only what correction 4 actually
   proved: command/output `11.24.0`, path not measured, exact observation time
   unknown. Represent unknown path/time structurally (`null` / `UNKNOWN`), never
   manufacture them from a present-day installation.

3. **The validator is nontrivial but still accepts material contradictions.** An
   independent mutation audit proved all of these currently pass validation:

   - `resultClass="version_reported"` with `resolution="unresolved"`;
   - top-level `corepackTrackedStateChanged="false"` while scoped
     `changed="true"`;
   - differing non-null before/after mtimes while both changed flags remain
     `"false"`.

   The validator also treats any non-empty observation-time string as valid and
   does not bind exact probe IDs to their allowed semantic shapes. Require
   `version_reported ⇒ resolved + absolute path + exit 0 + present-tense`, bind
   top/scoped change flags equal, derive the scoped tri-state from the recorded
   before/after metadata, validate ISO timestamps for present-tense observations,
   and permit an explicitly unknown/null time only for a retained observation
   whose time was not preserved. Bind the retained C4 probe to its exact known
   facts and add would-have-failed tests for the three contradictions above plus
   impossible/invalid retained timestamps.

4. **The pinned report still contains a stale correction-4 durable-guard
   paragraph.** The upper section correctly records correction 5 and final
   12/12, but lines 302-312 still delegate the count to the correction-4 final
   response and describe the older one-test mid-freeze failure. Replace that
   entire paragraph with the current self-contained 12/12 final result and the
   correction-5 mid-freeze 10/12 manifest-dependent failure. Update every
   rejection-pin summary to include all six records after this rejection.

5. **Regenerate/freeze narrowly.** Change only the probe construction,
   validator/tests and stale report/derived artifacts. Preserve the portable log
   byte-for-byte. Run focused checks serially; regenerate ledger/packets/report;
   pin all six rejection records; generate the manifest last and do not write a
   pinned file afterward. Do not rerun production SQL, the planner, whole-shell
   command or historical replay.

## Checks that passed

- Portable log: repo file, 494,380 bytes, SHA-256
  `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`,
  byte-identical to the original capture and manifest-pinned. The ledger opens
  only the repo-relative path; the `/private/tmp` value is provenance-only.
- Focused guard: one file, **12/12 passed**, zero skip/failure. Portable-path,
  manifest-pin and fresh whole-shell proof checks are structurally CI-portable.
- All five embedded hashes recomputed: evidence
  `74c0078d3141020f8ba57f71bde20df621d0cf516f411e6fe00ecc51779e90e1`,
  ledger `e41a8bdde9b911ecb9fdde20a68e2955ef4065a7b4b28ab3a127229b0af6e185`,
  release packet
  `ccd5f09d6e8c9e20356dc4f9913d9d54b47362c5c5526c21c9658dd2ad19796f`,
  DB packet `f28415c11014a30b05bfca53118f4c1f4eff9448435df4975a10f9f28c1d1e2e`,
  manifest `058ed1b6e38b866db6c2af59b90a53925d911dce2e9c2f8a70b7d00cac60a063`.
- Manifest external SHA-256
  `26e2c19811db189497c894980e3fa24724c14dcde6782ee70d212d43a69d3c97`:
  283 non-self / 284 expanded; exact path/status/per-file SHA; exact classes;
  release-packet equality; five rejection pins; no later pinned mtime.
- DB RR/RO provenance and exact `adsecute_app` A1b remained exact/unexecuted.
  Corepack tracked-file mtimes remained at 17:56:33 local; no correction-5
  prohibited mutation command was found, but global state remains an attestation.
- High-confidence secret scan of the portable log/package found no credential,
  DSN, token, cookie, JWT or private-key value.
- `git diff --check` was clean. No task-owned D077/Vitest/test-PostgreSQL/sleep
  process or listener remained; pre-existing SSH tunnel PID 38894 on
  `127.0.0.1:15432` was untouched.

Correction 6 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will independently mutation-test the corrected provenance
contract before acceptance.
