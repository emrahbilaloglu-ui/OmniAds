# D084 Correction 5 — authenticated Decision Center UI QA

`layout-authenticated-desktop-1440.json` and `layout-authenticated-mobile-390.json`
are **authenticated-surface** receipts: the real `/platforms/meta` route, the
real signed-in operator session, the real workspace payload, real production
data for IwaStore (`f8a3b5ac-588c-462f-8702-11cd24ff3cd2`,
`act_1087566732415606`). They are not fixtures.

`../d084-budget-evidence/*` remain **static_component_harness** receipts: the
real component and the real stylesheet in a real CSS engine, with a synthetic
view model. They are deterministic component coverage and they do **not**
satisfy the authenticated-surface gate.

## What changed in Correction 5

r5's mobile receipt was `NOT_DETERMINABLE`: `app/globals.css:1588` hides every
sibling of `.meta-mobile-decision-stage` below 720px, and the budget-decision
evidence panel was mounted only inside the desktop subtree, so both direction
panels measured `0x0` at 390px. The panel is now also projected into
`MetaMobileDecisionsScreen` from the same server-owned
`viewModel.budgetEvidence` object, and the mobile receipt is a measured
**PASS**. The desktop receipt was re-measured afterwards and is unchanged.

## The screenshot gap — closed by independent post-correction verification

r5's desktop receipt named
`authenticated-desktop-1440.png`. That file was never written — the reference
was dangling, and nothing in the suite noticed.

Claude's Correction 5 did not hide that gap by inventing a file. Its initial
receipts correctly carried `screenshot: null` and explained the missing
artifact. After Claude finished and released the browser, an independent Codex
verification reused the operator's already signed-in top-level Chrome tab and
persisted four real PNGs without reading/copying cookies, tokens or stored
credentials and without creating a session row:

- `authenticated-desktop-1440.png` — both directions and canonical lineage at
  the exact 1440x900 viewport;
- `authenticated-desktop-1440-cta.png` — both disabled terminal controls;
- `authenticated-mobile-390.png` — the mobile increase/scale projection at the
  exact 390x844 viewport;
- `authenticated-mobile-390-decrease.png` — the separately stacked
  decrease/cut projection at the same viewport.

`scripts/audits/d084-evidence-receipts.test.ts` enforces the rule that actually
failed in r5: **every file a receipt references must exist**, and a persisted
screenshot — primary or supplemental — must publish a matching SHA-256 and
matching pixel dimensions. A receipt that carries no screenshot must say so
and explain why. Re-introducing r5's dangling reference fails that suite.

## Measurement method

The signed-in Chrome tab cannot be resized (`resize_window` is a no-op on it),
so both viewports were measured in a **same-origin iframe** sized to exactly
1440x900 and 390x844 inside that tab, which keeps the session intact and gives
a real layout at a real viewport.

## Request audit

Both receipts carry a sanitized audit grouped by method, URL class, response
status and count: 67 requests, all `GET`, zero mutating application or provider
requests. URL classes are origin-relative pathnames only — every query string,
header, cookie and token is stripped before recording, so no credential or
secret value is stored here.
