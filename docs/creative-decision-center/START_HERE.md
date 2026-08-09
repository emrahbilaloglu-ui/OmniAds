# Creative Decision Center V2.1 — START HERE

This is the first file future GPT/Codex/Claude chats should read before working on the Adsecute / OmniAds Creative page migration.

## Project summary

Adsecute / OmniAds Creative page should become a media buyer decision center, not a dashboard.

The page should not ask the buyer to reverse-engineer metrics. It should present clear actions, evidence, confidence, and blockers.

## Core user question

> What should I do, why, and with how much confidence?

## Current conclusion

- Evolve `creative-decision-os-v2` to V2.1.
- Do not create a new standalone decision core unless `DECISION_LOG.md` is updated with a new ADR and repo evidence proves V2 cannot be safely extended.
- Keep `primaryDecision` separate from `buyerAction`.
- Use a deterministic buyer-facing adapter.
- Keep `brief_variation` page/family aggregate only.

### 2026-07-12 historical-simulation closure (`HISTORICAL_SEARCH_EXHAUSTED_REVIEW_ONLY`)

Read [HISTORICAL_SIMULATION_CLOSURE_REPORT_2026-07-12.md](./HISTORICAL_SIMULATION_CLOSURE_REPORT_2026-07-12.md)
before proposing another threshold, confidence, structure, context, or
hysteresis variant. All bounded H1-H12 families, native/structure replays,
3d/7d/14d outcomes, H10 calibration, and expanded H11/H12 policies have run.
No challenger passed its locked promotion gate. D049 remains a monotonic
safety invariant, not proven historical lift. D060 closes the duplicate native
Cut veto without promoting a challenger: calibrated P25 remains the relative
path, while an uncalibrated exact purchase cell may use the existing fallback
only after explicit break-even narrows it. D061 fixes a distinct evidence-grain
defect: cutoff-safe physical-account/currency AOV may size Cut loss budget when
the exact cell is thin, but it cannot supply peer percentiles or Scale/Refresh
authority. Its frozen production-function replay and fixed-cohort historical
baseline/challenger replay must run before live accrual. D064 additionally
hardens held-action presentation, account-currency copy, and a deterministic
synthetic review-only demo without creating another decision core. D065 keeps
native-decision, manual-operator, and Launchpad write authority explicit and
requires fresh exact provider identity/hierarchy proof without changing
resolver math. D066 separates authoritative Ad-day facts from update-only
creative presentation enrichment, preserves the retained peer-calibration
contract while keeping strict `finalized_at` for physical-account economic
proof, and makes replay availability restatements exact and forward-only. The
current release candidate is versioned under
`v3-2026-07-18-decision-presentation-hardening`; deployment state must be
verified from `/api/build-info`, not inferred from this document.

The D061 historical replay has two deliberately separate evidence lanes. Exact
persisted/PIT inputs may support promotion; finalized-daily Lane B is a
formula-sensitivity review only. Lane B must keep immutable source timestamps
hash-bound, explicitly restate only finalized/passed daily availability, use
the resolved production profile scope for D036 memory, advance every available
daily decision before outcome sampling, and require the requested exact
calibration cell. It cannot invent an account-wide fallback or open automation
when historical SCD0/context facts were not retained.

Its v3 output also separates release-stopping evidence integrity from
observational promotion quality. Integrity failure remains `stop_and_fix`;
insufficient Lane B precision, recall, named-account, or consecutive-day
coverage is recorded as `review_only_reject_promotion` and never opens
automation. D036 warm-up decisions advance state but do not enter the locked
quality window.

The strict replay found 17,233 restated native rows but zero cutoff-safe
status/format/lifecycle/ranking rows, so hard actions correctly fail closed.
The exact replay found 87 generation-safe 7d windows, 77 generation-safe 28d
windows, and 362 exact branch-terminal resolutions, but no full canonical
resolver input chain. The remaining limits are facts that were not retained,
insufficient hard-known calibration samples, or causal counterfactuals without
controlled treatment. They must not be restated as an untried replay task.

## Canonical read order

1. [CONTEXT_SNAPSHOT.md](./CONTEXT_SNAPSHOT.md)
2. [DECISION_LOG.md](./DECISION_LOG.md)
3. [ARCHITECTURE.md](./ARCHITECTURE.md)
4. [VOCABULARY_MAPPING.md](./VOCABULARY_MAPPING.md)
5. [DATA_READINESS.md](./DATA_READINESS.md)
6. [GOLDEN_CASES.md](./GOLDEN_CASES.md)
7. [INVARIANTS.md](./INVARIANTS.md)
8. [CONTRACTS.md](./CONTRACTS.md)
9. [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)
10. [PR_SEQUENCE.md](./PR_SEQUENCE.md)
11. [RISK_REGISTER.md](./RISK_REGISTER.md)
12. [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)

Before implementing resolver changes, read `DECISION_LOG.md`, `DATA_READINESS.md`, `GOLDEN_CASES.md`, and `INVARIANTS.md`.

## Evidence / audit reports

- [00-repo-audit.md](./00-repo-audit.md)
- [01-vocabulary-mapping.md](./01-vocabulary-mapping.md)
- [02-data-readiness.md](./02-data-readiness.md)
- [03-before-after-shadow-report.md](./03-before-after-shadow-report.md)
- [04-golden-cases.md](./04-golden-cases.md)
- [05-migration-plan.md](./05-migration-plan.md)
- [06-risk-register.md](./06-risk-register.md)
- [07-product-acceptance-criteria.md](./07-product-acceptance-criteria.md)
- [08-identity-target-time-audit.md](./08-identity-target-time-audit.md)
- [NATIVE_AD_ACCOUNT_AOV_AUTHORITY_2026-07-16.md](./NATIVE_AD_ACCOUNT_AOV_AUTHORITY_2026-07-16.md)
- [09-tests-backtest-confidence.md](./09-tests-backtest-confidence.md)
- [10-observability-overrides-security-meta-db.md](./10-observability-overrides-security-meta-db.md)
- [11-ui-copy-pr-sunset-go-no-go.md](./11-ui-copy-pr-sunset-go-no-go.md)
- [HISTORICAL_SIMULATION_CLOSURE_REPORT_2026-07-12.md](./HISTORICAL_SIMULATION_CLOSURE_REPORT_2026-07-12.md)
- [H1_COUNTRY_PARENT_CHALLENGER_2025-12-01_TO_2026-07-05.md](./H1_COUNTRY_PARENT_CHALLENGER_2025-12-01_TO_2026-07-05.md)

## Generated artifacts

- [generated/README.md](./generated/README.md)
- [generated/aggregate-test.json](./generated/aggregate-test.json)
- [generated/before-after-shadow.json](./generated/before-after-shadow.json)
- [generated/config-sensitivity.json](./generated/config-sensitivity.json)
- [generated/data-readiness-coverage.json](./generated/data-readiness-coverage.json)
- [generated/golden-cases.json](./generated/golden-cases.json)
- [generated/live-status.json](./generated/live-status.json)
- [generated/performance-smoke.json](./generated/performance-smoke.json)

Check `generated/live-status.json` before treating any artifact as live DB/API evidence. If live-status says `attempted=false` or `DATABASE_URL` is missing, the artifacts are fixture-backed/planning evidence only.

Generated artifacts are planning and shadow-validation context. They are not production implementation and they do not prove live behavior unless live status explicitly says a live read occurred.

## Non-negotiables

- UI must not compute buyerAction.
- No row-level brief_variation.
- Missing data may remain persisted as legacy `diagnose` / `diagnose_data`,
  but buyer-facing Meta Decisions must serve it as a blocked resolution with a
  nullable buyer action. See D035.
- No high-confidence scale/cut on stale or missing performance/source data.
  A valid configured commercial target's age is advisory and is not source
  staleness; missing, invalid, or cutoff-unsafe target provenance still blocks.
- Policy and delivery blockers override performance.
- Campaign/adset paused must not become `fix_delivery`.
- Do not rename routes in the first migration PR.
- Do not delete V1/operator/V2 snapshot compatibility early.
- Do not implement resolver changes before reading `DECISION_LOG.md`, `DATA_READINESS.md`, `GOLDEN_CASES.md`, and `INVARIANTS.md`.
- Config-as-data is required; no scattered hard-coded thresholds.

## Known blockers

- V2 input lacks or may lack required fields for `fix_delivery`, `fix_policy`, `watch_launch`, and reliable fatigue.
- Known risky or missing fields include `ctr`, `cpm`, `frequency`, `firstSeenAt`, `firstSpendAt`, `reviewStatus`, `disapprovalReason`, `limitedReason`, and `spend24h`.
- `operator-policy` and `operator-surface` are first-class migration scope.
- Live before/after shadow comparison is not complete unless `generated/live-status.json` and `03-before-after-shadow-report.md` prove otherwise.
- Historical outcome backtest is not complete unless `09-tests-backtest-confidence.md` proves otherwise.
- Old snapshots need read-time compatibility.

## Next recommended action

- Do not reopen a bounded H1-H12 alternative without a new retained evidence
  source and an explicit ADR.
- Keep inferred campaign-context hard-action authority and auto-execution
  closed. Automatic context consumption is the default presentation path;
  unresolved context preserves explicit review-only verdicts and never creates
  a required manual-label queue.
- Treat every new engine epoch as a separate release task with the standard
  migration, replay, test, review, and rollback gates.
