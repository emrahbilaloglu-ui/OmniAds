# UI/UX Reduction Audit Report

## 1. Current truth snapshot

* repo `main` top commit: `ce4d7d2 step11: refresh closure docs after push`
* `https://adsecute.com/api/build-info`: `buildId=0dbd9cff0b1dc383e06537ebdc1068db76b9686a`, `nodeEnv=production`
* `https://adsecute.com/api/release-authority`: `currentLiveSha=0dbd9cff0b1dc383e06537ebdc1068db76b9686a`, `currentMainSha=ce4d7d251e28b24a6cde109f029d12a5ed9ba973`, `liveVsMain.status=drifted`, `docsVsRuntime.status=aligned`, `flagsVsRuntime.status=aligned`, `overall.status=drifted`
* SHA drift note: current drift reads as contextual, not meaningfully product-facing in this audit. The latest `main` commit only refreshed closure/staging docs, so live-vs-main mismatch alone is not evidence of a release-authority or product regression.

## 2. Accepted baseline that must remain untouched

* Step 5 through Step 11 accepted baseline remains in force.
* Meta keeps the operator-first hierarchy defined in `docs/meta-page-ui-contract.md`: status and scope controls, Meta Decision OS, KPI row, campaign drilldown, then collapsed supporting context.
* Creative keeps preview-truth gating. Authoritative action language remains gated by preview readiness.
* Creative deterministic decision remains primary in detail review.
* AI remains support-only and must not rewrite deterministic decisions.
* Creative Decision OS remains a support-framed drawer. The page worklist stays primary.
* Accepted operator wording already protected by smoke coverage must remain stable unless tests are deliberately updated in the same accepted implementation step.
* Selected-campaign URL continuity on Meta and current drawer/deep-link behavior on Creative must remain intact.
* Temporary proof path stays closed permanently.
* No deploy/auth/commercial-truth logic changes, no release-authority redesign, no reopening Step 5-11 debates.

## 3. Meta page: concrete friction points

* First-view entry is still too tall and too card-heavy before the working surface starts. Header controls, status banner, full Meta Decision OS summary, and the full KPI row all stack ahead of the campaign drilldown split. The order is correct, but the page still feels crowded before the operator reaches list/detail work. `app/(dashboard)/platforms/meta/page.tsx:1096-1275`, `components/meta/meta-decision-os.tsx:541-688`
* KPI cards still compete with the primary operator surface. The four large accent cards with bold values and change percentages read like a second headline layer instead of quiet context. `app/(dashboard)/platforms/meta/page.tsx:1191-1275`
* The page-to-list-to-detail scan path is fragmented. Meta Decision OS is a full-width summary surface, KPIs are another full-width surface, then the campaign list and detail live in a separate boxed split layout. There is no direct visual bridge from the summary surface into the selected campaign state. `components/operator/OperatorSurfaceSummary.tsx:146-208`, `app/(dashboard)/platforms/meta/page.tsx:1332-1374`
* Selected-state continuity is only partial. `campaignId` URL syncing and list-row selection are good, but the default detail state is `Account Overview`, not the next campaign to review, so landing in the drilldown zone still opens a generic secondary pane. `app/(dashboard)/platforms/meta/page.tsx:593-596`, `components/meta/meta-campaign-list.tsx:136-155`, `components/meta/meta-campaign-detail.tsx:548-569`
* Supporting context is semantically secondary but still visually heavy when opened. Operating Mode, Command Center, recommendations, and breakdowns all sit at near-equal card weight inside the detail pane, so the support layer can feel like a second workspace. `components/meta/meta-campaign-detail.tsx:463-509`, `666-676`
* The campaign list is dense for its width. Status dot, name, objective, lane marker, primary action pill, authority pill, owner/regime line, blocker line, ROAS, and spend all compete inside a fixed-width sidebar item. `components/meta/meta-campaign-list.tsx:166-257`
* The selected campaign detail is also dense. The five-column metric row and the three-zone ad set rows assume a wide layout and are likely to squeeze badly on smaller screens. `components/meta/meta-campaign-detail.tsx:303-438`, `645-664`
* Narrow-screen behavior is weak. The main drilldown uses a hard two-column `flex` layout with a fixed `w-72` / `xl:w-80` list rail and no explicit stacked fallback. `app/(dashboard)/platforms/meta/page.tsx:1332-1374`
* CTA hierarchy is noisy. `Refresh data`, `Show why`, `Show campaign reasoning`, `Workflow and context`, `Refresh Context`, and Command Center links all remain visible across nearby surfaces, so the accepted operator-first hierarchy is not as calm as it should be. `app/(dashboard)/platforms/meta/page.tsx:1123-1159`, `components/meta/meta-decision-os.tsx:545-688`, `components/meta/meta-campaign-detail.tsx:632-676`, `components/meta/meta-account-recs.tsx:211-247`
* Loading and degraded states are semantically handled, but visually fragmented. Decision OS, KPI, campaigns, and breakdown/detail surfaces can all resolve separately, which produces multiple stacked placeholders before the page stabilizes. `app/(dashboard)/platforms/meta/page.tsx:1185-1297`, `components/meta/meta-decision-os.tsx:513-523`

## 4. Creative page: concrete friction points

* First-view entry is overloaded. The user hits title plus preset toggle, then a filter/action bar, then the Preview Truth Contract, then an OperatorSurfaceSummary, then the selected-creatives workspace, then a second control row above the table. That is too many high-attention surfaces before the first row. `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:703-939`, `components/platforms/meta/creatives/CreativesTopSection.tsx:565-783`, `components/platforms/meta/creatives/CreativesTableSection.tsx:989-1235`
* Preview-truth messaging is repeated across adjacent surfaces. The same core rule appears in the page-level contract, selected preview strip, Decision Support drawer overview, and detail drawer gate. The semantics are accepted and correct, but the repetition adds vertical cost and perceived clutter. `components/platforms/meta/creatives/CreativesTopSection.tsx:609-717`, `1473-1493`, `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx:262-299`, `components/platforms/meta/creatives/CreativeDetailExperience.tsx:661-700`
* Decision Support is correctly support-framed, but the page already has an operator summary and quick-filter board before the drawer is opened. The top-bar `Decision support` CTA makes the first view feel like it has multiple top-level decision dashboards. `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:843-877`, `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx:131-200`
* The selected-workspace toolbar contains misleading or redundant chrome. The workspace layout/settings/more buttons have no behavior, and the `+ AI tags` chip in the metric selector also has no action. That is visual noise with no operator payoff. `components/platforms/meta/creatives/CreativesTopSection.tsx:745-766`, `1261-1274`
* Table controls duplicate top-surface controls. Preset selection, table settings, AI tags, add metric, and metric visibility all reappear above or inside the table after similar controls already exist in the top section. `components/platforms/meta/creatives/CreativesTableSection.tsx:989-1235`, `1459-1518`
* Selected-item continuity is weaker than it should be. The page auto-selects the first five rows for the preview workspace, but opening a creative detail drawer does not create a persistent active-row state in the table. The source row can disappear in the scroll field. `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:452-470`, `555-576`, `components/platforms/meta/creatives/CreativesTableSection.tsx:1728-1814`
* The first table column is overloaded. Checkbox, preview, operator pills, reason line, blocker/metrics, and `Ad breakdown` link all live in one sticky cell, which slows scan speed even when the data is correct. `components/platforms/meta/creatives/CreativesTableSection.tsx:1734-1814`
* The detail experience is semantically correct but visually busy. Preview Truth Gate, deterministic decision, Command Center, commercial context, AI commentary, deterministic evidence, and notes all share similar card weight inside a narrow right rail. `components/platforms/meta/creatives/CreativeDetailExperience.tsx:659-1138`
* The Decision Support drawer is support-only by copy, but it is still a very dense support surface with multiple large grids and boards. This is acceptable for a deep review surface, but visually heavy. `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx:158-705`, `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx:131-200`
* Narrow-screen pressure is high. The page already depends on a wide table, the detail experience expects a large two-column overlay on desktop, and the support drawer has a minimum width of `920px`. `components/platforms/meta/creatives/CreativesTableSection.tsx:1238-1613`, `components/platforms/meta/creatives/CreativeDetailExperience.tsx:572-580`, `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx:14-22`

## 5. Cross-page patterns causing clutter

* Too many bordered, shadowed cards use similar visual weight even when surfaces are explicitly secondary or support-only.
* Both pages stack several full-width explanatory surfaces before the primary worklist.
* Readiness, authority, and preview language is repeated across nearby panels instead of being visually concentrated.
* Controls are duplicated across header, workspace, table, and drawer/detail surfaces.
* Selected-source continuity is weaker than it should be once a detail surface opens.
* Dense chip stacks and microcopy are packed into narrow rails or sticky first columns.
* Responsive behavior still assumes wide desktop layouts more than calm narrow-screen fallbacks.

## 6. Recommended phased execution model

### Pass 1

* Goal: reduce first-view crowding and make the primary worklist easier to reach without changing accepted semantics.
* Target files: `components/operator/OperatorSurfaceSummary.tsx`, `app/(dashboard)/platforms/meta/page.tsx`, `components/meta/meta-campaign-list.tsx`, `components/meta/meta-campaign-detail.tsx`, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`, `components/platforms/meta/creatives/CreativesTopSection.tsx`, `components/platforms/meta/creatives/CreativesTableSection.tsx`
* What should change: compress spacing and chrome in the Meta and Creative entry bands; visually demote KPI, legend, and auxiliary control weight; quiet support containers; remove or hide no-op Creative toolbar controls; add a visible active-row cue for the Creative detail drawer.
* What must not change: Meta top-level order from the contract; Preview Truth Contract wording and gating; drawer support wording; AI support-only wording; `campaignId` and `creative` URL behavior; accepted smoke selectors and core labels.
* Why this pass order is low-risk and high-impact: it is mostly layout, emphasis, and state-visibility work on existing surfaces. It avoids data logic, authority logic, and accepted wording changes while producing an immediate “less crowded on first look” gain.

### Pass 2

* Goal: strengthen page-to-selection-to-detail continuity once the entry shell is calmer.
* Target files: `components/meta/meta-decision-os.tsx`, `components/meta/meta-campaign-list.tsx`, `components/meta/meta-campaign-detail.tsx`, `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx`, `components/platforms/meta/creatives/CreativeDetailExperience.tsx`, `components/operator/OperatorSurfaceSummary.tsx`
* What should change: make summary surfaces relate more clearly to current selection or active filters; reweight Creative detail so deterministic decision clearly leads support panels; reduce unnecessary repetition where a neighboring surface already carries the same truth.
* What must not change: Meta operator-first hierarchy; Creative preview-truth gating; Decision Support drawer staying support-only; historical analysis staying descriptive rather than decision-authoritative.
* Why this pass order is low-risk and high-impact: it improves continuity after Pass 1 has already lowered noise. It is more interaction-sensitive than Pass 1, but still stays inside accepted semantics.

### Pass 3

* Goal: resolve remaining density and responsive issues in the deepest surfaces.
* Target files: `app/(dashboard)/platforms/meta/page.tsx`, `components/meta/meta-campaign-detail.tsx`, `components/platforms/meta/creatives/CreativesTableSection.tsx`, `components/platforms/meta/creatives/CreativeDetailExperience.tsx`, `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx`
* What should change: introduce better narrow-screen fallbacks for Meta master-detail; simplify dense drilldown rows; refine Creative table and drawer behavior for smaller viewports; reduce side-rail overload in detail review.
* What must not change: accepted operator semantics, preview-truth gating, drawer support framing, URL continuity, or review-flow contracts.
* Why this pass order is low-risk and high-impact: responsive and deep-density changes touch more layout branches, scroll behavior, and edge states. They should come after hierarchy and continuity are already stable.

## 7. Pass 1 candidate scope

* Files to edit: `components/operator/OperatorSurfaceSummary.tsx`, `app/(dashboard)/platforms/meta/page.tsx`, `components/meta/meta-campaign-list.tsx`, `components/meta/meta-campaign-detail.tsx`, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`, `components/platforms/meta/creatives/CreativesTopSection.tsx`, `components/platforms/meta/creatives/CreativesTableSection.tsx`
* UI problems being solved: too many high-attention bands before the main worklist; support surfaces reading too loud; duplicate or inert Creative toolbar chrome; weak Creative active-row continuity once detail opens.
* Protected invariants: no API/store/query changes; no Decision OS logic changes; no preview-truth logic changes; no AI framing changes; no drawer-role changes; no release-authority/auth/commercial-truth logic changes; no selector or wording drift on smoke-protected surfaces unless tests are intentionally updated in the same approved step.
* Acceptance criteria: Meta still renders in the same contract order, but the first viewport is visibly calmer and drilldown begins sooner; Creative still renders Preview Truth Contract, quick filters, Decision Support drawer, and deterministic detail review, but the first viewport reaches the table faster; Creative detail drawer has a clear source-row cue in the table; the Decision Support drawer remains support-framed; no accepted support-only or preview-gating wording is broken.
* Likely smoke/test surfaces affected: `playwright/tests/reviewer-smoke.spec.ts`, `playwright/tests/commercial-truth-smoke.spec.ts`, `components/meta/meta-campaign-list.test.tsx`, `components/platforms/meta/creatives/CreativeDetailExperience.test.tsx`, `components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx`, `components/platforms/meta/creatives/CreativeDecisionOsDrawer.test.tsx`

## 8. Risks and guardrails

* If Meta entry compression is too aggressive, KPI or supporting context can accidentally overtake the Decision OS surface visually or break the documented order.
* If Creative preview-truth copy is shortened, relocated, or renamed carelessly, accepted gating semantics and existing smoke assertions will break.
* If drawer labels, button names, or `data-testid` values drift, reviewer and commercial smoke coverage will fail even if the layout looks better.
* If Creative active-row continuity is implemented by reusing checkbox-selection state, it can accidentally mutate the selected preview workspace instead of only indicating the open detail source row.
* If responsive cleanup changes scroll containers or sticky regions carelessly, list/detail continuity and drawer behavior can regress.

## 9. Recommended next prompt for implementation phase

Implement **Pass 1 only** from `docs/ui-ux-reduction/LATEST_REPORT.md`.

Scope:
* Edit only the Pass 1 files listed in the report.
* Reduce first-view clutter on Meta and Creative.
* Make the primary worklist easier to reach on first load.
* Add a clear active-row state for the open Creative detail drawer.
* Remove or visually demote redundant or no-op chrome where possible.

Do not change:
* Step 5-11 accepted semantics.
* Meta operator-first ordering.
* Creative preview-truth gating.
* AI support-only framing.
* Decision Support drawer support framing.
* URL/deep-link behavior for `campaignId` or `creative`.
* deploy/auth/commercial-truth/release-authority logic.

Acceptance:
* Meta still presents status/controls, Decision OS, KPI row, drilldown, then supporting context in that order.
* Creative still presents the Preview Truth Contract, quick filters, Decision Support drawer, and deterministic detail review.
* Reviewer/commercial smoke-protected wording and selectors remain intact.
* No implementation expands product scope beyond visual hierarchy cleanup and selected-item continuity for Pass 1.
