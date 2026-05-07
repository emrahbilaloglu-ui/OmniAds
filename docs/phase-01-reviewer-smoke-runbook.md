# Phase 01 Reviewer Smoke Runbook

## Purpose

This runbook defines the trusted smoke path for Phase 01. It is intentionally browser-based and uses a seeded reviewer account that signs in through `/login`.

## Preconditions

- app dependencies installed
- Chromium installed for Playwright
- `DATABASE_URL` available to the seed script
- target environment reachable

Optional but recommended:

- `SHOPIFY_REVIEWER_PASSWORD`
  - keeps reviewer credentials stable across repeated smoke runs
- `SHOPIFY_REVIEWER_EMAIL`
- `SHOPIFY_REVIEWER_NAME`
- `NEXT_PUBLIC_APP_URL`
  - only needed when you want the seed script to print an environment-specific login URL

## Reviewer seed behavior

Command:

```bash
node scripts/seed-reviewer-account.mjs
```

Output:

- one JSON object
- reviewer email
- reviewer password
- `passwordSource`:
  - `env`
  - `generated_runtime`

Rules:

- no hardcoded reviewer password lives in the repo
- a generated runtime password is valid only for the current run and is overwritten on the next seed
- the Playwright auth setup consumes this JSON directly and does not rely on committed secrets

## Local smoke

Install the browser once:

```bash
npm run playwright:install
```

Run the local smoke flow:

```bash
npm run test:smoke:local
```

What this does:

1. builds the app
2. starts the local production server on `http://127.0.0.1:3000`
3. seeds the reviewer account
4. signs in through `/login`
5. stores auth state in `playwright/.auth/reviewer.json`
6. runs the reviewer smoke suite

## Live smoke

Run against production:

```bash
npm run test:smoke:live
```

This keeps `PLAYWRIGHT_USE_WEBSERVER=0` and targets:

- `PLAYWRIGHT_BASE_URL=https://adsecute.com`

## Smoke scenario contract

The Phase 01 smoke suite must verify all of the following:

1. reviewer account can sign in through `/login`
2. `/platforms/meta` loads
3. Meta recommendations panel is visible with deterministic wording
4. at least one campaign can be selected
5. campaign detail and ad set drilldown render
6. `/platforms/meta/creatives` loads
7. `Decision Signals` controls render
8. at least one creative row can be opened
9. deterministic decision section renders in the detail view
10. commentary section renders with either AI output or explicit fallback

## Generated artifacts

The smoke suite must leave behind:

- `playwright/.auth/reviewer.json`
- `playwright-report/`
- `test-results/`
- screenshots such as:
  - `meta-smoke.png`
  - `creatives-smoke.png`

These directories are intentionally gitignored.

## Manual fallback

If Playwright fails but the environment is otherwise healthy, reproduce manually:

1. run `node scripts/seed-reviewer-account.mjs`
2. open `/login`
3. sign in with the emitted reviewer credentials
4. visit `/platforms/meta`
5. confirm `Recommendations`, campaign detail, and ad set drilldown
6. visit `/platforms/meta/creatives`
7. confirm `Decision Signals`
8. open one creative
9. confirm deterministic decision block
10. request commentary and confirm either AI or fallback output

Manual validation does not replace the automated smoke suite for release signoff. It is only a debugging fallback.
