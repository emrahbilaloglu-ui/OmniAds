CHATGPT_REVIEW_READY: YES
ROLE: CODEX_WIP_IMPLEMENTATION
BRANCH: wip/creative-v2-readonly-ui-preview-2026-04-26
SANITIZED: YES
PRODUCT_CODE_CHANGED: YES
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Authenticated Preview Screen Notes

Generated at: 2026-04-26T21:11:23Z

Validation used a local dev server configured for the self-hosted PostgreSQL
database and an authenticated demo workspace session. Connection details,
environment values, raw account names, raw creative names, browser state, and
session values are intentionally omitted.

No screenshots are committed because the preview was validated through sanitized
screen notes and DOM assertions.

## Session Scope

The same authenticated demo workspace was used for a second limited
read-only preview validation.

No queue/apply path was exercised. No platform write path was exercised.

## No-Flag Page Check

Validated URL:

- `/platforms/meta/creatives`

Observed DOM result:

| Check | Result |
| --- | --- |
| Authenticated session | yes |
| Business count | 1 |
| Active business present | yes |
| v1 Creative page visible | yes |
| `[data-testid="creative-v2-preview-surface"]` count | 0 |
| Forbidden button/action language visible | 0 |
| Internal artifact terms visible | 0 |
| App write requests during no-flag page check | 0 |

## With-Flag Page Check

Validated URL:

- `/platforms/meta/creatives?creativeDecisionOsV2Preview=1&creative=SANITIZED`

Observed DOM result:

| Check | Result |
| --- | --- |
| Authenticated session | yes |
| Business count | 1 |
| Active business present | yes |
| v1 Creative page visible | yes |
| `[data-testid="creative-v2-preview-surface"]` count | 1 |
| Today Priority visible | yes |
| Today Priority mentions Scale | yes |
| Today Priority mentions Cut | yes |
| Today Priority mentions Refresh | yes |
| Diagnose section present | yes |
| Diagnose section collapsed by default | yes |
| Inactive Review section present | yes |
| Inactive Review collapsed by default | yes |
| Ready for Buyer Confirmation visible | no |
| Forbidden button/action language visible | 0 |
| Internal artifact terms visible | 0 |
| Safe read-only action buttons visible | 6 |
| App write requests before detail/open interaction | 0 |
| App write requests during v2 detail/open interaction | 0 |

Preview payload summary:

| Check | Result |
| --- | --- |
| Preview endpoint status | 200 |
| Preview row count | 8 |
| Direct actionability row count | 0 |
| Today Priority row count | 3 |
| Ready for Buyer Confirmation row count | 0 |

## Evidence Points

Above the fold showed the separate v2 preview surface while the v1 Creative page
remained present.

Today Priority rendered and surfaced Scale, Cut, and Refresh buyer work.

The authenticated demo snapshot did not contain a direct-actionability row, so
visual proof of review-only Scale and high-spend Cut ranking above direct
Protect or Test More is not available from this workspace. Ordering remains
covered by the live-audit fixture bucket-mapping and sorting tests. This is a
non-blocking observation for limited read-only preview and a tracking item for
merge/product-readiness evidence.

Diagnose rows were grouped under a collapsed `Diagnose First` section.

Inactive rows were grouped under a collapsed `Inactive Review` section.

The rendered preview showed only read-only controls such as opening detail or
diagnosis. No Apply, Queue, Push, Auto, Scale now, Cut now, Approve, or
Product-ready language was visible.

Clicking a safe detail/open control captured zero app write requests from the
v2 preview interaction. A framework development diagnostic request was observed
outside the detail-click interval and was not a product/API/DB/Meta write.

## Sanitization

No raw private account names, creative names, account IDs, session values,
browser state, credential material, DB URLs, screenshots, or environment files
are included.
