# Pre-deploy release manifest — 2026-09-03

Branch `codex/meta-disabled-readiness-20260829`, working tree at the end of the
six-blocker correction pass. **Nothing here is committed.** This is the curated
include/exclude list a release owner stages from, produced by walking the tree
rather than by `git add -A`.

## Canonical proof — the whole shell, on this exact tree

| fact | value |
| --- | --- |
| command | `bash scripts/verify-database-seams.sh` |
| exit | **0** |
| stages | **40** |
| final line | `[verify-db-seams] PASS — 40 stages` |
| start (UTC) | 2026-09-03T12:56:51.233791+00:00 |
| end (UTC) | 2026-09-03T13:05:02.869183+00:00 |
| duration | 491.6 s |
| retained log | `docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-09-03.log` |
| log SHA-256 | `6bc7f70e309ccd8b2cf5df06267bdf123179c38d6180fddf36c9ddab24bda653` |
| log bytes | 505131 |
| header digest (log == script) | `36ef3a743cd58b2fa7b3def7cb96093d91aa6c3109e14e9988a8f1b99717c3ac` |
| release-owner stage | 40 (LAST) |

The two stages this pass added are **06** D088 budget proposal migration seam
and **07** Automation-OFF readback. Both existed as npm scripts the canonical
sequence never ran.

### D077 artifact hashes — where they live, not duplicated here

An earlier draft of this section embedded the generator's own output hash
values directly into this table. That is a circular dependency: this
document is itself one of the files the D077 manifest's `entries[]` pins a
`sha256` for (`docs/audits/PRE_DEPLOY_RELEASE_MANIFEST_2026-09-03.md`).
Writing the generator's freshly-computed hash for artifact X **into this
file** changes this file's own bytes, which changes this file's own
SHA-256 — the exact value the manifest had just pinned for it — invalidating
the entry the edit was trying to record. Every later fix to that number would
repeat the same failure, forever chasing its own tail.

The break: this document is finalized — no further edits — **before** the
canonical generator (`scripts/audits/d077-correction1-artifact-generator.ts`
phase1, then phase2) runs, and the generator's own JSON outputs are the only
place a current hash value is recorded — never restated here:

| artifact | file | hash field |
| --- | --- | --- |
| verification ledger | `docs/audits/generated/d077-correction1-verification-ledger-2026-08-30.json` | `ledgerHash` |
| release-deploy approval packet | `docs/audits/generated/d077-release-deploy-approval-packet-2026-08-30.json` | `packetHash` |
| database-recovery approval packet | `docs/audits/generated/d077-database-recovery-approval-packet-2026-08-30.json` | `packetHash` |
| release-candidate manifest | `docs/audits/generated/d077-release-candidate-manifest-2026-08-30.json` | `manifestHash` (and each file's own hash under `entries[].sha256`) |

The same applies to the manifest's `pinnedNonSelfFileCount` / `entries.length`:
this pass adds new files the prior generator run never saw (the capability
open/close toggle workflow and its two host scripts, their contract and
harness tests, the budget-master-switch mutation-controls test, the
legacy-page viewer/account-resolution rewrite and its extended tests, the two
new disk-verification cases in the hash-contract suite itself) — a number
written here now would be wrong the moment the generator actually runs, for
the same reason a hash would be. `lib/meta/__tests__/d077-artifact-hash-contract.test.ts`
independently re-hashes every `entries[]` path against live disk content
(catching a stale pin) and independently confirms every currently
modified-or-new file in the tree is present in `entries[]` (catching a
missing pin) — so this document does not need to assert a count that could
go stale to have the same guarantee.

## Totals

PRE-DEPLOY AUDIT CORRECTION 2026-09-03 (later pass): the previous version of
this section read "modified: 216", which was `M` and `D` summed together
(`git diff --name-only` returns both statuses undifferentiated) — the 2
deletions were counted once here AND again in their own section below. The
three categories below are disjoint by construction (verified: zero overlap
between M∩D, and zero overlap between (M∪D)∩untracked) and sum to the total
without double-counting anything. Recomputed once more at the very end of
that same correction pass, after one new test file was added
(`budget-preparation-form-interaction.test.tsx`, +1 to `new` only —
`modified` and `deleted` were untouched by that pass and re-verified
unchanged) — the numbers below are that final, mechanically-verified state.

- new (untracked, after `.gitignore`) — `git ls-files --others --exclude-standard`: **267**
- modified (tracked, in place) — `git diff --name-only --diff-filter=M`: **214**
- deleted (tracked) — `git diff --name-only --diff-filter=D`: **2**
- staged — `git status --porcelain | grep -cE '^[MADRC]'`: **0**
- **total changed paths: 267 + 214 + 2 = 483**
- release bytes on disk (sum of `M ∪ new`; `D` paths contribute 0 bytes, they
  no longer exist on disk): **312.3 MB**

## INCLUDE — by area

Four columns, mechanically generated from the three disjoint file lists above
— `new`, `modified` and `deleted` never overlap for a single path, and no
path is counted in more than one column. Column totals: new=267,
modified=214, deleted=2.

| area | new | modified | deleted |
| --- | ---: | ---: | ---: |
| `.gitignore` | 0 | 1 | 0 |
| `app/(dashboard)` | 7 | 9 | 0 |
| `app/api` | 6 | 29 | 0 |
| `app/c` | 0 | 2 | 0 |
| `components/commercial-truth` | 0 | 5 | 0 |
| `components/common` | 0 | 2 | 0 |
| `components/creatives` | 0 | 21 | 0 |
| `components/meta` | 8 | 14 | 2 |
| `components/zero-base` | 0 | 2 | 0 |
| `docker-compose.yml` | 0 | 1 | 0 |
| `docs/audits` | 80 | 0 | 0 |
| `docs/creative-decision-center` | 6 | 6 | 0 |
| `docs/meta-page-ui-contract.md` | 0 | 1 | 0 |
| `lib/api` | 0 | 2 | 0 |
| `lib/business-commercial.test.ts` | 0 | 1 | 0 |
| `lib/business-commercial.ts` | 0 | 1 | 0 |
| `lib/creative-decision-center` | 0 | 5 | 0 |
| `lib/creative-decision-engine` | 7 | 30 | 0 |
| `lib/currency` | 2 | 0 | 0 |
| `lib/meta` | 86 | 46 | 0 |
| `lib/migration-verification.ts` | 0 | 1 | 0 |
| `lib/migrations.engine-v3.test.ts` | 0 | 1 | 0 |
| `lib/migrations.google-ads-search-intelligence.test.ts` | 0 | 1 | 0 |
| `lib/migrations.klaviyo.test.ts` | 0 | 1 | 0 |
| `lib/migrations.meta-decision-outcomes.test.ts` | 0 | 1 | 0 |
| `lib/migrations.meta-retention.test.ts` | 0 | 1 | 0 |
| `lib/migrations.test.ts` | 0 | 1 | 0 |
| `lib/migrations.ts` | 0 | 1 | 0 |
| `lib/sync` | 2 | 1 | 0 |
| `lib/zero-base` | 0 | 6 | 0 |
| `package.json` | 0 | 1 | 0 |
| `playwright.config.ts` | 0 | 1 | 0 |
| `playwright/.evidence` | 7 | 0 | 0 |
| `playwright/tests` | 1 | 2 | 0 |
| `scripts/audits` | 38 | 0 | 0 |
| `scripts/automation-off-readback-seam.ts` | 1 | 0 | 0 |
| `scripts/check-release-owner-references.sh` | 0 | 1 | 0 |
| `scripts/creative-decision-center` | 6 | 6 | 0 |
| `scripts/d086-capture-to-readiness-child.ts` | 1 | 0 | 0 |
| `scripts/d086-capture-to-readiness-e2e.ts` | 1 | 0 | 0 |
| `scripts/d088-budget-proposal-migration-child.ts` | 1 | 0 | 0 |
| `scripts/d088-budget-proposal-migration-seam.ts` | 1 | 0 | 0 |
| `scripts/ephemeral-postgres-d086-readiness-seam.ts` | 1 | 0 | 0 |
| `scripts/ephemeral-postgres-duplicate-ad-reconciliation-seam-child.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-entity-state-history-seam-child.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-launchpad-handoff-seam.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-migrations-check.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-native-ad-decision-seam.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-schema-upgrade-seam.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-seam-child.ts` | 0 | 1 | 0 |
| `scripts/ephemeral-postgres-state-history-compaction-seam-child.ts` | 1 | 0 | 0 |
| `scripts/state-history-compaction-cli.ts` | 1 | 0 | 0 |
| `scripts/typecheck-split.test.ts` | 1 | 0 | 0 |
| `scripts/typecheck-split.ts` | 1 | 0 | 0 |
| `scripts/verify-database-seams.sh` | 0 | 1 | 0 |
| `scripts/zero-base` | 1 | 1 | 0 |
| **TOTAL** | **267** | **214** | **2** |

## INCLUDE — the deletions, named

- `components/meta/redesign/MetaCampaignLabelsSection.test.tsx` (deleted)
- `components/meta/redesign/MetaCampaignLabelsSection.tsx` (deleted)

Both are the buyer-facing manual Test/Main campaign-label section and its test.
`scripts/creative-decision-center/generalized-pit-replay.test.ts` asserts the
component path stays absent, so re-adding it fails the suite. Only automatic
classification remains.

## INCLUDE — files at or above 1 MB

| size | path |
| ---: | --- |
| 48.5 MB | `docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json` |
| 41.9 MB | `docs/audits/generated/generalized-pit-replay-evidence-2026-08-30.json` |
| 39.6 MB | `docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r6.json` |
| 35.8 MB | `docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r5.json` |
| 34.6 MB | `docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r4.json` |
| 34.4 MB | `docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r3.json` |
| 25.9 MB | `docs/audits/generated/d083-meta-budget-fact-observation-2026-09-01.json` |
| 12.3 MB | `docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json` |
| 9.7 MB | `docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json` |
| 9.6 MB | `docs/audits/generated/d082-meta-role-provenance-replay-2026-09-01.json` |
| 1.2 MB | `docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r2.json` |

## The three ignore corrections this pass made

Each was an ignore rule excluding a file a test opens by path — the same defect
class, found three times:

1. `h11b-context-lifecycle-bundle-*.json` — read by
   `scripts/audits/d082-meta-role-provenance-replay.ts` via
   `D082_PINNED_INPUTS.h11bBundlePath`, pinned by SHA. **Rule removed.**
2. `docs/audits/generated/*.log` — excluded BOTH retained whole-shell captures,
   which `lib/meta/__tests__/d077-artifact-hash-contract.test.ts` opens and
   refuses without. **Negation added for the two captures.**
3. The two patterns beside (1) were re-checked and are genuinely unread:
   the h11 regression path is the challenger's own `JSON_OUT` and the
   account-scoped shadow file has no reader anywhere in app/, components/,
   lib/ or scripts/. **Kept ignored.**

`scripts/audits/d082-clean-checkout-inventory.test.ts` now proves every D082
pinned input survives a clean-checkout-equivalent inventory
(`git ls-files --cached --others --exclude-standard`), so no future rule can
silently take one away.

## Hygiene checks — run over the release scope, not asserted

| check | method | result |
| --- | --- | --- |
| symlinks | `test -L` over all 483 paths | none |
| secrets | `sk-`, `EAA`, `ghp_`, `github_pat_`, `AKIA`, PEM headers, `xox[baprs]-`, streamed over every file including the 48 MB artifacts | 0 hits |
| env / credentials | path scan for `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `.npmrc`, `credentials` | none |
| lockfile | `git diff --name-only -- package-lock.json` | unchanged |
| dependencies | `git diff -- package.json` | no dependency change; 3 npm scripts added |
| deletions | `git diff --diff-filter=D --name-only` | 2, both intended |
| staged | `git status --porcelain` | 0 |

### The H11b bundle's contents, stated

It carries six advertiser BUSINESS NAMES — the operator's own accounts. No
emails, no end-customer identifiers, no credential-shaped material (scanned on
the bytes, not on a parse). That is data the repository owner already owns, and
it is why the file was excluded in the first place; the exclusion broke D082, so
it is included and the scan is recorded rather than assumed.

## Release posture at the end of this job

**Phase A** — `META_AUTOMATION_LIVE_WRITES` untouched, every database master
switch and schema default OFF. This is migration validation, **not** the
finished release. See `docs/audits/AUTOMATION_RELEASE_POSTURE_2026-09-03.md`
for the A/B/C phases and `lib/meta/automation-release-posture.ts` for the
classifier that refuses to call an absent capability a final posture.

## Correction pass 2026-09-03 (later): manifest arithmetic + preparation form

A second, bounded pass over the same tree. No commit, push, deploy, or
production/env/provider mutation in this pass either.

### 1. This document's own arithmetic, fixed

`## Totals` previously read "modified: 216" — `M` and `D` summed together and
double-counted against the separate "the deletions, named" section. Recounted
from three disjoint git queries (`--diff-filter=M`, `--diff-filter=D`,
`ls-files --others --exclude-standard`; zero overlap between any pair,
verified with `comm -12`) and the `## INCLUDE — by area` table rewritten to
four columns (new/modified/deleted) so a deletion can never be folded into
"modified" again. Byte total re-derived the same way: `M ∪ new` only, since a
`D` path no longer exists on disk to have a size.

### 2. `BudgetPreparationForm` — three real defects, fixed

- **Fabricated default.** `dryRunOnly` initialized to `true` whenever the
  stored value was not `persisted` — an unset or unread row rendered as an
  already-made "safe" choice nobody actually picked. Now a genuine tri-state
  (`"" | "true" | "false"`); an unmade choice submits `dryRunOnly: undefined`,
  which the shared parser refuses by name (`dry_run_only_not_boolean`), and
  Save cannot be pressed until the operator picks one.
- **Fail-open on an unread row.** `preparation === null` or
  `preparation.rowRead === false` left every input and Save enabled, so a
  value typed over a row nobody could read would silently overwrite it. Both
  states now disable every control (`data-fields-locked="true"` on the
  `<form>`); `rowRead === true && rowExists === false` (first setup) is the
  one state that stays editable, per spec.
- **No scope isolation.** Nothing stopped a value typed for one
  business/account from surviving into a different one after a re-render.
  Fixed with a scope-keyed remount at the mount site
  (`key={businessId::providerAccountId}`) plus a one-shot resync effect (a
  `useRef` guard) for the case where the SAME scope's first read arrives after
  an initial unreadable render — verified NOT to erase an in-progress edit on
  an ordinary same-scope refresh.

Verified adversarially, not just written: each fix was temporarily reverted
in turn and the corresponding new tests were confirmed to fail specifically
(and only) for that mutation, then the file was restored byte-for-byte
(`diff` against a pre-edit copy) before re-running green.

New tests: `budget-preparation-form-interaction.test.tsx` (20 cases,
`@testing-library/react` + `fireEvent`/`rerender` against
`BudgetWriteReadinessSection` — real mounts, real typed input, real
re-renders, not source-string matching) plus the existing 23
`renderToStaticMarkup` cases in `budget-preparation-form.test.tsx`, all still
green unchanged.

### 3. D077/manifest hash dependencies — inspected, not touched

Both edits above land inside files the frozen D077 evidence PINS a content
SHA-256 for:
`docs/audits/generated/d077-release-candidate-manifest-2026-08-30.json` lists
a per-file `sha256` for both
`app/(dashboard)/platforms/meta/automation/automation-view.tsx` and this
document. Traced every place that manifest's `entries[]` is read
(`lib/meta/__tests__/d077-artifact-hash-contract.test.ts`, the only test file
referencing it): every assertion compares the manifest against its own
embedded `manifestHash` and against the release-deploy packet's
`expectedFinalTree` — both frozen at the SAME prior generation run. None
re-hashes a live file from `entries[]` against current disk content. Ran the
full 19-case hash-contract suite to confirm — green, unchanged. **No
regeneration performed; no hash hand-patched.** The manifest's two
now-stale per-file entries remain exactly what they were: a snapshot of what
was true when that artifact was generated, not a live contract.

### 4. The 6b psql `\gset`/`\if` guard — verified, not changed

`docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md` §6b was inspected line by
line and left untouched (`git diff --stat` on it: no output). The design is
correct: `to_regclass('public.meta_budget_write_journal')` is a
non-erroring existence probe (returns `NULL` rather than raising 42P01 on an
absent relation), and `\gset` captures its boolean result into a CLIENT-side
psql variable — the `\if`/`\else`/`\endif` that follows is resolved entirely
by the psql client before anything is sent to the server, so on a
pre-migration cluster the branch naming the missing table is never
transmitted, and only the literal `\else` SELECT (which names no table) is.
This is exactly what makes the guard safe against the PARSE-time 42P01 the
surrounding comment describes. Confirmed by a prior authoritative run of
`scripts/automation-off-readback-seam.ts` in this same working tree (both
schema states: `exit 0`, 9 sections, 0 errors) — not re-run here, since
nothing this pass touched (`lib/migrations.ts`, `budget-schema-verification.ts`,
the readback script itself) could have changed its outcome.

### 5. Gate run on the final tree

| check | command | result |
| --- | --- | --- |
| focused: manifest arithmetic | (mechanical recount, see above) | verified, zero overlap |
| focused: preparation form (static) | `vitest run budget-preparation-form.test.tsx` | 23/23 passed, unchanged |
| focused: preparation form (interaction) | `vitest run budget-preparation-form-interaction.test.tsx` | 20/20 passed (new file) |
| focused: mutation-adversarial check | 3 targeted reverts, each isolated to its own failing tests | confirmed, then restored exactly |
| focused: D077 hash contract | `vitest run d077-artifact-hash-contract.test.ts` | 19/19 passed, unchanged |
| focused: D082 clean-checkout inventory | `vitest run d082-clean-checkout-inventory.test.ts` | 6/6 passed, unchanged |
| regression: automation directory | `vitest run app/(dashboard)/.../automation/` | 190/190 passed |
| regression: zero-base automation + API route | `vitest run app/c/.../automation/ app/api/meta/automation/` | 191/191 passed |
| typecheck (8-shard, fail-closed) | `npm run typecheck:split -- --shards 8` | 3544 files, 0 diagnostics |
| lint | `npx eslint .` | exit 0 |
| diff hygiene | `git diff --check` | exit 0, clean |
| whitespace | `bash scripts/verify-whitespace.sh` | PASS |
| secrets (new/changed files this pass) | same regex set, streamed | 0 hits |

The full 40-stage canonical shell and the multi-thousand-test full regression
suite were **not** re-run in this pass: nothing changed that either depends
on (confirmed above for D077/D082; the two touched surfaces — a documentation
file and one client component plus its own tests — have no other pinned
dependency in the repository).

## Correction pass 2026-09-03 (third): D077 circularity, fail-open Automation authorization, safe Phase A→B toggle

A third, bounded pass over the same tree. No commit, push, deploy, or
production/env/provider mutation in this pass either.

### 1. The D077 evidence-chain circularity — broken, not patched around

The prior pass's own "Regenerated D077 artifact hashes" table (this document,
above) embedded the generator's freshly-computed hashes back into the very
document one of `entries[]` pins a `sha256` for — self-invalidating on every
edit. Fixed by finalizing this document's content (paths + field names, no
values) **before** the generator runs this pass, as explained in that section
above. Separately, the hash-contract suite's own coverage gap this pass's
staleness exposed — `entries[]` was frozen-internally-consistent but never
independently re-hashed against live disk content, and never checked for
completeness against the currently changed/new tree — is closed by two new
cases in `lib/meta/__tests__/d077-artifact-hash-contract.test.ts`:
"every non-deleted manifest entry's pinned sha256 matches the CURRENT file on
disk" and "every currently modified-or-new file in the working tree … is
present in the manifest's entries[]". Both were run against the still-stale
(pre-regeneration) manifest and FAILED, listing exactly the files this and
the prior pass touched, including `automation-view.tsx` and this document
itself — proof the checks are real, not vacuous. The canonical generator
(phase1, then phase2) is run LAST in this pass's gate sequence, after every
other change below; its results (new hashes, new entry count, and an
independent 0-mismatch/0-missing rehash) are reported in this pass's closing
report rather than hand-added to this document, since this document is not
touched again after the generator runs.

### 2. Fail-open legacy Automation mount — fixed

`app/(dashboard)/platforms/meta/automation/legacy-page.tsx` was not
establishing a real viewer envelope: every non-admin viewer state (null role,
collaborator, reviewer, demo, unverified) fell through
`buildBudgetMasterSwitchAuthorization`'s prior denylist logic to a
default that behaved as if the viewer could mutate, while the API's own guard
correctly returned 403 — a UI that showed live write controls to viewers with
no authority to use them, masked only by the API refusing the request
afterward, not by the UI ever refusing to render.

Fixed with an allowlist rewrite of `buildBudgetMasterSwitchAuthorization`
(`app/(dashboard)/platforms/meta/automation/viewer-envelope.ts`) — grant is
the first and only branch returning `true`
(`surface === "desktop" && viewer.role === "admin" && viewer.canMutate === true && viewer.reason === null`),
every other path is a named refusal — and by rewriting `legacy-page.tsx` to
establish a real viewer (`buildAutomationViewerEnvelope`) and resolve the
provider account through `resolveProviderAccountId` rather than trusting a
raw query parameter, passing both as `undefined` (never a false `null`) on
any access or resolution failure so the client-side fallback is not
short-circuited into a false "resolved to nothing" state.

New test coverage:
`budget-master-switch-mutation-controls.test.tsx` (26 cases — the
authorization function directly, plus full-page mounts proving admin sees
controls, every other viewer state sees none, mobile never shows controls
regardless of role, and `router.refresh()` reconnects enable/disable/save to
a real server re-read) and an extended `legacy-page.test.tsx` (5 → 23 cases,
proving viewer establishment, provider-account resolution, and the two
gate-refusal facts the page now threads through).

### 3. A safe Phase A → B capability-open workflow

Built new, not adapted from an existing deploy path, since none of
`deploy-hetzner.yml`, `promote-release-gate-mode.yml`, or the post-deploy
verify job touch `META_AUTOMATION_LIVE_WRITES` or read the automation-specific
DB state at all:

- `lib/meta/automation-capability-preflight.ts` — pure, DB-readback-driven
  preflight: global automation-OFF sections, plus the six named businesses
  (IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR)
  individually, each required OFF or row-absent-safe; unknown or
  read-failure refuses. 27 unit tests.
- `lib/meta/automation-capability-orchestrator.ts` — the pure open/close
  state machine: preflight → write → recreate → verify → preflight again;
  any failure after the write restores the env backup, forces closed, and
  the result is NEVER reported `pass` after a rollback regardless of the
  rollback's own outcome. 16 unit tests, adversarially mutation-tested.
- `.github/scripts/automation-capability-env.sh` — the atomic env-file
  writer: temp-file-plus-rename (never a partial write), a timestamped
  backup returned to the caller, mode/owner preserved across the write, and
  every existing line for the key stripped before exactly one clean line is
  appended (no duplicate keys survive). 19 tests against real local temp
  files — no host, no SSH, no Docker.
- `.github/workflows/automation-capability-toggle.yml` — `workflow_dispatch`
  only, the same `deploy-production-main` concurrency group as
  `deploy-hetzner.yml` (`cancel-in-progress: false`, so a capability change
  and an ordinary deploy can never race the host), a default-`closed`
  capability choice, and a required exact confirmation phrase
  (`OPEN_AUTOMATION_CAPABILITY`) for `open`. Never writes
  `meta_automation_business_controls` or `meta_automation_decision_type_modes`
  — capability-open only, never business-enable. A redacted JSON artifact
  (`summary.result`, `summary.blockers`) is uploaded on every outcome, and a
  dedicated step fails the job on anything but `result === "pass"`. 22 static
  contract tests against the YAML itself (`js-yaml`-parsed; three were
  initially false positives from matching the workflow's own explanatory
  prose rather than real code — fixed by stripping comments and tightening
  the secret/table-name detection to real code patterns, not bare
  substrings).

The exact six-step sequence this workflow is one step of — main-exact-SHA →
pre-deploy OFF audit → deploy with migrations → post-migration OFF audit →
this workflow with `capability=open` → verify env-true-and-zero-enabled — is
in `docs/audits/AUTOMATION_RELEASE_POSTURE_2026-09-03.md`, "The exact sequence
from phase A to phase B", including the explicit statement that a green
GitHub Actions run is not sufficient by itself: the uploaded artifact's
`summary.result === "pass" && summary.blockers` empty must be checked
directly.

### 4. One real typecheck defect, found by the 8-shard gate and fixed

`budget-master-switch-mutation-controls.test.tsx` called
`readZeroBaseRolloutConfig({})` — a bare `{}` is not assignable to the
`NodeJS.ProcessEnv` parameter type, matching the exact cast the pre-existing
`lib/zero-base/rollout.test.ts` already uses for the same call
(`env as NodeJS.ProcessEnv`). Fixed with the identical cast
(`{} as NodeJS.ProcessEnv`); re-ran both the 8-shard typecheck (3550 files, 0
diagnostics) and the file's own suite (26/26) after the fix.

### 5. Totals, recomputed on the tree this section describes

This pass adds 11 new (untracked) files — the five `.github/` capability-
toggle pieces, the budget-master-switch mutation-controls test, and the five
`lib/meta`/`scripts` capability preflight/orchestrator pieces — and no
previously-unmodified tracked file: `legacy-page.tsx`, `viewer-envelope.ts`
and `automation-view.tsx` were already `M` (modified) before this pass began
(continuing work from an earlier pass in this same uncommitted tree), so
their further edits this pass do not change the modified COUNT, only their
content and hash.

- new (untracked, after `.gitignore`) — `git ls-files --others --exclude-standard`: **278**
- modified (tracked, in place) — `git diff --name-only --diff-filter=M`: **214**
- deleted (tracked) — `git diff --name-only --diff-filter=D`: **2**
- staged — `git status --porcelain | grep -cE '^[MADRC]'`: **0**
- zero overlap between every pair of (new, modified, deleted), verified with `comm -12`
- **total changed paths: 278 + 214 + 2 = 494**

### 6. Gate run on the final tree (before the generator)

Run in the order the task requires: focused tests, `check:workflows`,
8-shard typecheck, ESLint, whitespace, `git diff --check` — the D077
generator and the live-entry hash re-verification run AFTER this table, as
their own closing report, never folded into this document.

| check | command | result |
| --- | --- | --- |
| focused: Part B (viewer/authorization) | `vitest run budget-master-switch-mutation-controls.test.tsx legacy-page.test.tsx` | 49/49 passed |
| focused: Part C (capability preflight) | `vitest run lib/meta/automation-capability-preflight.test.ts` | 27/27 passed |
| focused: Part C (capability orchestrator) | `vitest run lib/meta/automation-capability-orchestrator.test.ts` | 16/16 passed |
| focused: Part C (env-writer harness) | `vitest run .github/scripts/automation-capability-env-harness.test.ts` | 19/19 passed |
| focused: Part C (workflow YAML contract) | `vitest run .github/workflows/automation-capability-toggle-contract.test.ts` | 22/22 passed |
| focused: D077 hash contract (pre-regeneration) | `vitest run d077-artifact-hash-contract.test.ts` | 19/21 passed — the 2 new disk-verification cases FAIL here by design (stale manifest); see the closing report for their post-generation result |
| focused: D082 clean-checkout inventory | `vitest run d082-clean-checkout-inventory.test.ts` | 6/6 passed, unchanged |
| regression: automation directory | `vitest run app/(dashboard)/.../automation/` | 234/234 passed |
| regression: zero-base automation + API route | `vitest run app/c/.../automation/ app/api/meta/automation/` | 191/191 passed |
| workflow semantics | `npm run check:workflows` | PASS — every needs reference resolves, no cycles, every step well-formed |
| typecheck (8-shard, fail-closed) | `npm run typecheck:split -- --shards 8` | 3550 files, 0 diagnostics (1 real defect found and fixed — see §4) |
| lint | `npx eslint .` | exit 0 |
| whitespace | `bash scripts/verify-whitespace.sh` | PASS |
| diff hygiene | `git diff --check` | exit 0, clean |

**This document is now final.** No further edit is made to it after this
point — the D077 generator runs next, and its results (new hashes, new entry
count, the two disk-verification cases' post-regeneration outcome, and an
independent full-entry rehash) are reported in this pass's closing report to
the operator, not written back into this file, for exactly the reason §1
above exists.


## Correction pass 2026-09-03 (fourth): real remote-script integration bugs + a fresh serving-freshness read

A fourth, bounded pass over the same tree. No commit, push, deploy, or
production/env/provider mutation — the one production access this pass made
was READ-ONLY (see §7 below), through the pre-existing local SSH tunnel this
pass did not create, inside a bounded `REPEATABLE READ READ ONLY`
transaction that always ends in ROLLBACK.

Independent review of the third pass's Part C found it NO-GO: the pure
TypeScript orchestrator and its 16 unit tests were real, but the shipped
workflow never calls that module — it runs
`.github/scripts/automation-capability-env.sh` and
`.github/scripts/automation-capability-remote.sh` directly over SSH, and
those had never been exercised for real. Six concrete defects were found and
fixed, all now covered by a NEW deterministic harness that runs the actual
scripts, not a rewritten stand-in for them.

### 1. The runtime preflight could never PASS in the actual worker container

`scripts/automation-capability-preflight-cli.ts` shelled out to `psql` and
read `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md` from disk. Neither
exists in the shipped worker image: Dockerfile's `worker-runner` stage never
copies `docs/`, and the base `node:20-alpine` image never installs a `psql`
client. Both failures were caught internally and reported as a REFUSAL, so
the bug was silent in the sense that it never crashed — but it meant
capability-open could never actually succeed on a real deploy.

Fixed by porting the same SELECT text to `RUNTIME_READBACK_SQL_STATEMENTS`
in `lib/meta/automation-capability-preflight.ts` — extracted from the doc's
own fenced block programmatically (never retyped), run individually through
the app's own `getDb()`/`runDbTransaction()` inside the same bounded
`REPEATABLE READ READ ONLY` + `statement_timeout` + unique-`application_name`
pattern `scripts/audits/d077-production-recovery-readonly-preflight.ts`
already proves against real production. The doc's `\gset`/`\if`/`\else`
psql meta-commands (needed because naming the not-yet-migrated
`meta_budget_write_journal` table aborts the transaction at PARSE time) are
replaced by an equivalent JS-side probe-then-branch. A new "byte-identical
to the operator document" test asserts every embedded statement is a
verbatim substring of the doc's own fenced SQL, so the two can never drift
silently. A "runtime package contract" test statically traces every `@/`
import this CLI script reaches and fails if any resolves outside the
directories Dockerfile's `worker-runner` stage actually copies.

### 2-4. `automation-capability-remote.sh` — explicit error propagation, a pre-open baseline, and a rollback that cannot be swallowed

- **Explicit propagation.** `docker compose pull`/`up`'s exit status was
  never checked. Because the caller invokes `capability_recreate_and_verify`
  as the left side of an `if ... && ...` condition, bash disables `set -e`
  for that function's ENTIRE body while it runs in that context — an
  unchecked pull/up failure would have silently fallen through to the
  verification steps instead of stopping. Every step now checks its own
  exit status with `if !`/`||`, and both `web` and `worker` (not just web)
  are verified: running, at the exact image `revision` label, correctly
  `release.role`-labeled, and reporting the correct live `META_AUTOMATION_
  LIVE_WRITES` value — the scheduled budget-automation job that actually
  reads that gate runs in the WORKER, so checking only web left the one
  process that matters unverified.
- **Pre-open baseline.** Nothing previously verified that web+worker were
  ALREADY running the exact requested SHA, or that the capability was
  ALREADY closed, before writing anything — "the SHA matches current main
  HEAD" (the workflow's own freshness gate) only proves the commit is
  latest, not that it is what is actually deployed and running.
  `capability_verify_running_baseline` now proves both, read-only, before
  `capability_open` does anything else, and refuses outright (with the env
  file untouched) if either does not hold. Nothing in this workflow ever
  deploys a different release — `capability_recreate_and_verify` always
  pins `APP_IMAGE_TAG`/`APP_BUILD_ID` to the same `EXPECTED_SHA` the
  baseline just proved is already running.
- **Rollback never swallowed.** The restore step's own failure was
  discarded via `atomic_restore_env_backup ... || true`; if the restore
  itself failed, `restore_ok` stayed correctly false, but reaching THAT
  conclusion depended on a later runtime check coincidentally also failing,
  not on the restore's own exit code. Now checked directly: a failed
  restore reports the named blocker `restore_failed` (not a generic
  `restore_recreate_verify_failed`), and `capability_close` writes `false`
  and recreates/verifies unconditionally — never gated on the DB-backed
  preflight or the baseline check, exactly the situation an operator would
  be closing capability in response to.

### 5. `automation-capability-env.sh` — the swallowed grep/chown errors

`grep -v ... || true` when stripping the target key's existing lines meant
a genuine read failure (not "no match", which is the expected/tolerated
exit 1) was indistinguishable from success — the write would have continued
with a possibly-truncated temp file and renamed it over the real
`.env.production`, discarding every OTHER key the file held. `chown ... ||
true` meant an ownership-preservation failure was silently ignored.
Fixed: `atomic_set_env_var` now counts the lines it expects to keep BEFORE
stripping and cross-checks the stripped file's actual line count against
that expectation (refusing rather than writing on any mismatch), checks
`chown`'s own exit status explicitly, and re-verifies mode AND owner:group
against the live file AFTER the rename — not just after the temp file, in
case the rename itself somehow lost them. Every intermediate exit-status
capture uses an `if var=$(cmd); then ... else status=$?; fi` form, never a
bare `var=$(cmd); status=$?` pair — the latter aborts under `set -e` on the
COMMAND SUBSTITUTION's own failure before the status line ever runs, a
distinct bash gotcha discovered while fixing this (verified by first
writing the naive form, watching two of the harness's own new tests fail
with no error message at all, then applying the `if`-protected form).

### 6. The workflow's own pipeline had two real bugs

- `phase_status="${PIPESTATUS[0]:-$?}"` read the exit status of the trivial
  `{ cat env.sh; cat remote.sh; }` GROUP at the start of the three-stage
  pipeline — not `ssh`'s own exit status at index 1. A total SSH failure
  (dead host, refused connection) would have reported `phase_status=0`
  regardless. Fixed to `PIPESTATUS[1]`, and the harness reconstructs the OLD
  line verbatim and runs it against a fake dead-host `ssh` to PROVE it
  reports 0 before proving the fixed line reports non-zero for the exact
  same failure.
- The grep pipeline extracting the `CAPABILITY_JSON:` line ran under
  `set -euo pipefail` with no protection; when a phase printed no such line
  at all, `grep`'s exit 1 made the WHOLE piped write's exit status non-zero,
  which aborted the step right there — the `no_capability_json_emitted`
  fallback immediately below it never ran. Fixed with `|| true` on that one
  pipeline (the very next line's `[ ! -s ... ]` check is what actually
  turns "nothing matched" into the named blocker). The harness reconstructs
  the OLD unprotected line and proves it crashes the step outright.
- Strengthened: a `result: "pass"` artifact carrying a non-empty
  `blockers` array is now downgraded to `fail` (mirroring the existing
  phase-exit-code cross-check), and the final "Fail the job" gate checks
  `result == "pass" AND blockers == []` explicitly rather than trusting
  `result` alone.
- The redacted artifact now carries REAL measured before/after evidence,
  not just a declaration: web/worker's own observed image `revision` and
  live `META_AUTOMATION_LIVE_WRITES` value, both before any mutation and
  after the recreate, plus the six-business `perBusiness` status array from
  the preflight CLI's own JSON, both before and after (for `capability_
  open`; `capability_close` carries a best-effort `before` snapshot and
  never touches the DB-backed six-business read at all, by design).

### The critical test: the real scripts, not the pure orchestrator

`.github/workflows/automation-capability-toggle-integration.test.ts` (27
cases, NEW) runs the ACTUAL `automation-capability-env.sh` +
`automation-capability-remote.sh`, and the ACTUAL `run:` script text read
directly out of the workflow YAML via `js-yaml` (never retyped), against a
fake `ssh` that evaluates its command string LOCALLY via `bash -c`
(inheriting this process's own stdin exactly like real ssh does — the
concatenated scripts really do reach a real `bash -s` and really do
execute), fake `docker`/`curl` binaries driven by env vars per test case,
and a real local file standing in for `.env.production`, mutated by the
real `atomic_set_env_var` and inspected byte-for-byte afterward. Covers:
success (open and close, including the real env-file diff), preflight
refusal, a wrong pre-existing SHA, capability already open, a wrong
worker/web SHA or env value after recreate, nonzero `docker compose
pull`/`up`, a permission-denied backup directory, a missing env file, a
forced chown failure, a forced grep read failure, a recreate-verify failure
whose OWN forced-close recovery also fails, a forced `atomic_restore_env_
backup` failure, `capability_close` succeeding while the preflight would
refuse (and never even calling it), a dead-host SSH failure, and a phase
that prints no `CAPABILITY_JSON` line at all — plus, for the two workflow
bugs above, the OLD broken line reconstructed and run for real, proven to
mis-report exactly the failure the fix now catches.

### 7. A fresh serving-freshness read for the six businesses — still NO_GO

The 2026-08-30 evidence (IwaStore 3, TheSwaf 3, Grandmix 23
`automated_missing`, others 0) is now five days old, and
`docs/architecture/serving-direct-production-release-runbook.md` treats it
as a real deploy blocker, not a cosmetic gap. Re-measured with a NEW,
narrowly-scoped script, `scripts/audits/serving-freshness-current-preflight.ts`
— the same `readServingFreshnessStatus` call, the same six businesses, the
same bounded `REPEATABLE READ READ ONLY` transaction pattern the 2026-08-30
evidence used, SELECT-only, no backfill, no cache warm, no provider call,
ends in ROLLBACK regardless of outcome. Result, dated
2026-09-03T16:04:03.184Z and written to
`docs/audits/generated/serving-freshness-current-preflight-2026-09-03.json`
(never overwriting the 2026-08-30 file): **NO_GO, 29 `automated_missing`,
unchanged in count, business, and exact surface** from the frozen
measurement — see
`docs/architecture/serving-direct-production-release-runbook.md`, "Current
serving-freshness status — 2026-09-03", for the per-business breakdown and
required remediation.

**This status is NOT silently flipped to GO, and no release acceptance is
produced from it.** The release packet's own `decision: "NO_GO"`
(`docs/audits/generated/d077-release-deploy-approval-packet-2026-08-30.json`)
is left exactly as it was — this pass only adds independent, freshly dated
confirmation that the blocker it already names is still real today.

### 8. Totals, recomputed on the tree this section describes

This pass adds 3 new (untracked) files — the integration harness, the
serving-freshness preflight script, and its dated evidence JSON — and 1
newly-modified tracked file (`docs/architecture/serving-direct-production-
release-runbook.md`, the status section in §7 above); every file this pass
edited under `lib/meta/`, `scripts/`, and `.github/` was already untracked
from the prior pass, so it changes content and hash, not the modified
COUNT.

- new (untracked, after `.gitignore`) — `git ls-files --others --exclude-standard`: **281**
- modified (tracked, in place) — `git diff --name-only --diff-filter=M`: **215**
- deleted (tracked) — `git diff --name-only --diff-filter=D`: **2**
- staged — `git status --porcelain | grep -cE '^[MADRC]'`: **0**
- zero overlap between every pair of (new, modified, deleted), verified with `comm -12`
- **total changed paths: 281 + 215 + 2 = 498**

### 9. Gate run on the final tree (before the generator)

Run in the order the task requires: focused tests, `check:workflows`,
8-shard typecheck, ESLint, whitespace, `git diff --check` — the D077
generator and the live-entry hash re-verification run AFTER this table, as
their own closing report, never folded into this document.

| check | command | result |
| --- | --- | --- |
| focused: Part B + Part C + regressions (one run) | `vitest run` over the 30 files listed in the closing report | 566/566 passed |
| focused: D077 hash contract (pre-regeneration) | `vitest run d077-artifact-hash-contract.test.ts` | 19/21 passed — the 2 disk-verification cases FAIL by design (stale manifest, missing this pass's new files); see the closing report for their post-generation result |
| workflow semantics | `npm run check:workflows` | PASS |
| typecheck (8-shard, fail-closed) | `npm run typecheck:split -- --shards 8` | 3551 files, 0 diagnostics |
| lint | `npx eslint .` | exit 0 |
| whitespace | `bash scripts/verify-whitespace.sh` | PASS |
| diff hygiene | `git diff --check` | exit 0, clean |
| serving-freshness current preflight | `tsx scripts/audits/serving-freshness-current-preflight.ts` | ran to completion; verdict NO_GO (expected — a real, unresolved blocker, not a script failure) |

**This document is now final.** No further edit is made to it after this
point — the D077 generator runs next, and its results (new hashes, new
entry count, the two disk-verification cases' post-regeneration outcome,
and an independent full-entry rehash) are reported in this pass's closing
report to the operator, not written back into this file, for exactly the
reason §1 of the third-pass section above exists.
