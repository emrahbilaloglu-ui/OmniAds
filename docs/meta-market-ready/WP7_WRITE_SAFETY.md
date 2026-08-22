# WP7 — Shared mutation safety foundation

Work package: WP7 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP6
Date: 2026-08-22

Goal: Decisions, Automation and Launchpad share one safe write contract.

## 1. What "share one contract" means here — and what it does not

Three write families exist, built at different times against different modules:
Decisions manual actions, Automation proposal approval, Launchpad create.
Nothing forced them to agree about what "safe" means.

WP7 does **not** rewrite them into one call stack. Each is individually
hardened, differently shaped, and carries ratified decisions (D065 action
origin, D067 attempt journal, D069 retry blocking) that a merge would have to
relitigate. Rewriting three working write paths to share a call stack is a large
risk with no test-provable benefit, and the plan's own rule is small reversible
changes.

What WP7 does instead is make the contract **explicit and machine-checked**.
`lib/meta/write-safety-contract.ts` states §10's eighteen steps and §10.1's nine
invariants as data, and each family declares — step by step — what implements it
and where, or states plainly that it does not.

A `not_applicable` needs a reason as much as a `missing` does. A step waved away
without one is indistinguishable from a step nobody looked at, and the test
enforces that.

## 2. The finding: two families conform, one does not

| Family | Conformance |
|---|---|
| Decisions — manual ad pause/resume | **18/18** |
| Automation — proposal approval | **18/18** |
| Launchpad — create | **11/18** at WP7's end (was 10/18) |

Launchpad's seven remaining gaps, named rather than summarised:

| Step | Why it is missing |
|---|---|
| 6. fresh provider / current-state read | Create validates inputs but does not read the target account's current state immediately before posting |
| 9. persisted preflight | Validation is per-request and not persisted, so there is no row to age-check or audit |
| 10. preflight age disclosure | Follows from 9 |
| 12. durable idempotency claim | An `idempotencyKey` is required and carried, but no durable claim is written before the POST, so a concurrent replay is not excluded |
| **15. independent provider read-back** | The route trusts the create response. §10.1: **a provider 200 is not a read-back.** This is WP15's central requirement |
| 16. exact identity/state verification | Follows from 15 — there is nothing to verify against |
| 17. terminal receipt / reconciliation marker | An ambiguous create has no parking equivalent to `duplicate-ad-reconciliation` |

Two Launchpad steps are `not_applicable` with stated reasons: a new campaign has
no pre-existing parent hierarchy, and every create is PAUSED (ADR-003 rule 4) so
nothing begins spending and no compensation is required before activation exists.

## 3. The check that gives the contract teeth

`openGatesWithMissingSteps()` returns any family whose **release gate is open**
while steps are still missing, and the test asserts it is empty.

A family may be incomplete as long as it cannot reach Meta. The moment its gate
opens, every step must be satisfied. So:

```
process.env.META_LAUNCHPAD_EXECUTION = "true";  // → test fails, naming the 7 gaps
```

WP15's precondition stops being a promise in a document. Enabling execution
before the read-back exists does not quietly ship an unverified create — it
fails the build. Closing the seven gaps is what makes that test go green with
the gate open, which is exactly the order the plan requires.

## 4. One gap closed in WP7: the Meta Stop now reaches Launchpad

Decisions and Automation both gate on `getMetaWriteBlockState`. **Launchpad did
not.**

So an operator who engaged the business kill switch — or an incident responder
who set `META_ADS_WRITE_KILL_SWITCH` — stopped every Meta write *except a
Launchpad create*. A stop that is global in the operator's mind and partial in
fact is the worst thing a safety control can be, and it is the plan's rollback
trigger 8/9 territory.

`rejectIfLaunchpadMetaWritesBlocked` now runs in both write routes, after the
execution gate (the cheaper refusal, costing no database read) and before every
provider-facing step. It also covers the demo workspace and fails **closed** on
an unreadable control plane: a control plane we cannot read blocks the write
rather than admitting it by default.

`403` for a demo workspace (an authority fact) and `503` otherwise (a state
fact) — the same distinction WP1 drew for the execution gate.

## 5. Changes

| File | Change |
|---|---|
| `lib/meta/write-safety-contract.ts` | **new** — the 18 steps, 9 invariants, 3 family conformance records |
| `lib/meta/write-safety-contract.test.ts` | **new** — 10 cases, including the open-gate check |
| `app/api/launchpad/meta/route-utils.ts` | `rejectIfLaunchpadMetaWritesBlocked` |
| `app/api/launchpad/meta/{launch,add-to-existing}/route.ts` | the guard, ordered after the gate |
| `app/api/launchpad/meta/execution-gate.test.ts` | 2 cases pinning presence, ordering and fail-closed |

## 6. Acceptance

The plan's WP7 acceptance is a **guarded sandbox matrix**: wrong tenant, wrong
account, reviewer, demo, kill switch, stale preflight, duplicate idempotency,
429, 5xx, network ambiguity, receipt-persistence failure, read-back mismatch.

| Case | Status |
|---|---|
| wrong tenant / wrong account / reviewer / demo | **PASS (pre-existing)** for Decisions and Automation; unit-covered in their own suites | 
| kill switch | **PASS** — now covers all three families | 
| stale preflight, duplicate idempotency, read-back mismatch | **PASS (pre-existing)** for Decisions — the `current_ad_state_stale`, `idempotency_conflict` and `verification_*` blockers | 
| 429 / 5xx / network ambiguity / receipt-persistence failure | **UNKNOWN** — needs the guarded sandbox against a real provider, which requires credentials and explicit approval |
| "a second same-key POST does not reach the provider" | **PASS (pre-existing)** for Decisions and Automation; **MISSING** for Launchpad and recorded as such |

The sandbox itself is not run in this session. What WP7 delivers is that the
matrix now has a machine-readable statement of which families it must pass for,
and a gate that refuses to open without it.

## 7. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 548 passed, 0 failed (WP6: 12 536; +12) |

## 8. Rollback

Per write family, as the plan asks. The conformance contract is inert data —
deleting it removes the check and nothing else. The Launchpad kill-switch guard
is one hunk per route and reverting it restores the previous behaviour, in which
a Meta Stop did not stop a Launchpad create.
