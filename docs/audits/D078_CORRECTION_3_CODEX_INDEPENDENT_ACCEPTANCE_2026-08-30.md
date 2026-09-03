# D078 Correction 3 — Codex Independent Acceptance (2026-08-30)

## Verdict

**ACCEPTED as the local D078 evidence package.** This acceptance closes
the five defects that caused correction 2 to be rejected. It does not
approve deployment, production recovery, physical compatibility-data
deletion, provider writes, or automation activation. Automation remains
OFF.

Claude completed one consolidated correction-3 prompt and returned to
Idle before this review began. No follow-up prompt was sent during the
acceptance pass.

## Independent checks

- Four-state workspace adapter path, exact matrix contract, and six-business
  scope guards: 4 test files, 85 tests passed.
- Serial ephemeral-Postgres proof over the actual workspace route and actual
  drawer/action wiring: route 5 passed + 1 skipped; drawer 4 passed + 1
  skipped; exit 0; teardown complete.
- Frozen matrix validation: 31 entries, 11 exact ordered switch hops, 31
  non-empty screenshots, both route/drawer proof summaries present, zero
  failures.
- Bundle embedded hash recomputation: MATCH
  (`13074631deb57836cabc3831f37172f85508c629bf16ac5d11a054be3e760be1`).
- Hard-action recompute embedded hash recomputation: MATCH
  (`ee6e440f6a684fd779832d4036488b200910a20a1e255c843335ba96583a6287`).
- `npx tsc --noEmit`: exit 0.
- Focused ESLint: exit 0.
- `git diff --check`, repository whitespace verifier, and untracked-file
  trailing-whitespace scan: clean.
- Manual-label vocabulary closure: 12 tests passed. Buyer/runtime authority
  is automatic-only; the UI does not request manual labels.
- Teardown/safety readback: ports 15544 and 3210 closed; no D078 temporary
  directory or launch entry; `META_AUTOMATION_ENABLED`,
  `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`, and
  `STATE_HISTORY_COMPACTION_ABORT` unset.

The full browser harness was not re-run after the evidence freeze because it
would overwrite the frozen matrix/report binding. Acceptance instead combined
inspection of the real click-driven harness and its frozen screenshots with an
independent re-run of the DB-backed actual-route and actual-drawer proofs.

## Bound artifacts

- D078 report SHA-256 before this acceptance-status annotation:
  `5922a0ba3192809cc40161a7ebe5c2d1adbc401e631a757394dfbc55707aef91`.
- Matrix SHA-256:
  `dd210e78b5ea572e1f24afa0f86f10515183348e77b07f4f6cde81eca540d388`.
- Evidence bundle file SHA-256:
  `9c0d83aa4541849b43096056b95f686c9673169c461d8ebb97ebb3dd86db7b47`.
- Hard-action recompute file SHA-256:
  `c08c95a12a66d04ea0f56822041d25e3c43ef8c00ecfe57c6a0c472fb1074ee8`.

## What this proves

- The real adapter preserves absent, unavailable, proven-zero, and populated
  assigned-account states distinctly.
- The actual route derives stale withholding and fresh supervised action from
  real ephemeral DB state, real cookie auth, and real posture reads, while only
  the provider-inventory boundary is mocked.
- The actual UI drawer exposes no executable stale Cut/Pause path; the fresh
  Cut opens the real confirmation ceremony without confirming or mutating the
  provider.
- The frozen scope is exactly IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR,
  and ColorFullWorldsTR, covering the seven pinned account assignments.
- Desktop/mobile business switching follows the declared ordered chain and
  proves selected and rendered identity at every hop.
- Manual Test/Main labels no longer grant buyer/runtime authority. Automatic
  campaign-role inference is authoritative; historical tables and aliases are
  compatibility-only until the separately gated deployed-release and
  persisted-payload-census migration.

## What remains blocked

The wider goal — operating Meta entirely through Adsecute — is not accepted.
The frozen production evidence still shows admission-refused ingestion since
2026-08-22 14:53 UTC, warehouse freshness frozen on 2026-08-21, decisions
roughly 183–200 hours stale, and zero outcome/experiment/calibration evidence.
Production recovery, natural-wave observation, resolver adjudication,
supervised-action outcome proof, missing budget/structure/targeting/creative
capabilities, deployment, compatibility cleanup, and a separate activation
approval remain mandatory gates.

No production write, provider mutation, deploy, activation, commit, push, or
environment change was performed by this acceptance pass.
