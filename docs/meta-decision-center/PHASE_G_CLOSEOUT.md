# Phase G Closeout

Phase G covers final regression, deploy evidence, context preservation, and
golden-case/invariant documentation. It is not a claim that every possible Meta
scenario is implemented or automation-ready.

## Completed Evidence

| item | status | evidence |
|---|---|---|
| Phase A-F.4 implementation PRs | complete | PRs `#162` through `#173` merged; exact SHAs are in `CONTEXT_SNAPSHOT.md` |
| Final local regression before runtime deploy | complete | Phase F.4 recorded focused tests, `npx tsc --noEmit`, `npx vitest run lib/meta components/meta app/api/meta`, full `npx vitest run`, `npm run lint`, `npm run build`, and `git diff --check` |
| Runtime deploy | complete | Hetzner deploy run `25947244447` succeeded for `fe1a9f8aedb971d66e669888a907d7d2fcbd7940` |
| Post-deploy verification | complete | Post-deploy run `25947265036` succeeded for `fe1a9f8aedb971d66e669888a907d7d2fcbd7940` |
| Public build-info smoke | complete | `buildId=fe1a9f8aedb971d66e669888a907d7d2fcbd7940`, `deployGate=pass`, `releaseGate=pass`, web/worker healthy |
| Context preservation | complete | `CONTEXT_SNAPSHOT.md` updated through deploy verification and this Phase G closeout |
| Decision log mirror | complete | `DECISION_LOG.md` added for Meta A-F.4 and Phase G decisions |
| Data readiness mirror | complete | `DATA_READINESS.md` added for signal support and safe fallbacks |
| Golden-case maintenance | complete | `GOLDEN_CASES.md` added for Meta A-F.4 contracts |
| Invariant mirror | complete | `INVARIANTS.md` added for Meta label, target, maturity, signal, and automation rules |
| Obsolete fixture prune | complete | `_analysis/phase-g-meta-closeout/2026-05-16-fixture-prune-audit.md` records that no current fixture is obsolete enough to delete |
| Phase G docs verification | complete | `npx vitest run lib/meta/empirical-outcomes.test.ts lib/meta/empirical-outcome-integration.test.ts lib/meta/decision-outcomes.test.ts lib/meta/automation-readiness.test.ts` passed: 4 files, 21 tests |
| Phase G local regression | complete | `npx tsc --noEmit`; `npx vitest run lib/meta components/meta app/api/meta` passed: 113 files, 1017 tests; full `npx vitest run` passed: 413 files, 2970 tests, 4 files and 49 tests skipped; `npm run lint`; `npm run build`; `git diff --check` |

## Known Non-Blocking Limitations

- Visible recommendation confidence remains heuristic. It is not the same as
  automation readiness.
- Empirical outcome summaries are attached when logs exist, but they do not
  change visible confidence scores.
- Auto-execute remains blocked without empirical outcome evidence, live
  preflight proof, and rollback proof.
- Unsupported overlap, placement, audience, and feed-source assumptions remain
  diagnose/watch or unimplemented.
- `promote_test_to_main` remains backend payload/diagnostic only; UI CTA binding
  is intentionally deferred.
- Some scenario-library IDs remain unimplemented because their required signals
  are not reliable enough for hard actions. These are deferred to Phase H or
  later, not hidden Phase G work.

## Final Verification Protocol

For future Phase G refreshes, run:

```bash
npx vitest run lib/meta/empirical-outcomes.test.ts lib/meta/empirical-outcome-integration.test.ts lib/meta/decision-outcomes.test.ts lib/meta/automation-readiness.test.ts
npx tsc --noEmit
npx vitest run lib/meta components/meta app/api/meta
npx vitest run
npm run lint
npm run build
git diff --check
gh run list --branch main --limit 5 --json databaseId,headSha,status,conclusion,workflowName,createdAt,event,displayTitle
curl -fsSL 'https://adsecute.com/api/build-info?providerScope=meta'
```

Docs-only commits should pass CI and skip runtime deploy. Runtime deploy should
be re-triggered only when runtime-affecting files change or when live build-info
does not match the expected runtime SHA.
