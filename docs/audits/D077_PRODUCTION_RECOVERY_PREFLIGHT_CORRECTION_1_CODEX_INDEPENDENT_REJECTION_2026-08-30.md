# D077 production-recovery preflight correction 1 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 1 as an acceptance/freeze package.** This is a
verification-provenance rejection, not a rejection of the conservative operating
decisions. Release/deploy remains `NO_GO`; automation remains OFF/effective
fail-closed; no valid production D077 plan exists; plan hash, removable rows and
protection totals remain `UNKNOWN`; A4 remains sequence-blocked. This document
does not authorize a deploy, DDL, extension/grant, compaction, provider write, or
ad activation.

The Claude correction was final and its chat was `Idle` before this review. Codex
then performed an independent, read-only artifact audit plus bounded local test
re-runs. No production SQL was run by Codex in this acceptance review.

## Acceptance blockers

1. **The claimed canonical database-seam equivalence is incomplete.** The
   correction ledger jumps from `seams.30` =
   `bash -n .github/scripts/hetzner-remote.sh` to `seams.31` =
   `npm run test:deploy-gate-ordering`. The canonical
   `scripts/verify-database-seams.sh` executes additional release-boundary logic
   between and after those commands: the `deploy/CUTOVER_REQUIRED` versus
   `scripts/cutover-wrapper.manifest` agreement, the required marker grep, the
   installed-wrapper runbook check, the conditional marker-path check, and the
   prohibition on the repository wrapper path (canonical script lines 184–216).
   Those executable checks do not appear in the ledger. Therefore the report's
   claim that all 51 ledger commands reproduce the canonical script in exact
   order is false. Run and ledger the **actual canonical script as a whole**
   (serially and with a bounded supervisor), rather than reconstructing it by
   extracting selected command lines.

2. **Rejection blocker 6 (machine-readable verification provenance) is not
   closed.** Across 71 ledger records there are zero timeout fields and zero
   teardown fields. `failfirst.route-authority`,
   `failfirst.launchpad-seam`, and `production.evidence-collector` lack
   start/end UTC and duration; the explanatory launchpad detail record also lacks
   timing and exit code. The report nevertheless claims every stage has exact
   start/end, duration, exit and parsed counts. Separate historical fail-first
   evidence from timestamped canonical stages, preserve/embed its exact raw
   output and explicitly label unavailable timing as unknown. Re-run the current
   production read-only collector under the timestamped bounded runner. Record
   timeout policy/result and teardown/residue evidence explicitly; use
   not-applicable/null with a reason rather than omitting a field.

3. **The required current-role identity is absent.** The correction prompt
   required the production collector to capture current role identity and role
   capabilities. The collector intentionally omits the role name and the DB
   packet leaves A1b as `TO <app role>`. Capabilities are measured, but the
   least-privilege grant packet is not exact/executable until the target role is
   unambiguously named. Capture `current_user` (a role name is not a credential),
   retain the existing capability checks, and bind A1b's grant/revoke/read-back
   SQL to that exact role. Do not expose a password, DSN, token, or secret.

4. **Teardown wording and retained evidence need reconciliation.** No task-owned
   D077 process or ephemeral PostgreSQL listener remained at review time, and the
   pre-existing `127.0.0.1:15432` SSH tunnel remained untouched. However the
   Claude scratchpad `.../scratchpad/d077/` still contains the fail-first logs,
   ledger source, runner and planner logs, while the final response claimed there
   were no D077 temp directories. Do not delete evidence before it is durably
   captured. Either embed/hash the required raw logs and then clean the
   task-owned scratch area, or state precisely that the evidence scratchpad was
   intentionally retained; distinguish it from ephemeral database/process
   residue.

5. **The regenerated freeze must include this rejection and must again be made
   last.** Fix the inspected generator/ledger/report/packets first, regenerate
   production evidence under one proved RR/RO rollback transaction, generate the
   non-self manifest last, and make no later write to a pinned file. Do not rerun
   the long D077 planner and do not start historical replay in this correction.

## Checks that passed

- The original rejection record remained byte-identical:
  `fac881de3bf4e7285fdca5fe25b6d26d103c61171e0ebfdc0a69002c2f504d9d`.
- All five embedded hashes independently recomputed under their declared
  `JSON.stringify(..., null, 1)` basis.
- The manifest contained 275 unique non-self entries matching the exact current
  Git path/status set; every non-deleted per-file SHA matched; the two declared
  deletions were absent; class totals matched the release packet; the expanded
  count was 276 including the manifest; Git porcelain count was 219. The
  manifest external SHA was
  `aa5e33968689d8fac24ddeec929aabd2a8f25c37a1dc8a5da7d19ab1e360c0ae`.
- The production collector structurally uses one transaction-bound connection,
  sets and proves `REPEATABLE READ READ ONLY`, a bounded statement timeout and a
  unique application name, and exits through a rollback sentinel. No production
  write statement is present in the inspected collector.
- The extension read-back correctly reports pgstattuple 1.4/1.5 as
  `trusted=false`, `superuser=true`, the app role as non-superuser with database
  CREATE, and no `pg_stat_scan_tables`/`pg_monitor` membership. The A1a/A1b split
  is directionally correct; blocker 3 concerns the missing exact target identity.
- Six-business automation controls, serving-freshness reads, seven-line coverage
  checksum, planner provenance, estimates, and data-quality labels are
  conservatively represented. Outcome rows remain zero; no causal or realized
  counterfactual claim is accepted.
- Independent bounded re-runs passed: route-authority 5/5; campaign-label
  tombstone 2/2; launchpad contract 43/43; canonical launchpad ephemeral seam
  negative control 53 skipped, store 26/26, route 27/27. `git diff --check` was
  clean and the test PostgreSQL listener/process was removed.
- Skill bridge and canonical hashes independently matched their pins; the Claude
  bridge still directs every task to re-read the canonical Codex skill.

Correction 2 may be submitted only after it is final and the Claude chat is
`Idle`; Codex will then independently recompute the corrected freeze again.
