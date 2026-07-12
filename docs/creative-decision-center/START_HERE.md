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
- [09-tests-backtest-confidence.md](./09-tests-backtest-confidence.md)
- [10-observability-overrides-security-meta-db.md](./10-observability-overrides-security-meta-db.md)
- [11-ui-copy-pr-sunset-go-no-go.md](./11-ui-copy-pr-sunset-go-no-go.md)

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
- No high-confidence scale/cut on stale or missing data.
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

- Finish audit/mapping review and use the spike tools branch for fixture-backed shadow validation.
- Do not start production resolver changes yet.
