# D077 production-recovery preflight correction 4 — Codex independent rejection (2026-08-30)

Decision: **REJECT correction 4 as a release-candidate acceptance/freeze
package.** The positive current-host mechanics pass: the focused guard is now
fail-closed against missing named artifacts/stages, fresh whole-shell proof
recomputation works, all hashes and the 280-file manifest agree, and the DB
packet provenance is exact. The package is nevertheless not self-contained or
portable: its permanent test requires a Claude-session `/private/tmp` log that
is absent from a clean checkout/CI; its pnpm provenance assertions remain partly
vacuous; and the pinned report still carries correction-3 identity and omits the
durable 9/9 result. Release/deploy remains `NO_GO`; automation remains
OFF/effective fail-closed; no valid production D077 plan exists; plan hash,
removable rows and protection totals remain `UNKNOWN`; A4 remains
sequence-blocked. This record authorizes no deploy, production SQL, DDL,
extension/grant, compaction, provider write, activation, historical replay, or
host/tool-state change.

Claude's correction-4 response was final and the Adsecute chat was `Idle` before
this review. Codex and one bounded independent Codex auditor performed read-only
artifact, test, portability and residue checks. No production SQL ran.

## Acceptance blockers

1. **The permanent guard is not portable and will fail in a clean checkout/CI.**
   The ledger binds the canonical whole-shell raw log to the user/session-specific
   absolute path
   `/private/tmp/claude-501/-Users-harmelek-Adsecute/b1c7adea-0b6c-4b08-90b1-d63cd1d97e6e/scratchpad/d077/c2/logs/canonical.database-seams-whole-shell.log`.
   The test throws if that path is absent and then reads it directly
   (`d077-artifact-hash-contract.test.ts:165-186`). The raw log is not in the
   manifest or repository. `.github/workflows/ci.yml` performs a clean checkout
   and runs `npm run test`; the default Vitest config does not exclude this test.
   The current-host 9/9 pass therefore depends on leftover Claude scratch state
   and cannot pass on a GitHub runner or another release checkout. After
   independently rechecking 494,380 bytes and SHA-256
   `a55e9f431112c557e2c3c41c6d06b4f70ab5e0b929239288243cf91575cec880`,
   preserve the raw log byte-for-byte as a repository-relative generated
   evidence file, pin it in the manifest, retain the original capture path only
   as provenance, and make the generator/test use the repository-relative copy.
   The final guard must have no runtime dependency on `/private/tmp`, a user
   home, or a Claude session.

2. **The pnpm/Corepack measured-provenance guard remains partly vacuous.** The
   generator hard-codes the Codex fallback path and checks only `existsSync`,
   while its generic version helper collapses every resolution/permission/run
   failure to one `unavailable` string. The Corepack probe records
   `resolvedPath: null` even though the command resolved and ran. The test accepts
   any non-empty version string, merely checks that a `resolvedPath` key exists,
   and accepts the correction-4 no-mutation statement if its free-form text
   contains the substring `no`; even `known mutation occurred` would satisfy
   that assertion. Measure command resolution separately and retain command,
   absolute resolved path, exit status/stdout/stderr/error class. Represent
   known booleans/enums structurally, not as substring-tested prose; validate
   the exact required probe identities and cross-field consistency. Do not
   invoke `corepack pnpm` if doing so could populate/alter absent cache; use only
   already-proven-safe read-only resolution/version mechanisms, or mark the
   unresolved value `UNKNOWN` honestly. Correction 4 made no observed change to
   the already-existing Corepack cache files (their 17:56:33 mtimes stayed
   unchanged), but a global no-mutation claim is still an attestation rather than
   proof and must be labeled accordingly. Do not prepare, activate, install,
   restore or otherwise change host/tool state.

3. **The pinned report is still not a self-contained correction-4 record.** Its
   title remains `correction 3` (`D077_PRODUCTION_RECOVERY_PREFLIGHT_2026-08-30.md:1`).
   Its durable-guard section does not record the final 9/9 result and instead
   delegates the exact count to Claude's non-manifest final response
   (`:232-242`). Retitle it correction 4/5 as appropriate, record the exact final
   focused result in the pinned report, list all five rejection records after
   this rejection is added, and derive final file/class/test counts from the
   regenerated artifacts.

4. **Regenerate and freeze in strict dependency order.** Add only the portable
   raw-log evidence and the narrow guard/provenance/report fixes; run focused
   checks serially; regenerate ledger/packets/report; preserve all five rejection
   records byte-for-byte; generate the non-self manifest last and write no pinned
   file afterward. Do not rerun production SQL, the long planner, or the
   488-second database-seam command. Do not start historical replay in this
   correction.

## Checks that passed

- Current-host focused run: one file, **9/9 passed**, zero skipped/failed.
  Skip/early-return paths from correction 3 are gone. This is positive-fixture
  evidence only because the external scratch log still exists on this host.
- Fresh `buildWholeShellProof` recomputation passed for the retained
  494,380-byte log: exact SHA, ordered headers 01..38, current-script equality,
  stage-24 boundary, release-owner last, and exact final PASS.
- All five embedded hashes recomputed under their declared
  `JSON.stringify(..., null, 1)` basis: evidence
  `74c0078d3141020f8ba57f71bde20df621d0cf516f411e6fe00ecc51779e90e1`,
  ledger `4f2c38aced2c519b1831da77dbcc9389773b94dc71f2f2ac70725e99250583d5`,
  release packet
  `88092679aca51b0033bca2f578f157ed3698746e11ea51fc38797e486dc1d5a1`,
  DB packet `2bb966c17ffa40b96c2542290d9792402f613de1a52c4ffae75961e277a053a4`,
  manifest `abe2c5ad2a52ae8dffbe1d583e389c27780b86bc5d3a71443493901ca1c3cc2a`.
- Manifest external SHA-256
  `cc78b3bf4dc06329a950a5833cf23b25d260453d1a613a37c355ef6241f3af04`:
  280 non-self / 281 expanded; exact path/status/per-file SHA and classes
  `89/94/2/1/2/16/9/24/43`; release-packet equality; self absent; all four
  earlier rejection pins exact; no newer pinned mtime.
- DB packet provenance exactly equals the frozen RR/RO evidence transaction
  (`2026-08-30 14:30:32.38481+00`, application
  `d077_recovery_preflight_c1_1788100231481`, role `adsecute_app`); A1b remains
  unexecuted.
- `git diff --check` was clean. No task-owned D077/Vitest/test-PostgreSQL
  process or listener remained; the pre-existing SSH tunnel PID 38894 on
  `127.0.0.1:15432` was untouched.

Correction 5 may be submitted only after its response is final and the Claude
chat is `Idle`; Codex will independently test the portable clean-checkout
contract before accepting it.
