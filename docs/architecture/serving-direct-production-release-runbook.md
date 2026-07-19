# Serving Direct Production Release Runbook

Purpose: define the exact repo-supported direct production release, rollback, and verification flow for the current serving/projection/cache ownership model.

Status: active repo-supported direct release, rollback, and verification procedure

## Deploy Assets Used

This runbook uses only deploy machinery already present in the repo:

- `Dockerfile`
  - `web-runner` and `worker-runner` production image targets
- `docker-compose.yml`
  - `web`, `worker`, and `migrate` production services
- `.github/workflows/ci.yml`
  - runs `typecheck`, `test`, and `database-seams` on pull requests and `main`
  - runs the application `build` job on pull requests
  - publishes `ghcr.io/erhanrdn/omniads-web:<sha>` and `ghcr.io/erhanrdn/omniads-worker:<sha>` when runtime-affecting files changed
  - dispatches `.github/workflows/deploy-hetzner.yml` after image publish succeeds
- `.github/workflows/deploy-hetzner.yml`
  - deploys an exact full 40-character SHA to Hetzner
  - pulls exact-SHA images
  - runs the existing `migrate` service
  - force-recreates `web` and `worker`
  - verifies container images, `/api/build-info`, optional container health, public ingress build-id match, and ingress smoke
- `.github/workflows/post-deploy-verify.yml`
  - uploads the report-only post-deploy release-authority artifact for the exact deployed SHA
- `deploy/nginx/adsecute.conf`
  - public reverse-proxy shape for the Hetzner host
- `scripts/verify-serving-direct-release.ts`
  - read-only preflight and post-deploy verification CLI used by the current operator workflow

## Exact Repo-Supported Deploy Prerequisite

Direct production deploy is blocked unless the target release SHA already has published runtime images.

Why:

- Production only pulls exact image tags from GHCR.
- The repo’s image publish lane exists in `.github/workflows/ci.yml` and runs on `push` to `main`.
- `.github/workflows/deploy-hetzner.yml` does not build images on the server.

Practical rule:

- For a new release SHA, make that exact commit reachable as `main` so CI can publish `ghcr.io/erhanrdn/omniads-web:<sha>` and `ghcr.io/erhanrdn/omniads-worker:<sha>`.
- For rollback, use a previously deployed or otherwise already-published full SHA.

## Preflight

Run these on the exact candidate SHA before releasing it directly:

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
  [--start-date=YYYY-MM-DD] \
  [--end-date=YYYY-MM-DD] \
  [--demographics-dimension=country]
```

Auth input for HTTP smoke:

- `--session-cookie <token>`
- or `--session-cookie-file <path>`

The token is the raw `omniads_session` cookie value from an existing authenticated internal operator session. The script converts it into the `Cookie:` header itself.

Preflight blockers:

- Typecheck, side-effect scan, or architecture baseline failure
- `scripts/verify-serving-direct-release.ts` reporting any `automated_missing` surface
- optional HTTP smoke reporting `/api/build-info` failure or any non-2xx response on the verified GET route set

Acceptable preflight findings:

- `manual_boundary`
- `manual_missing`
- `unknown`

Those are operator-visible outputs, not automatic release blockers by themselves.

## Direct Deploy

The repo-supported direct production deploy path is:

1. Make the target SHA the `main` branch head.
2. Let `.github/workflows/ci.yml` run:
   - `typecheck`
   - `test`
   - `database-seams`
   - `detect-runtime-changes`
   - `publish-web-image` and `publish-worker-image` when runtime changed
   - `dispatch-deploy` after both exact-SHA image publishes succeed

   The application `build` job is a pull-request gate; the main-push image
   publish jobs perform the exact production Docker builds.
3. Let `.github/workflows/deploy-hetzner.yml` perform the server cutover.
4. Let `.github/workflows/post-deploy-verify.yml` upload the report-only
   release-authority artifact for the same SHA.

What the deploy workflow already does on the server:

- uploads the current `docker-compose.yml`
- sets `APP_IMAGE_TAG=<sha>` and `APP_BUILD_ID=<sha>`
- pulls exact-SHA `web` and `worker` images
- runs the `migrate` service
- recreates `web` and `worker`
- verifies the running container images match the requested SHA
- waits for `/api/build-info` to return the same `buildId`
- checks optional container health
- verifies `https://adsecute.com/api/build-info` and `https://www.adsecute.com/api/build-info`
- runs public ingress smoke on `https://adsecute.com/about` and `https://www.adsecute.com/about`
- dispatches `.github/workflows/post-deploy-verify.yml` for the report-only
  post-deploy release-authority artifact

If an operator needs a direct manual deploy of an already-published SHA, use the existing GitHub Actions workflow dispatch:

- Workflow: `Deploy to Hetzner`
- File: `.github/workflows/deploy-hetzner.yml`
- Input `sha`: full 40-character commit SHA
- Input `require_current_main_head`:
  - `true` when releasing the current `main` head
  - `false` only for explicit redeploy/rollback of a previously published SHA

Do not use branch names, short SHAs, `main`, or `latest` in place of the full SHA.

## Post-Deploy Verification

The post-deploy workflow uploads an artifact named
`post-deploy-verify-<sha>` containing
`post-deploy-release-authority.json`. Its verification step is report-only and
may continue after a failed authority check, so a green workflow conclusion
alone is insufficient. Inspect the artifact and require the exact
deployed/main/live SHA, `summary.result: "pass"`, and an empty
`summary.blockers` list.

After the deploy workflow finishes, run:

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

The verification CLI stays read-only:

- no migrations
- no request-path writes
- no cache warming
- no repair triggers
- no new persistence

It reports:

- `releaseMode`
- target base URL
- observed `/api/build-info` result and `buildId`
- route-by-route authenticated GET smoke results for:
  - `/api/overview`
  - `/api/overview-summary`
  - `/api/overview-sparklines`
  - `/api/analytics/overview`
  - `/api/analytics/audience`
  - `/api/analytics/cohorts`
  - `/api/analytics/demographics`
  - `/api/analytics/landing-page-performance`
  - `/api/analytics/landing-pages`
  - `/api/analytics/products`
  - `/api/seo/overview`
  - `/api/seo/findings`
- full serving freshness status for the in-scope surfaces
- exact fallback commands for the intentional manual boundaries
- a conservative `pass` / `fail` summary with explicit blockers

Post-deploy blockers:

- `/api/build-info` unavailable or returning the wrong `buildId`
- any non-2xx response from the verified GET route set when authenticated HTTP smoke is enabled
- any `automated_missing` freshness entry

Post-deploy acceptable findings:

- intentional `manual_boundary`
- intentional `manual_missing`
- `unknown` where the repo-supported checks cannot prove applicability

The natural Meta scheduler verification is a separate operational gate; the
post-deploy workflow does not observe a Meta watch window. After the first
natural 03:00 UTC scheduler wave following the deploy has completed, verify
current-epoch calibration, decisions, operator jobs, chain ordering, counts,
receipts, and lineage with SELECT-only queries in an explicit repeatable-read,
read-only transaction. Do not trigger cron manually, write the live database,
or call a provider to manufacture this proof.

## Rollback

Rollback uses the same exact deploy workflow and no alternate platform.

Steps:

1. Identify the previous known-good full 40-character SHA.
2. Confirm that SHA already has published GHCR images.
3. Run the existing `Deploy to Hetzner` workflow manually with:
   - `sha=<known_good_sha>`
   - `require_current_main_head=false`
4. Re-run post-deploy verification against the rolled-back SHA:

```bash
node --import tsx scripts/verify-serving-direct-release.ts <businessId> \
  --mode=post_deploy \
  --base-url=https://adsecute.com \
  --expected-build-id=<known_good_sha> \
  [--session-cookie-file=/path/to/omniads_session.txt]
```

The current repo-supported rollback mechanism is application-image rollback only. This runbook does not add schema rollback machinery, and it does not require it for the documented serving/projection/cache hardening work.

## Manual Boundaries After Release

The following remain intentional operator-owned boundaries after direct production release:

- exact selected `platform_overview_summary_ranges`
- non-default GA4 windows
- non-`country` GA4 demographics dimensions
- `overview_shopify_orders_aggregate_v6` windows outside the automated recent window

Use the exact commands emitted by:

```bash
node --import tsx scripts/report-serving-freshness-status.ts <businessId> [--start-date=YYYY-MM-DD] [--end-date=YYYY-MM-DD] [--overview-provider=google|meta] [--demographics-dimension=<dimension>]
```

or by:

```bash
node --import tsx scripts/verify-serving-direct-release.ts <businessId> --mode=preflight [same flags...]
```
