# D077 production-recovery preflight correction 2 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 2 as an acceptance/freeze package.** The whole
database-seam run, refreshed production read and conservative operating verdicts
are substantially supported, but the machine-readable ledger and DB-recovery
packet still contain exactness/provenance defects. Release/deploy remains
`NO_GO`; automation remains OFF/effective fail-closed; no valid production D077
plan exists; plan hash, removable rows and protection totals remain `UNKNOWN`;
A4 remains sequence-blocked. This document does not authorize a deploy, DDL,
extension/grant, compaction, provider write, historical replay, or ad activation.

Claude's correction-2 response was final and its chat was `Idle` before this
review. Codex and one bounded independent Codex auditor then performed read-only
artifact checks and focused local verification. Codex ran no production SQL in
this acceptance review.

## Acceptance blockers

1. **The required exact pnpm runtime version is absent.** The correction prompt
   explicitly required Node, npm, pnpm, Vitest, PostgreSQL and tsc versions.
   `runtimeVersions` records only a `pnpmLayoutNote`; the inspected generator
   never executes `pnpm --version`. The current executable reports `11.19.0`.
   Add an exact `pnpm` version field generated the same way as the other runtime
   versions, retain the layout note only as supplemental context, and guard the
   required version keys in the durable hash-contract test.

2. **The whole-shell stage's `counts` field is materially misleading and the
   required header order is not durably recorded.** The authoritative command
   really exited 0 after 488.4 seconds and its retained, hashed log really ends
   with `[verify-db-seams] PASS — 38 stages`. But the ledger reports
   `passed: 53` because the runner takes only the first Vitest count match from a
   heterogeneous shell containing many test commands. That is not the whole
   shell's test count. The hashed log contains multiple Vitest summaries, and
   summing them would also be an unsafe substitute for the shell's canonical
   acceptance unit. Record `counts` as not applicable with an exact reason for
   this composite shell, and add a dedicated machine-readable proof containing
   the exact 38 ordered stage numbers/titles parsed from the retained log, final
   PASS line, log bytes and SHA. Validate sequence 01..38, source-header equality
   against `scripts/verify-database-seams.sh`, release-owner as the last stage,
   and the release-boundary evidence. The artifact generator/hash-contract test
   must fail if this proof drifts.

3. **The DB packet misattributes the refreshed role fact to the earlier
   transaction.** The packet's combined `privilegeFacts.verifiedAtUtc` remains
   hard-coded to `2026-08-30 13:43:16Z`, while the exact `adsecute_app` identity
   and associated capability record were captured in the correction-2 RR/RO
   transaction at `2026-08-30 14:30:32.38481+00`. Separate provenance when facts
   came from different reads, or bind the role/capability provenance directly to
   the refreshed evidence transaction timestamp/application name. Do not imply
   that the exact role was observed in the earlier transaction. Keep A1b exact
   and unexecuted.

4. **Regenerate and freeze in dependency order.** Correct the runner/generator,
   ledger, packet and report; add focused regression assertions for all three
   blockers; regenerate embedded hashes and packets; include both prior
   rejection records byte-for-byte; generate the non-self manifest last; and
   make no later write to any pinned file. Do not rerun production SQL, the long
   planner or the 488-second database-seam command merely to repair deterministic
   serialization. Reuse the already retained, content-hashed raw log and evidence
   only after independently rechecking their SHA/provenance. Do not start the
   historical replay in this correction.

## Checks that passed

- All five embedded artifact hashes recomputed under their declared
  `JSON.stringify(..., null, 1)` basis.
- The correction-2 manifest matched 277 non-self entries, 278 expanded entries
  and 220 Git porcelain records before this rejection file was added; all 277
  pinned path/status/SHA records and class counts matched. Both earlier rejection
  hashes matched their pinned bytes.
- The whole `bash scripts/verify-database-seams.sh` run is genuine: exit 0,
  488.4 seconds, 494,380-byte retained log, SHA-256
  `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`,
  exact ordered headers 01..38, stage 24 release boundary and release-owner last.
- Production evidence captures `adsecute_app` inside one RR/RO transaction at
  `2026-08-30 14:30:32.38481+00`; A1b names that exact role and remains
  unexecuted. The defect is packet provenance, not the role string or SQL shape.
- Focused hash-contract re-run passed 3/3 and `git diff --check` was clean.
- No task-owned D077/seam/PostgreSQL process remained; only the pre-existing SSH
  tunnel PID 38894 listened on `127.0.0.1:15432` and was untouched.
- Automation remains OFF/effective fail-closed, manual Test/Main labels have no
  runtime/UI authority, no Meta/provider mutation occurred, and no deploy,
  DDL/grant, compaction, planner or history replay was executed.

Correction 3 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will then independently recompute the corrected freeze.
