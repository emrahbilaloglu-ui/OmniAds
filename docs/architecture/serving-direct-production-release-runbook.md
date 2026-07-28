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
  - builds/tests the repo on `main`
  - publishes `ghcr.io/emrahbilaloglu-ui/omniads-web:<sha>` and `ghcr.io/emrahbilaloglu-ui/omniads-worker:<sha>` when runtime-affecting files changed
  - dispatches `.github/workflows/deploy-hetzner.yml` after image publish succeeds
- `.github/workflows/deploy-hetzner.yml`
  - deploys an exact full 40-character SHA to Hetzner
  - pulls exact-SHA images
  - runs the existing `migrate` service
  - force-recreates `web` and `worker`
  - verifies container images, `/api/build-info`, optional container health, public ingress build-id match, and ingress smoke
- `.github/workflows/post-deploy-verify.yml`
  - records report-only post-deploy release authority and Meta watch-window observation for the exact deployed SHA
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

- For a new release SHA, make that exact commit reachable as `main` so CI can publish `ghcr.io/emrahbilaloglu-ui/omniads-web:<sha>` and `ghcr.io/emrahbilaloglu-ui/omniads-worker:<sha>`.
- For rollback, use a previously deployed or otherwise already-published full SHA. If that SHA predates the repository ownership transfer, read "Rollback Across the Ownership Transfer" below before starting the cutover — its images live under a different GHCR namespace.

## Preflight

**Before pushing, run the same thing CI runs, on the final tree:**

```bash
npm run verify:pre-push
```

That is typecheck, lint, the full unit suite, then
`scripts/verify-database-seams.sh` — the single canonical sequence the
`database-seams` CI job invokes. There is no second list to keep in step, and
the release-owner guard is deliberately its last stage, because earlier stages
rewrite the tree (the cutover wrapper manifest in particular) and a guard that
runs first vouches for a tree that no longer exists.

Run it **after your last edit**, not before. A guard that passed on an earlier
version of the tree has told you nothing about the one you are about to push;
that is exactly how `c02aff0b5` shipped green locally and failed in CI.

Then run these on the exact candidate SHA before releasing it directly:

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

**Merging is not releasing.** CI on `main` proves the code and publishes the
exact-SHA images. It does **not** put them on a server. Production deployment is
a separate act that a person performs.

This used to be automatic: a `dispatch-deploy` job called the deploy workflow as
soon as both images published, so every merge to `main` that touched runtime
code shipped itself. That job has been removed permanently. Restoring it fails
`scripts/deploy-gate-ordering-check.sh` (checks R1–R3), which asserts that no
workflow dispatches a deploy, that `deploy-hetzner.yml` is `workflow_dispatch`
only, and that the dispatch still enumerates its image namespace and verifies
its SHA.

The repo-supported direct production deploy path is:

1. Make the target SHA the `main` branch head.
2. Let `.github/workflows/ci.yml` run:
   - `build-test`
   - runtime-change detection
   - exact-SHA GHCR image publish
   - **no deploy is dispatched — CI stops here**
3. Confirm the images for that SHA are pullable by the app host. GHCR packages
   are created **private** on first publish and the host pulls anonymously, so a
   brand-new package must be made public (or the host given a `read:packages`
   login) before the first deploy into a new namespace. Check with
   `docker manifest inspect ghcr.io/emrahbilaloglu-ui/omniads-web:<sha>`.
4. **Explicitly dispatch** `.github/workflows/deploy-hetzner.yml` with:
   - `sha` — the exact 40-character lowercase commit SHA. Uppercase is refused
     rather than normalised: a tag is case-sensitive and guessing what the
     caller meant is how the wrong thing ships.
   - `image_namespace` — `current` for anything built after the transfer to
     `emrahbilaloglu-ui`, `legacy` only for a pre-transfer SHA (see *Rollback
     Across the Ownership Transfer*).
5. Let `.github/workflows/post-deploy-verify.yml` capture report-only release authority and watch-window observation for the same SHA.

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
- dispatches `.github/workflows/post-deploy-verify.yml` for report-only post-deploy observation

If an operator needs a direct manual deploy of an already-published SHA, use the existing GitHub Actions workflow dispatch:

- Workflow: `Deploy to Hetzner`
- File: `.github/workflows/deploy-hetzner.yml`
- Input `sha`: full 40-character commit SHA
- Input `require_current_main_head`:
  - `true` when releasing the current `main` head
  - `false` only for explicit redeploy/rollback of a previously published SHA

Do not use branch names, short SHAs, `main`, or `latest` in place of the full SHA.

## Post-Deploy Verification

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

## Rollback Across the Ownership Transfer

The repository was transferred from `erhanrdn/OmniAds` to `emrahbilaloglu-ui/OmniAds`. Images published after the transfer live under `ghcr.io/emrahbilaloglu-ui`, which is the default this repo now deploys from.

Images published **before** the transfer were never republished under the new owner. They exist only under `ghcr.io/erhanrdn`. This includes the currently recorded rollback target in `docs/v3-01-release-authority.md` and `/api/release-authority`.

Consequence: pulling a pre-transfer SHA with the default image repository fails with `manifest unknown`, because the tag does not exist under the new namespace. The commit SHA is valid in both namespaces; the *image* is not.

Step 0 for any rollback — do this before the cutover, not during it:

```bash
docker manifest inspect ghcr.io/emrahbilaloglu-ui/omniads-web:<known_good_sha> >/dev/null 2>&1 && echo "new namespace" || echo "not in new namespace"
docker manifest inspect ghcr.io/erhanrdn/omniads-web:<known_good_sha>          >/dev/null 2>&1 && echo "legacy namespace" || echo "not in legacy namespace"
```

- Found under `ghcr.io/emrahbilaloglu-ui`: run the normal rollback above. No overrides.
- Found only under `ghcr.io/erhanrdn`: the target is pre-transfer. Pin the image repository to the legacy namespace **explicitly** for that one deploy:

```bash
WEB_IMAGE_REPO=ghcr.io/erhanrdn/omniads-web
WORKER_IMAGE_REPO=ghcr.io/erhanrdn/omniads-worker
APP_IMAGE_TAG=<known_good_sha>
APP_BUILD_ID=<known_good_sha>
```

Operator notes:

- Confirm the exact override variable names against `docker-compose.yml` on the release candidate before the cutover. The compose file is the authority for what the deploy actually reads; a name that does not match falls through to the default new-namespace repository and the pull fails with `manifest unknown`.
- Both services must be pinned together. A mixed pair — legacy `web` with new-namespace `worker`, or the reverse — is a split-brain deploy of two different builds.
- Confirm the GHCR credentials used by the deploy can still read packages under the old owner account. The transfer moved the repository; it does not guarantee package read access under `ghcr.io/erhanrdn` for the current token.
- These overrides are for one rollback deploy only. Drop them before the next forward deploy, or that release will be pulled from the legacy namespace where its images do not exist.
- `RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE` in `lib/release-authority/types.ts` is the in-repo record of this namespace. It is intentionally retained, not leftover. Do not "clean it up" while any pre-transfer SHA is still a viable rollback target.

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
