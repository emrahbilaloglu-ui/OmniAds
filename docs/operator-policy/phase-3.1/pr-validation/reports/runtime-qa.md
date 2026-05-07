# Phase 3.1 PR Validation Runtime QA

Date: 2026-04-22
Repo: `/Users/harmelek/Adsecute`
Scope: runtime validation for the Phase 3.1 Meta and Creative decision-range firewall, with browser smoke attempted first and API/unit smoke used as fallback where runtime auth/data was blocked.

## Summary

- Browser runtime smoke could not complete in this workspace.
- Local Postgres was not available because the `adsecuteDB` volume is not mounted at `/Volumes/adsecuteDB`.
- The Playwright auth setup jobs then failed with `ECONNREFUSED 127.0.0.1:15432` while seeding reviewer and commercial smoke accounts.
- Fallback API/unit smoke passed for the Meta and Creative decision-contract surfaces.

## Browser Runtime Attempt

Attempted command:

```bash
PLAYWRIGHT_USE_WEBSERVER=1 PLAYWRIGHT_REUSE_EXISTING_SERVER=0 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test playwright/tests/commercial-truth-smoke.spec.ts playwright/tests/reviewer-smoke.spec.ts --project=setup --project=commercial-setup --project=smoke-chromium --project=commercial-smoke-chromium
```

Result:

- `playwright/tests/commercial-auth.setup.ts` failed while running `scripts/seed-commercial-smoke-operator.mjs`
- `playwright/tests/auth.setup.ts` failed while running `scripts/seed-reviewer-account.mjs`
- Both failures were caused by `connect ECONNREFUSED 127.0.0.1:15432`

Preflight check:

```bash
npm run local:db:ensure
```

Result:

- reported that the `adsecuteDB` disk is not mounted
- asked for the volume to be mounted under `/Volumes/adsecuteDB`

Conclusion:

- Browser screenshots for `/platforms/meta` and `/platforms/meta/creatives` were not obtainable in this run because the local database bootstrap blocked auth setup before page validation could start.

## API And Unit Smoke

Ran:

```bash
npm test -- 'components/meta/meta-analysis-status-card.test.tsx' 'components/meta/meta-decision-os.test.tsx' 'app/(dashboard)/platforms/meta/page.test.tsx' 'lib/meta/decision-os.test.ts' 'app/api/meta/decision-os/route.test.ts' 'components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx' 'components/platforms/meta/creatives/CreativeDecisionOsDrawer.test.tsx' 'app/(dashboard)/platforms/meta/platforms/meta/creatives/page-support.test.ts' 'lib/creative-decision-os.test.ts' 'app/api/creatives/decision-os/route.test.ts'
```

Result:

- `10` test files passed
- `63` tests passed

What this covered:

- Meta Analysis Status rendering, including the non-ready state
- Meta Decision OS page and route contract behavior
- Meta decision fingerprint stability when only analytics range changes
- Creative Decision OS overview and drawer rendering
- Creative decision fingerprint stability when only reporting range changes
- Creative route contract behavior for `decisionAsOf` wiring and reporting-range stability

Not observed in the blocked browser run:

- A live screenshot pass for `/platforms/meta` and `/platforms/meta/creatives`
- A direct browser-level check that changing `decisionAsOf` alters the rendered decisions

## Sanitization

- No tokens, cookies, raw ad account IDs, or sensitive business IDs are included in this report.
- The browser failure details are limited to the local Postgres host/port and the mounted-volume requirement.

## Outcome

- Runtime browser smoke: blocked by missing local database volume and unavailable PostgreSQL listener, so the UI scenarios could not be exercised end to end.
- API/unit smoke: passed.
- App code: not modified.
