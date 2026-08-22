# WP0 — Baseline, dirty-tree and authority reconciliation

Work package: WP0 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Date: 2026-08-22
Repository: `/Users/harmelek/Adsecute`

## 1. Exact repository baseline

| Fact | Value | Evidence class |
|---|---|---|
| Branch at start | `main` | VERIFIED-STATIC |
| HEAD at start | `843b6e9c836ee0ad8187954e4dff72d86b2914a7` | VERIFIED-STATIC |
| Plan's declared HEAD (§ header) | `843b6e9c836ee0ad8187954e4dff72d86b2914a7` | VERIFIED-STATIC |
| `git status --porcelain` at start | *empty* — clean worktree | VERIFIED-STATIC |
| Implementation branch | `meta-market-ready`, branched from `843b6e9c8` | VERIFIED-STATIC |

The plan's declared HEAD and the actual HEAD agree. No rebase, reset or
force-update was performed to reach this state.

## 2. Master plan vendored into the repository

The binding plan now lives in the repository at the path the plan's own §20
start-instruction names, so implementation no longer depends on a file in
`Downloads/`:

| Fact | Value |
|---|---|
| Repository path | `docs/meta-market-ready-master-plan-2026-08-22.md` |
| Source path | `/Users/harmelek/Downloads/meta-market-ready-master-plan-2026-08-22.md` |
| SHA-256 | `eacd8b1d229ce34a3c93b27bb22efd8d666c9e239bdcd46faf9e749458f7d275` |
| Lines | 1620 |

The copy is byte-identical to the source. Any later change to the plan must be
re-vendored and this hash updated in the same commit.

## 3. Visual source authority

| Fact | Value | Evidence class |
|---|---|---|
| Current authority file | `/Users/harmelek/Downloads/Dashboard tasarımı yenileme/Adsecute Dashboard v2.dc.html` | VERIFIED-STATIC |
| Current authority SHA-256 | `2af6cbaf5f366a7dee8fc0ae96fdf713eff777c62f16e2d57638368d1678637a` | VERIFIED-STATIC |
| File size | 641 210 bytes | VERIFIED-STATIC |
| Superseded authority SHA-256 | `d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193` | VERIFIED-STATIC |

`shasum -a 256` over the file at that path returns the plan's stated
`2af6cbaf…` value, so the plan's §3 hash and the file on disk agree.

### 3.1 What changed in the reference set

Every other pinned reference byte is unchanged. Re-hashing the whole pinned
set in `scripts/dashboard-v2/reference-contract.ts` shows `support.js`, the
Adsecute mark and all nine platform logos still match their recorded digests
exactly. **Only the main HTML digest moved.** The single-line hash update in
`reference-contract.ts` is therefore the complete and minimal correction; no
asset re-pinning is warranted and none was performed.

### 3.2 Current-authority vs historical records

`scripts/dashboard-v2/reference-contract.ts` is a **current-authority**
artifact: it is executed by `scripts/dashboard-v2-shell-acceptance.ts`, and a
stale digest there makes the acceptance runner refuse the very file the plan
names as authority. It is updated to `2af6cbaf…` in this work package.

`docs/dashboard-v2-parity-defects.md` and
`docs/dashboard-v2-batch-01-shell-inventory.md` are **historical records** —
dated findings measured against the bytes that existed when they were written.
Their `d65c0117…` references are correct *as history* and are not rewritten.
Each now carries a superseded-authority banner naming the current hash, so a
reader cannot mistake the older digest for present authority.

## 4. Preservation of the Creative Share / Public Share work

The plan's §21 warned that thirteen paths carried uncommitted user work and
must not be reset, checked out or overwritten. State at HEAD `843b6e9c8`:

| §21 path | State | Note |
|---|---|---|
| `.gitignore` | present, committed | |
| `app/(dashboard)/platforms/meta/creatives/legacy-page.tsx` | present, committed | |
| `components/creatives/share/ShareSnapshotModal.module.css` | present, committed | |
| `components/creatives/share/ShareSnapshotModal.tsx` | present, committed | |
| `components/zero-base/creative/PublicSharePage.module.css` | present, committed | |
| `components/zero-base/creative/public-share-page.test.tsx` | present, committed | |
| `components/zero-base/creative/public-share-page.tsx` | present, committed | |
| `lib/creative-share-store.test.ts` | present, committed | |
| `lib/creative-share-store.ts` | present, committed | |
| `lib/typography-floor.test.ts` | present, committed | |
| `lib/zero-base/creative/public-share.ts` | present, committed | |
| `docs/meta-design-backend-audit-2026-08-22.md` | **absent** | see §4.1 |
| `docs/public-share-design-review-codex.md` | **absent** | see §4.1 |

Eleven of the thirteen paths are present in the tree and committed. The Share
work the plan wanted protected was landed between the plan's snapshot and this
baseline, in commits `c2863aeea` ("Rebuild the Creative Studio share flow end to
end"), `854bbaaca` ("Revert SharesView to its last known-good state"),
`57604ae06` and `843b6e9c8`. Nothing in this work package resets, checks out or
overwrites any of them.

### 4.1 The two absent documents — stated honestly, not reconstructed

`docs/meta-design-backend-audit-2026-08-22.md` and
`docs/public-share-design-review-codex.md` are absent from the worktree **and
from every git ref**:

```
git log --all --oneline -- docs/meta-design-backend-audit-2026-08-22.md \
                           docs/public-share-design-review-codex.md
```

returns no commits, and neither filename exists anywhere on disk under the
repository. They were untracked files in the plan author's worktree that were
never committed and are no longer present. They were already gone at HEAD
`843b6e9c8`, i.e. **before** this work package began.

This is recorded as **UNKNOWN**, not repaired: their content is not
recoverable from the repository, and writing a replacement would be inventing
authority the plan forbids. If the author still holds copies, restoring them is
a doc-only commit that changes no behaviour.

## 5. Authority ratification

| Decision | Vehicle | Status after WP0 |
|---|---|---|
| Decision as-of scope by creative account keys | `DECISION_LOG.md` **D070** + `ADR-D070-DECISION-AS-OF-SCOPE.md` | Accepted |
| Launchpad execution posture (LAUNCH-06/07) | `docs/adr-003-launchpad-execution-posture.md` | Accepted |
| `/platforms/meta/audiences` destination | `docs/adr-004-meta-audiences-destination.md` | Accepted |
| Visual vs vendored behavioural precedence | `docs/adr-005-visual-vs-vendored-authority.md` | Accepted |

D070's *code* was already implemented at baseline — `resolveWorkspaceEndDate`
in `app/api/meta/decisions-workspace/route.ts` already joins
`creative_account_scope` and carries the `HAVING COUNT(DISTINCT
provider_account_id) = 1` guard the ADR specifies, with the ADR cited in the
query comment. What was missing was the ratification the ADR's own §"Required
evidence" item 5 demands: a `DECISION_LOG.md` entry under the next free number.
The log ended at **D069**, so **D070** is the next free number, exactly as the
ADR draft predicted. Ratifying it closes the plan's §5.1 finding 8 — a Proposed
ADR being used by the UX remediation ledger as settled authority.

## 6. Vendored package integrity

The vendored behavioural contract under `docs/zero-base-design/v3` is **not**
hand-edited by this work package or any later one. Its audit verdict stays
`NOT READY` with REQ-27, REQ-28/M11 and REQ-41 open, as recorded in
`ACCEPTED_RESIDUALS.md`. The only permitted routes to change it are a re-vendor
from a regenerated export, or an explicit new entry in `ACCEPTED_RESIDUALS.md`.
`scripts/zero-base/verify-design-contract.ts` continues to assert the
`NOT READY` verdict and fails if it is ever silently flipped.

## 7. Acceptance

| Acceptance item | Result | Evidence class |
|---|---|---|
| Exact HEAD and source hash evidence | §1 and §3 above | VERIFIED-STATIC |
| ADRs numbered and Accepted | §5 above | VERIFIED-STATIC |
| Contract verifier reported honestly | `NOT READY` preserved, §6 | VERIFIED-STATIC |
| Dirty Share work not lost | §4 — 11/13 present and committed, 2 absent before WP0 and recorded UNKNOWN | VERIFIED-STATIC |

## 8. Rollback

Document-only. Reverting the WP0 commit restores the previous
`DECISION_LOG.md`, the previous `ADR-D070` status line and the previous
`DASHBOARD_V2_REFERENCE_SHA256`. No schema, route, provider or deployed state
is touched by this work package.

## 9. Gate results recorded at WP0 (T1 + T2)

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS**, 0 errors |
| lint | `npx eslint .` | **PASS**, exit 0 |
| unit + integration | `npx vitest run` | **PASS** — 1 048 files, 12 597 tests: 12 389 passed, 144 skipped, 63 todo, 0 failed |
| vendored contract | `npm run zero-base:contract:verify` | **PASS** — 15 vendored files verified; verdict honestly reported as `NOT READY` with REQ-27/28/41 and M11 recorded as residuals |
| generated contracts | `npm run zero-base:contracts:check` | **PASS** — current with the vendored contract |

### 9.1 One pre-existing environment defect, fixed in place

The first `npm run typecheck` failed with

```
.next/dev/types/validator.ts(971,39): error TS2307:
  Cannot find module '../../../app/dev-preview-share/page.js'
```

`tsconfig.json` includes `.next/dev/types/**/*.ts`, and that generated file was
left behind by a local dev-server run referencing an `app/dev-preview-share`
page that exists in no commit and no longer exists on disk. It is stale build
output, not source. Removing `.next/dev/types` (regenerated by Next on the next
run) cleared it; no source file and no `tsconfig` entry was changed. No dev
server was running at the time, so nothing was clobbered — the plan's §17.19
prohibition is about builds against a *live* dev server, which this was not.

### 9.2 One assertion updated as part of ratification

`app/api/meta/decision-as-of-scope.golden.test.ts` asserted
`Status:** Proposed` on the D070 ADR — the guard that stopped the ADR being
treated as authority before ratification. Ratifying it correctly is what makes
that assertion false, so the test now pins the ratified state instead, and a
**second** assertion was added requiring `## D070 -` to be present in
`DECISION_LOG.md`. The pair is stronger than the original: an ADR that calls
itself Accepted without a log entry now fails, which is the failure mode the
original assertion could not see.

This is the only test changed by WP0. No assertion was weakened or deleted.
