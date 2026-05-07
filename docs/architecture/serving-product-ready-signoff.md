# Serving Product-Ready Signoff

Purpose: record the final product-ready signoff decision for the serving/projection/cache hardening work, and preserve the exact pre-release approval basis that the current production release followed.

Date: 2026-04-10

Status: approved; the repo-supported deploy prerequisite was later satisfied and the resulting release execution is recorded in `docs/architecture/serving-release-execution-evidence.md`

## Scope Of This Signoff

This signoff covers the in-scope user-facing serving/projection/cache surfaces documented in:

- `docs/architecture/serving-write-ownership-map.md`
- `docs/architecture/serving-operational-freshness-matrix.md`
- `docs/architecture/serving-runtime-validation-evidence.md`
- `docs/architecture/serving-freshness-observability-runbook.md`
- `docs/architecture/serving-direct-production-release-runbook.md`

It does not redefine unrelated feature-specific rollout plans elsewhere in the repo. For this app and this release scope, no new canary logic and no private rollout logic are required.

## Overall Readiness Conclusion

Conclusion:

- The repo is ready for a direct production release of the serving/projection/cache hardening work.
- Direct release is acceptable because:
  - request-path migration entrypoints were removed from passive read traffic
  - repeated authenticated `GET` traffic was runtime-validated as non-mutating for the in-scope serving/projection/cache keys
  - explicit non-`GET` owners are documented and runtime-validated for the automated surfaces
  - intentional manual boundaries are explicit, operator-visible, and have exact CLI fallback commands
  - read-only observability and direct-release verification CLIs now exist in the repo
  - the repo already contains concrete direct deploy and rollback machinery through the existing Hetzner workflow and exact-SHA image deploy flow

This conclusion was conditioned on the deploy prerequisite below. The later release execution evidence shows that the prerequisite was satisfied and the release completed successfully.

## Exact Repo-Supported Deploy Prerequisite

The target full 40-character release SHA must already have published GHCR runtime images.

Exact reason:

- production deploys pull exact image tags only
- `.github/workflows/ci.yml` is the repo-supported image publish lane
- `.github/workflows/deploy-hetzner.yml` deploys exact SHAs but does not build images on the server

Practical meaning:

- new release SHA:
  - must be pushed to `main` so CI can publish `ghcr.io/erhanrdn/omniads-web:<sha>` and `ghcr.io/erhanrdn/omniads-worker:<sha>`
- rollback SHA:
  - must already be a previously published full SHA

If that prerequisite is not satisfied, release is `no-go` until image publish is complete.

## No Canary / No Private Rollout Decision

Accepted final decision:

- this app is treated as a single-user internal app for this release
- no canary logic is required
- no private rollout logic is required
- no new rollout mechanics were added

The direct release path remains the existing repo-supported `main -> GHCR exact-SHA images -> deploy-hetzner workflow -> post-deploy verification` flow.

## Accepted Intentional Manual Boundaries

These boundaries are accepted and do not block signoff:

1. `platform_overview_summary_ranges` exact selected historical ranges
   - accepted because the repo does not already contain an exact bounded non-`GET` lane for speculative or arbitrary selected-range hydration
   - exact owner remains `npm run overview:summary:materialize`
2. Non-default GA4 windows
   - accepted because widening the bounded GA4 sync owner would turn default-window warming into speculative or unbounded work
   - exact owner remains `npm run reporting:cache:warm`
3. Non-`country` `ga4_detailed_demographics` dimensions
   - accepted because the automated GA4 boundary intentionally excludes alternate dimension fan-out
   - exact owner remains `npm run reporting:cache:warm`
4. `overview_shopify_orders_aggregate_v6` outside the automated recent bounded window
   - accepted because the existing Shopify sync owner only owns the recent bounded sync window
   - exact owner remains `npm run reporting:cache:warm`

Why these are accepted:

- ownership is explicit
- runtime read-path safety is preserved
- operator fallbacks are exact and documented
- read-only observability surfaces them clearly

## Exact Preflight Commands

Run these on the release candidate SHA before direct production release:

```bash
npm exec tsc -- -p tsconfig.json --noEmit
node --import tsx scripts/check-request-path-side-effects.ts --json
npm run db:architecture:baseline
node --import tsx scripts/verify-serving-direct-release.ts <businessId> --mode=preflight [--start-date=YYYY-MM-DD] [--end-date=YYYY-MM-DD] [--overview-provider=google|meta] [--demographics-dimension=<dimension>]
```

Optional authenticated HTTP preflight against the currently running environment:

```bash
node --import tsx scripts/verify-serving-direct-release.ts <businessId> \
  --mode=preflight \
  --base-url=https://adsecute.com \
  --session-cookie-file=/path/to/omniads_session.txt \
  [--expected-build-id=<sha>] \
  [--start-date=YYYY-MM-DD] \
  [--end-date=YYYY-MM-DD] \
  [--overview-provider=google|meta] \
  [--demographics-dimension=country]
```

Optional exact manual-boundary inspection:

```bash
node --import tsx scripts/report-serving-freshness-status.ts <businessId> [--start-date=YYYY-MM-DD] [--end-date=YYYY-MM-DD] [--overview-provider=google|meta] [--demographics-dimension=<dimension>]
```

## Exact Direct Deploy Path

Use only the repo-supported deploy machinery already present:

1. Make the target full SHA the `main` branch head.
2. Let `.github/workflows/ci.yml` run:
   - checkout
   - install
   - build/test
   - runtime-change detection
   - GHCR exact-SHA image publish
   - deploy workflow dispatch
3. Let `.github/workflows/deploy-hetzner.yml` run:
   - checkout exact SHA
   - push current `docker-compose.yml` to the server
   - pull exact-SHA `web` and `worker` images
   - run the existing `migrate` service
   - recreate `web` and `worker`
   - verify service images
   - verify `/api/build-info`
   - verify optional container health
   - verify public build-info ingress and public `/about`

Manual direct deploy of an already-published SHA is also repo-supported through the existing workflow dispatch for `.github/workflows/deploy-hetzner.yml` using the full SHA input.

## Exact Post-Deploy Verification Commands

Primary post-deploy verification:

```bash
node --import tsx scripts/verify-serving-direct-release.ts <businessId> \
  --mode=post_deploy \
  --base-url=https://adsecute.com \
  --expected-build-id=<release_sha> \
  [--session-cookie-file=/path/to/omniads_session.txt] \
  [--start-date=YYYY-MM-DD] \
  [--end-date=YYYY-MM-DD] \
  [--overview-provider=google|meta] \
  [--demographics-dimension=country]
```

Optional exact manual-boundary follow-up:

```bash
node --import tsx scripts/report-serving-freshness-status.ts <businessId> [--start-date=YYYY-MM-DD] [--end-date=YYYY-MM-DD] [--overview-provider=google|meta] [--demographics-dimension=<dimension>]
```

Expected post-deploy blockers:

- `/api/build-info` unavailable
- `/api/build-info` returning the wrong build id
- non-2xx response on the verified authenticated route set when HTTP smoke is enabled
- any `automated_missing` status row

Expected acceptable post-deploy results:

- `manual_boundary`
- `manual_missing`
- `unknown` where applicability cannot be derived conservatively

## Exact Rollback Rule

Rollback rule:

- use a previously published full 40-character SHA only
- do not use a branch name, short SHA, `main`, or `latest`
- use the same `.github/workflows/deploy-hetzner.yml` workflow with:
  - `sha=<known_good_sha>`
  - `require_current_main_head=false`

Then rerun:

```bash
node --import tsx scripts/verify-serving-direct-release.ts <businessId> \
  --mode=post_deploy \
  --base-url=https://adsecute.com \
  --expected-build-id=<known_good_sha> \
  [--session-cookie-file=/path/to/omniads_session.txt]
```

## Go / No-Go Checklist

### Go

- target commit is the intended release SHA
- target full SHA already has published GHCR `web` and `worker` images
- preflight commands pass
- direct-release verification CLI shows no `automated_missing` blockers
- if HTTP smoke is run, `/api/build-info` and the verified authenticated `GET` routes succeed
- intentional manual boundaries remain documented and operator-visible
- rollback target SHA is known and already published

### No-Go

- target full SHA does not yet have published GHCR runtime images
- `tsc`, side-effect scan, or architecture baseline fails
- direct-release verification reports any `automated_missing` surface
- post-deploy verification returns the wrong build id or route failures
- release depends on inventing a new deploy platform, rollout mechanic, or ownership change that is not already in the repo

## Exact Remaining Operator Actions Outside The Repo

These operator actions still exist outside the repo and are accepted:

1. Ensure the target release SHA has published GHCR images
   - normally by pushing the exact commit to `main`
2. Maintain the existing production deployment prerequisites
   - GitHub Actions deploy secrets required by `.github/workflows/deploy-hetzner.yml`
   - Hetzner host access
   - production `.env.production`
   - existing nginx and public DNS setup
3. Supply an authenticated operator `omniads_session` cookie if authenticated HTTP smoke is desired

None of those actions require new repo code for this signoff.

## Accepted Non-Blocking Residual Debt

These remain out of scope for this signoff and do not block direct production release of the serving/projection/cache hardening work:

- large mixed-concern modules such as `lib/platforms/google/serving.ts`, `lib/platforms/google/warehouse.ts`, and `lib/meta/serving.ts`
- direct status-route coupling to control-plane tables instead of dedicated summary projections
- `lib/migrations.ts` remaining a large runtime migration bundle even though request/read-path bootstrap was removed
- intentional operator-owned manual freshness boundaries listed above

Those are real follow-up engineering debt items, but the current repo state already satisfies the ownership, runtime-truth, observability, direct-release verification, and rollback requirements for this release scope.

## Final Signoff Decision

Signoff decision:

- `GO`, conditioned on the exact deploy prerequisite being met

No additional canary, private rollout, ownership change, or runtime behavior change is required for this signoff.
