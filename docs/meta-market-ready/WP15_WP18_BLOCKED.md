# WP15 and WP18 — blocked, with the exact preconditions

Work packages: WP15 (Launchpad real execution) and WP18 (staged release, canary,
rollback) of `docs/meta-market-ready-master-plan-2026-08-22.md`
Date: 2026-08-22

Neither is done, and neither is partially done. This records **why**, and what
would close each — precisely enough that the next session can pick it up without
re-deriving any of it.

## 1. WP15 — Launchpad real execution

### 1.1 The plan's own preconditions are not met

WP15 states four:

| Precondition | State |
|---|---|
| WP0–WP14 DONE | **No.** WP9 has three uncomposed sections; WP10's five-tab matrix is unverified; WP13 and WP14 each carry named open items. All recorded in their own reports |
| Guarded sandbox green | **No.** Never run. It needs provider credentials and a sandbox account |
| Release authority approval | **Not given.** The plan's own start-instruction rule 9 requires explicit approval for any production provider write, and none was requested or granted in this session |
| A dedicated canary ad account | **Does not exist**, or at least was not identified |

### 1.2 Seven of the eighteen safety steps are missing

From `lib/meta/write-safety-contract.ts`, the Launchpad create family satisfies
11 of 18. Missing:

| § | Step | Gap |
|---|---|---|
| 6 | fresh provider / current-state read | create validates inputs but does not read the target account's current state immediately before posting |
| 9 | persisted preflight | validation is per-request and not persisted, so nothing can be age-checked or audited |
| 10 | preflight age disclosure | follows from 9 |
| 12 | durable idempotency claim | a key is required and carried, but no durable claim is written before the POST, so a concurrent replay is not excluded |
| **15** | **independent provider read-back** | the route trusts the create response. §10.1: **a provider 200 is not a read-back.** This is WP15's central requirement |
| 16 | exact identity/state verification | follows from 15 — there is nothing to verify against |
| 17 | terminal receipt / reconciliation marker | an ambiguous create has no parking equivalent to `duplicate-ad-reconciliation` |

### 1.3 Why they were not built in this pass

A provider read-back that has never run against a provider is the **worst kind
of safety code**: it looks like protection, it passes its own unit tests, and
the first time it meets a real Meta response is in production, on a write.

The same applies to the reconciliation parking, whose entire purpose is handling
an outcome shape nobody has observed. Building these without a sandbox would
produce code that cannot be trusted precisely where trust matters most, and the
plan says so itself in §14: "test-green ≠ market-ready".

### 1.4 What IS in place, so WP15 starts from a real position

- `META_LAUNCHPAD_EXECUTION`, default off, **enforced on the server** before any
  account resolution or credential read (WP1), so a replayed POST costs nothing.
- The Meta Stop now reaches Launchpad (WP7) — previously an engaged kill switch
  stopped every Meta write *except* a Launchpad create.
- Reviewer, demo, role, bounds and account-assignment guards, all pre-existing.
- Every create already sets `status: "PAUSED"`.
- **The gate cannot be opened while the gaps remain.**
  `openGatesWithMissingSteps()` fails the build if
  `META_LAUNCHPAD_EXECUTION=true` while any step is missing. WP15's precondition
  is machine-checked, not a promise in a document.

Closing the seven steps is what turns that test green with the gate open, which
is exactly the order the plan requires.

## 2. WP18 — staged release, canary and rollback

**Not started.** No deploy, no canary, no production read, no production write.

The plan's start-instruction rule 9 is unambiguous: *"Explicit approval olmadan
production DB/provider write veya deploy yapma."* No approval was given, so
steps 3–11 of the release sequence were not attempted.

### 2.1 What was completed of the release sequence

| Step | State |
|---|---|
| 1. local static / unit / integration | **DONE** — typecheck, eslint and 12 600 tests green on every work package |
| 2. ephemeral DB from-zero and upgrade migration | **DONE** — `test:migrations-from-zero` and `test:schema-upgrade-seam` both pass, run because WP17 widened a CHECK constraint |
| 3. authenticated staging | not attempted |
| 4. production-read-only internal user | not attempted |
| 5. single-business allowlist, writes off | not attempted |
| 6. ≥24h read-only canary | not attempted |
| 7. Automation guarded sandbox | not attempted |
| 8. Launchpad single PAUSED write canary | not attempted — and blocked by WP15 regardless |
| 9. provider read-back | not attempted |
| 10. ≥72h post-release observation | not attempted |
| 11. controlled wider rollout | not attempted |

### 2.2 The feature-flag split exists and defaults closed

§18's split is implemented in `lib/meta/release-gates.ts`, every gate defaulting
off, with `dryRunOnly` written as its **own reading** rather than
`!liveWrites` — so deleting the live-writes gate leaves the safe posture rather
than inverting it.

| Gate | Purpose | Default |
|---|---|---|
| `META_LAUNCHPAD_EXECUTION` | Launchpad provider creates | off |
| `META_DECISION_WORKFLOW_UI` | Decisions ownership actions | off |
| `META_AUTOMATION_STOP_UI` | Meta Stop engage/release control | off |
| `META_AUTOMATION_LIVE_WRITES` | Automation executes instead of dry-run | off |
| `META_PUBLIC_SHARE_MINT` | minting new public share links | off |
| `META_ACCOUNT_PICKER` | changing the selected Meta account | off |

### 2.3 Deploy rules that must be honoured when this does run

Recorded here because they are known traps in this repository, not general
advice:

- The image builds **only on a push to `main`**. Deploying a feature branch
  produces `manifest unknown`.
- Deploy the **exact SHA**. A bare `docker compose up` reverts production to the
  tag in the server's `.env`, because the wrapper sets `APP_IMAGE_TAG` inline and
  never writes it back.
- Check the **hand-added nginx per-route blocks** before diagnosing a live
  503/404. They short-circuit before the app and are invisible in app logs.
- Measure `meta_entity_state_history` **before** deploy readiness. A 200 KB
  breach of a 4 GiB ceiling once killed every Meta observation write for a day,
  and the only visible symptom was Decision Center showing zero Creatives.

## 3. The honest summary

WP15 and WP18 are the two work packages that cannot be completed from a
development session. Everything they need — a provider sandbox, a canary
account, production access, release authority — is outside it by design, and the
plan gates them behind explicit approval for exactly that reason.

What this session could do for them, it did: the gates exist, default closed,
are enforced on the server, and **refuse to open while the safety steps they
guard are unfinished**.
