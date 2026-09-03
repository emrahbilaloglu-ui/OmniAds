# D077 production-recovery preflight correction 3 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 3 as an acceptance/freeze package.** The three
correction-2 blockers are substantively repaired: the composite whole-shell
stage now has a durable 38-stage proof, the exact DB-role facts are bound to the
refreshed evidence transaction, and a pnpm field exists. The submitted freeze is
still not trustworthy because its durable guard is fail-open, its pnpm runtime
attestation follows an undeclared-at-the-time host-tool mutation, and its pinned
report contains stale contradictory counts. Release/deploy remains `NO_GO`;
automation remains OFF/effective fail-closed; no valid production D077 plan
exists; plan hash, removable rows and protection totals remain `UNKNOWN`; A4
remains sequence-blocked. This document does not authorize a deploy, DDL,
extension/grant, compaction, provider write, historical replay, ad activation,
or restoration/change of the Corepack state.

Claude's correction-3 response was final and the Adsecute chat was `Idle` before
this review. Codex and one bounded independent Codex auditor then performed
read-only artifact checks and focused local verification. Codex ran no production
SQL in this acceptance review and did not alter the pre-existing SSH tunnel.

## Acceptance blockers

1. **The permanent 7-test artifact guard is fail-open.** The suite skips when
   every artifact is absent (`d077-artifact-hash-contract.test.ts:36-38`), the
   hash loop checks only the subset that happens to exist (`:39-47`), and missing
   manifest/ledger files return success (`:50-53`, `:90-93`, `:104-106`). Most
   importantly, absence of the canonical whole-shell stage returns green
   (`:128-135`). A current-tree 7/7 result therefore does not prove the guard
   fails closed. Require every named artifact, ledger stage and proof field to
   exist before testing values. The durable test must also call the proof builder
   against the retained log and the **current** seam script and compare that
   recomputation with the embedded proof; comparing two already-stored digest
   fields is insufficient protection against source drift.

2. **The pnpm provenance was changed before it was measured, and the report
   contradicts itself about that mutation.** The report discloses that
   `corepack prepare pnpm@latest --activate` updated Corepack's default before
   measurement and that the pre-probe shim value is unknowable
   (`D077_PRODUCTION_RECOVERY_PREFLIGHT_2026-08-30.md:12-18`), but later asserts
   there was no host/environment mutation (`:61-65`). The ledger's `11.24.0` is
   a post-mutation Corepack resolution and cannot attest which pnpm runtime was
   used by earlier retained stages. In Codex's current execution environment the
   explicit PATH executable is
   `/Users/harmelek/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm`
   and reports `11.19.0`, while `corepack pnpm --version` reports `11.24.0`.
   Record both command paths/resolutions as present-tense facts, mark the exact
   earlier-stage pnpm runtime `UNKNOWN` unless existing retained evidence proves
   it, and remove the false no-host/env-mutation claim. Do not run another
   `prepare`, activate, install, downgrade, restore, or other environment-changing
   command merely to repair this attestation.

3. **The pinned narrative is stale and internally contradictory.** The report's
   candidate section correctly says 279 pinned non-self files
   (`report:78-89`), but its durable-guard section still says 3/3
   (`report:200-205`) and its release-packet section still says 277 non-self
   (`report:219-223`). The current facts are 7/7 and 279. Correct every derived
   count from generated artifacts rather than copying historical values.

4. **Regenerate and freeze in dependency order.** Repair only the guard,
   runtime-provenance truth model, generator/ledger/packet wording and report;
   run the focused guard serially; regenerate embedded hashes and packets;
   preserve all prior rejection records byte-for-byte, including this record;
   generate the non-self manifest last; and make no later write to a pinned file.
   Do not rerun production SQL, the long planner or the 488-second database-seam
   command merely to repair deterministic serialization. Reuse the retained raw
   log/evidence only after SHA/provenance read-back. Do not start historical
   replay in this correction.

## Checks that passed

- The focused guard passed 7/7 on the current tree, and `git diff --check` was
  clean. This verifies current positive fixtures only; it does not cure the
  fail-open paths above.
- All five embedded artifact hashes recomputed under their declared
  `JSON.stringify(..., null, 1)` basis.
- The correction-3 manifest matched 279 non-self entries, 280 expanded files and
  220 Git porcelain records before this rejection file was added. All pinned
  path/status/SHA records and class totals matched; all three earlier rejection
  records were pinned byte-for-byte; external manifest SHA-256 was
  `79ed30a9dc34c3c16672c6f840c39f312aad81d52730191040191445408f570d`;
  and no pinned file was newer than the manifest.
- The retained whole-shell log is genuine: 494,380 bytes, SHA-256
  `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`,
  exact source-equal headers 01..38, stage-24 release boundary, release-owner
  last, and exact final `[verify-db-seams] PASS — 38 stages`. The proof builder
  itself throws on its tested deterministic contract mutations.
- DB packet provenance now equals the frozen RR/RO evidence transaction
  (`2026-08-30 14:30:32.38481+00`, application
  `d077_recovery_preflight_c1_1788100231481`) and A1b names exact role
  `adsecute_app`; no A1b SQL was executed.
- No task-owned D077/seam/Vitest/test-PostgreSQL process or listener remained.
  The pre-existing SSH tunnel PID 38894 on `127.0.0.1:15432` was untouched.
- Automation remains OFF/effective fail-closed, manual Test/Main labels have no
  runtime/UI authority, and no Meta/provider mutation, deploy, DDL/grant,
  compaction, planner or historical replay was executed in this review.

Correction 4 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will then independently recompute the corrected freeze.
