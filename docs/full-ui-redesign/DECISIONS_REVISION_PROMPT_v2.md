# Decisions Page — Claude Design Revision Prompt (v2: master-detail evaluation)

Updated 2026-07-08 after a 7-persona media-buyer panel stress-tested the owner's master-detail proposal (left=campaigns/adsets, right=creatives-by-selection). Verdict: 7/7 risky as the DEFAULT — adopt the business-column deletion, but keep creatives first-class and make master-detail an opt-in mode.

## Panel assessment
The proposal is half-right and half-wrong, and the panel was unanimous (7/7 "risky") about which half is which. RIGHT: deleting the reference design's "BUSINESSES · BY URGENCY" left column is unambiguously correct — one business is already selected globally, so that column is dead pixels implying a multi-business triage that does not exist here. Adopt it outright. WRONG (as the default): promoting campaign/ad-set to the master spine and gating every creative behind a left-pane selection. That mechanism quietly rolls back three decisions this same panel already converged on — the campaign→adset→creative TREE over the Campaigns-XOR-Adsets radio, creatives as a first-class account-wide lifecycle lens, and the temporal money-at-stake default — and it breaks two honesty laws at once: it hides the most actionable entity class (a $4k fatiguing creative in a calm-ranked campaign never surfaces until you happen to click its parent = silent hiding), and it lands on a blank right pane (weather, not work). It also shatters the product's core object: a creative that runs across N ad sets (placementList[]/BriefingRollupItem, adset_count) gets re-fragmented into per-parent slivers, so its true total spend and single lifecycle verdict become unviewable — fatal for the ASC/broad buyers for whom the creative IS the account. And it orphans anomalies, non-sales/funnel findings, and brand-safety escalations, which belong to no selected campaign. The non-negotiable conditions: creative-first must be a co-equal default reachable with zero clicks; one global money-ranked, temporally-ordered queue spanning all grains stays on load; the left is the real expandable tree (ASC expands straight to creatives, no phantom ad-set node); anomalies/non-sales/brand-safety get an explicit unparented home that escalates; creatives stay asset-deduped across parents; and evidence gets its own surface so it never fights the creative list. Resolution: adopt the business-column deletion, and reshape master-detail from THE model into an opt-in structure mode layered on a three-zone default (tree navigator / cross-grain findings spine / evidence drawer). Selecting a left node FILTERS the spine in place; it never becomes the only door to a creative.

## Resolved information architecture
Three zones on one page, with a hard rule that selection filters and never gates.

LEFT — STRUCTURE NAVIGATOR (replaces the businesses column). A narrow, expandable campaign→ad set→creative TREE ranked by de-duplicated money-at-stake, with each parent rolled up (child count + summed money-at-stake counted once + worst-child verdict). CBO/ASC ad sets collapsed by default; ASC campaigns expand straight to creatives with an explicit "no ad-set tier" note (never a phantom node). It is a NAVIGATOR/FILTER, not a queue: clicking a node scopes the center; clearing selection returns to full-account. Keyboard j/k navigable.

CENTER — THE SPINE (the default landing, never blank). One money-ranked, temporally-ordered ("what changed since last session" on by default) cross-grain FINDINGS queue that always carries anomalies + campaigns + ad sets + creatives + non-sales together, top-N bounded, brand-safety escalated above money rank, Learning/Stabilizing auto-deferred into a defer band. Creatives are first-class here: a count-chip flips the SAME pane into the creative-first lifecycle lens (Winners/Fatigue/Testing/Diagnose), asset-deduped account-wide (one row per asset = combined spend/stake across N ad sets, expand to per-placement), sortable/exportable. A left selection filters this spine to that subtree in place — it does not spawn a separate list and never removes a creative from reachability; hidden rows always leave a suppression-ledger receipt (+N / +$X, reveal). Every row shows its own money-at-stake so a creative call and an ad-set call are comparable on one axis.

RIGHT — EVIDENCE DRAWER. Click any row (any grain, including an anomaly) → the read-first evidence inspector (why / confidence / recommended action) opens as an overlay/drawer so it never competes with the creative list for real estate. For a creative cut it shows evidence + the asset together.

DEFAULT STATE BEFORE ANY SELECTION: the center spine is fully populated with the top money-at-stake, changed-since-last-session findings across all grains, brand-safety pinned on top, anomalies present unparented — zero clicks to see the fires.

CREATIVE-FIRST FOCUS MODE: the count-chip lens is a co-equal default, not a detail-of-campaign. Left selection is an optional scope on top of it, never a prerequisite.

ANOMALIES / NON-SALES / BRAND-SAFETY: a pinned, always-present home in the spine that surfaces with no selection and escalates; non-sales ships expanded; brand-safety outranks dollars; account-level tracking/pixel anomalies still gate globally.

CALM AT SCALE: every surface (center spine AND the optional right-pane creative list of the structure mode) is bounded top-N + lifecycle-grouped + asset-deduped, so "one ASC campaign = hundreds of creatives" never relocates the endless scroll — it stays bucketed with a "show all N" receipt.

THE USER'S MASTER-DETAIL: preserved as an opt-in "Structure / Investigate this campaign" saved-view mode you drop into from the queue (left tree + right = the selected entity's OWN evidence first, its rolled-up deduped creatives beneath) — an accelerator for Gear-2 investigation, never the landing state and never the only path to a creative.

---

# THE UPDATED REVISION PROMPT (hand this to Claude Design)

REVISION PROMPT — Adsecute "Meta · Decision Center" (Decisions surface)

CONTEXT YOU ARE REVISING
This is a read-first operator console for a single Meta ad account, with one business already selected at the top of the app. An engine grades every campaign, ad set, and creative each snapshot and surfaces what needs action, ranked by money-at-stake. Writes happen elsewhere; a row here opens an EVIDENCE inspector (why / confidence / recommended action). The current build is too crowded: three stacked context bands (Pulse/Digest/Readiness) before row 1, a ~10-control toolbar, six lane tabs, and an "Action Now" list that concatenates anomalies + campaigns/adsets + creatives into one endless flat scroll with creatives dumped last. A prior revision converged on "two layers, one page" (a calm, bounded, temporally-filtered default sitting on a sortable/exportable grid). This revision folds in one correct simplification and one corrected navigation model.

DESIGN LANGUAGE TO PRESERVE (do not restyle)
Dense-but-clean IBM Plex operator console. Warm-neutral --adc tokens, semantic status colors + purple --auto for the engine voice. Mono numerics. Flat (no cards-on-cards, no drop shadows as chrome). 13px base. Calm, instrument-panel feel — density is fine when it is organized.

HONESTY LAWS (hard constraints, never violate)
- Missing != zero. A metric with no data reads as "—" or "no data", never 0.
- No fabricated data and no fake cross-engine rank. If two engines can't be ranked against each other, don't invent one number.
- Nothing silently hidden — a hidden row is worse than a dense one. Any filter, selection, roll-up, or below-the-fold truncation leaves a suppression-ledger receipt: "+N rows · +$X at stake · reveal".
- Evidence-first: every finding is one click from its why/confidence/recommended-action.

CHANGE 1 — DELETE THE BUSINESSES COLUMN (adopt fully)
The reference design's left "BUSINESSES · BY URGENCY" column is redundant here: one business is already selected globally, so a second business dimension is dead weight implying a triage that does not exist. Remove it and reclaim the space for structure (Change 2). Do not spend the reclaimed space re-introducing hierarchy-first navigation.

CHANGE 2 — THREE-ZONE LAYOUT (this is the corrected model; the owner's "master-detail" becomes a mode, not the default)
Reshape the page into three zones. The governing rule: SELECTION FILTERS, IT NEVER GATES. Nothing — least of all a creative — may be reachable only by first clicking a parent.

ZONE A — LEFT: STRUCTURE NAVIGATOR (the reclaimed column)
- An expandable campaign → ad set → creative TREE. This replaces the deleted businesses column and the old Campaigns-XOR-Adsets radio.
- Ranked by de-duplicated money-at-stake. Each parent rolls up: child count, summed money-at-stake (counted ONCE — a campaign's stake already includes its ad sets'; never double-count correlated dollars across levels), and worst-child verdict.
- This is NOT a flat interleaved "campaigns AND ad sets" list. Parent-child stays intact; an ad set never floats as an orphan sibling next to an unrelated campaign.
- CBO/ASC ad sets collapsed by default. ASC/Advantage+ campaigns expand STRAIGHT to creatives with an explicit "no ad-set tier" note — never a phantom middle node, never a faked layer.
- The tree is a NAVIGATOR/FILTER. Clicking a node scopes Zone B to that subtree in place. Clearing the selection returns Zone B to full-account. Keyboard j/k moves through nodes; Zone B repaints. Show the driving grain on each parent (which child drove its rank) so roll-ups never mask the real culprit.

ZONE B — CENTER: THE SPINE (the default landing surface; NEVER blank on load)
- One money-ranked, cross-grain FINDINGS queue that ALWAYS carries all entity classes together: anomalies + campaigns + ad sets + creatives + non-sales. Bounded to top-N; the rest sits behind a suppression-ledger receipt.
- Default ordering is TEMPORAL: "what changed since last session" is on by default (a stable account re-presents only its deltas, not all 300 rows). Money-at-stake is the ranking metric within that.
- Brand-safety / policy escalates ABOVE money rank (it fires regardless of dollars). Learning/Stabilizing delivery-state rows AUTO-DEFER into a quiet defer band and do not shout money-at-stake in either zone.
- Every row shows its own money-at-stake figure so a creative call and an ad-set call are directly comparable on ONE axis.
- CREATIVES ARE FIRST-CLASS HERE. A count-chip flips the SAME pane into the creative-first LIFECYCLE LENS (Winners / Fatigue / Testing / Diagnose) — focus-in-place, never routing out to another page. This lens is a CO-EQUAL DEFAULT, not a detail-of-a-campaign. In it:
  - Creatives are ASSET-DEDUPED ACROSS PARENTS: one creative asset = ONE row with COMBINED spend / money-at-stake across all N ad sets it runs in (adset_count / placementList[]), expandable to per-placement. Never render per-ad-set slivers; a concept running in 6 ad sets is one row showing its true total and single lifecycle verdict.
  - Sortable by money-at-stake AND fatigue slope across the whole population; multi-sort (shift-click secondary key) and CSV export operate over the full population, not within one parent.
- A LEFT SELECTION FILTERS this spine to that subtree in place — it narrows the same substrate; it does NOT spawn a separate detail list, and it does NOT re-fragment a deduped asset. Any creative the selection removes from view is counted and revealable via the receipt — never gated invisibly behind a click. A high-stake creative in a calm-ranked campaign must still appear in the default (unselected) spine on its own stake.

ZONE C — RIGHT: EVIDENCE DRAWER
- Click any row at any grain — campaign, ad set, creative, OR an account-level anomaly — and the read-first EVIDENCE inspector (why / confidence / recommended action) opens as an overlay/drawer.
- It has its OWN surface so it never competes with the creative list for real estate. For a creative cut, show the evidence AND the asset together. This resolves the evidence-vs-creatives collision: evidence is always the drawer, the creative population is always Zone B.

FIRST-CLASS HOME FOR NON-CREATIVE / ACCOUNT-LEVEL FINDINGS (do not orphan)
- Anomalies (tracking/pixel/CAPI break, spend spike), non-sales/funnel-role findings (awareness/traffic/retention), and brand-safety/policy escalations belong to no selected campaign. Give them a pinned, always-present presence in the spine that surfaces with NO selection.
- Non-sales ships EXPANDED (it has no creative-ROAS story and must not be collapsed away). Brand-safety escalates to the top. Account-level tracking anomalies still gate the page globally. None of these may ever require selecting a parent to be seen.

CALM AT SCALE (do not just relocate the scroll)
- The stated problem is "hundreds of creatives." Every creative surface — the Zone B lens AND the optional Structure-mode right pane below — must be bounded top-N by money-at-stake, grouped by the lifecycle lens (Winners/Fatigue/Testing/Diagnose), and asset-deduped. Selecting one fat ASC/CBO campaign must NOT dump an unbounded raw list; it stays bucketed with an explicit "show all N" receipt. Default the right-pane creatives to FLAGGED/actionable only, with the healthy ones counted behind a receipt.
- Collapse the three context bands into a single one-line MORNING BRIEF above the spine (what changed / biggest fire / delivery-health), not three stacked bands. Reduce the toolbar to the few controls that earn their place (temporal window, sort, export, saved view); everything else moves into the tree or the lens.

THE OWNER'S MASTER-DETAIL — KEEP IT AS AN OPT-IN MODE
- Preserve the owner's instinct as an opt-in "Structure / Investigate this campaign" saved view reached FROM the queue, not as the landing state. In it, the layout splits to: left = the tree (context), right = the selected entity's OWN evidence FIRST (its why/confidence/recommended action), with its rolled-up, deduped, top-N creatives as a section BENEATH the evidence (never creatives instead of the entity's own finding).
- This mode is an accelerator for deep single-campaign work ("Gear 2"). It must never be the only path to a creative, must never fragment a deduped asset, and must persist a visible "back to full-account triage" state so no one is ever forced to click before they see what's bleeding.

EMPTY / EDGE STATES (missing != zero)
- An empty detail or filtered view states its reason: "No flagged creatives for this entity" or "Not applicable (non-sales objective)" — never a blank pane that looks broken.
- ASC with no ad sets: state the tier is absent; expand to creatives directly.
- A deferred (Learning) parent must not strand its flagged children off-screen without a receipt — suppression receipts work per-zone.

ACCEPTANCE CHECKS (the revision passes only if all hold)
1. On load, with no selection, the center spine shows the top money-at-stake, changed-since-last-session findings across ALL grains, brand-safety pinned, anomalies present — zero clicks, right side quiet.
2. Every fatiguing/high-stake creative in the account is reachable WITHOUT selecting a parent, as one asset-deduped row, via the lifecycle lens.
3. A left-tree selection filters the spine in place and leaves a suppression receipt for anything it removes; it never spawns a fragmented per-parent creative list.
4. Anomalies, non-sales, and brand-safety are visible with no selection and escalate correctly.
5. Evidence always opens in its own drawer at any grain and never displaces the creative population.
6. ASC campaigns expand straight to creatives with an honest "no ad-set tier" note; money-at-stake is never double-counted across levels.
7. No creative surface is an unbounded raw scroll — all are top-N, lifecycle-grouped, deduped, with "show all N".
8. Design language (IBM Plex, --adc warm-neutrals, semantic + --auto purple, mono numerics, flat, 13px) and all four honesty laws are intact.

---

# ADDENDUM (v3) — LAYOUT & DENSITY (append to the prompt)

Added 2026-07-08 after a 4-persona layout panel (4/4 columnar data table) diagnosed the rendered spine: full-width flex rows with margin-left:auto created a dead wide-screen middle + floated money-at-stake off-axis + grew only vertically.

## Panel assessment
The owner is right on all three symptoms — wide-screen dead middle, downward-only growth, and clutter — and right to refuse the consumer card look, but "a different design with a proper layout" is under-specified and reads dangerously as either cards or default master-detail, both of which prior panels already vetoed; so the verdict is agree-and-sharpen, not rebuild. The winning layout is a columnar data table (unanimous 4/4), which is not a new design but the sortable grid the v2 spec already signed off and the render quietly regressed away from: the rendered row is a `flex` with the name at `flex:1` and every number in one `margin-left:auto; justify-content:flex-end` child, and that `margin-left:auto` IS the dead center while `flex-end` re-floats money-at-stake to a different x on every row, killing the one scannable ranked axis the whole spine was promised on. Replacing the flex void with an explicit `grid-template-columns` rack fixes wide-screen whitespace by spending the center on real right-aligned mono comparison columns (spend, ROAS-to-window, CPA, money-at-stake, Δ-since-session, delivery-state, confidence, verdict) capped at a readable measure so it never smears on a 2560 monitor — the three-zone frame's tree and drawer absorb the flanks — and fixes vertical sprawl by collapsing each two-line 46px band into one ~30px line (the muted "video 9:16 · 2 ad sets" prose becomes cells, the 46px thumbnail shrinks to a fixed ~24px in-cell swatch that no longer drives row height), so the same 11 findings that eat ~900px fit in roughly one viewport. Explicitly reject the card/tile grid: it re-creates the dead middle at card scale, scatters money-at-stake into a masonry with no shared vertical axis, burns MORE vertical space per item via card chrome, flattens cross-grain weight, and slides straight into the vetoed consumer dashboard — the horizontal space gets filled with columns, never with more items per row. Nothing about the three-zone frame, deduped first-class creatives, evidence drawer, or honesty laws changes; only the Zone B row internals move from a flex void to a fixed-track grid.

## The layout revision section

CHANGE 3 — LAYOUT & DENSITY OF THE SPINE (Zone B row internals: from flex-void prose rows to a fixed-column data grid)

WHY THIS ADDENDUM
The render shipped the correct information architecture (three zones, cross-grain queue, deduped creatives) but abandoned the agreed sortable GRID at the row level. Each finding is a `display:flex` row where the entity name is `flex:1` and every number is packed into one right-hand child with `margin-left:auto` + `justify-content:flex-end` + `flex-wrap`. Two structural failures follow, and both are the owner's complaint:
- The `margin-left:auto` converts all horizontal space into a single fat margin — that is the wide-screen "dead middle." It is not whitespace to decorate; it is the absence of the comparison columns this queue was promised on.
- `justify-content:flex-end` behind variable-width verdict words ("Scale" vs "Refresh" vs "Review 3 calls") re-floats money-at-stake to a different x-position on every row. The sort by money-at-stake is real but physically un-scannable — there is no money COLUMN to run an eye down. This breaks the product's core promise: one comparable axis across grains.
Plus each row is a two-line band (bold name + a muted "Creative · video 9:16 · 2 ad sets" sub-line) with a 46px thumbnail setting row height (~64px/row), so 11 findings read as 11 fat sparse bands and the queue only ever grows DOWNWARD.

THE FIX IS NOT A NEW DESIGN — IT IS FINISHING THE GRID. Keep the three-zone frame, the cross-grain queue, deduped first-class creatives, the evidence drawer, and every honesty law exactly as specified in Change 2. Change ONLY the Zone B row from a flex void to a real fixed-track CSS grid.

3.1 — MAKE THE COLUMNS ACTUALLY EXIST (columnar record layout)
- Delete `margin-left:auto` and `justify-content:flex-end` outright. The row becomes one shared `grid-template-columns` applied identically to every row so each value lands at the SAME x down the whole queue.
- The horizontal space is spent on named right-aligned mono-numeric comparison columns — the exact axes a buyer cross-reads to defend a verdict — not on a gap. Canonical column rack, left to right:
  1. Grain chip — fixed ~44px — ANOM / CMP / SET / CRV.
  2. Entity — the ONE flexible/truncating track, `minmax(220px, 1fr)`, single-line ellipsis. Holds: a fixed ~24px asset swatch (creatives only; blank/— for other grains), concept/entity name, a format chip (video 9:16 / static / carousel), and adset_count as INLINE micro-meta. This is where the old muted second line is absorbed.
  3. Spend — fixed, right-aligned mono.
  4. ROAS — fixed, labeled to the ACTIVE temporal window (7/14/28d) in the header, right-aligned mono.
  5. CPA — fixed, right-aligned mono.
  6. Money-at-stake /wk — fixed ~110px, right-aligned mono — THE ANCHOR AXIS the whole queue sorts on.
  7. Δ-since-last-session — fixed, signed +/- mono (this is the delta that made the row surface).
  8. Delivery-state pill — fixed (Active / Blocked / Fatiguing / Learning).
  9. Confidence / evidence-count — fixed.
  10. Verdict — fixed ~90px chip (Scale / Refresh / Review).
  11. Trend sparkline — fixed ~64px.
- STICKY HEADER ROW carries the column names with UNITS HOISTED once ($, ×, EUR/wk, d, %) so no cell repeats a unit. Every header is a sort control; shift-click adds a secondary sort key. Sort/multi-sort/CSV export operate over the full population, matching the Change 2 lens contract.
- Discipline over maximalism: this is a curated ~10-column rack, not a wall of 15. Every column must be one a buyer eye-scans to decide scale-vs-cut; if it isn't, it lives in the evidence drawer, not the spine.

3.2 — CAP THE SPINE SO THE WIDE-SCREEN VOID CANNOT RETURN AT COLUMN SCALE
- Cap the center table at a readable measure: `max-width` ~1150–1300px, left-aligned/centered under the spine header. Do NOT stretch cells to fill a 2560px monitor — smearing columns apart re-creates the exact dead gap at column scale, which is the trap.
- Beyond the cap, extra viewport is NOT dead because the frame is already three-zone: the leftover width is carried by the STRUCTURE NAVIGATOR (Zone A, left) and the EVIDENCE DRAWER (Zone C, right). Width is consumed by columns of real data up to the cap, then by the flanking zones — never by an empty middle.

3.3 — CUT THE VERTICAL SPRAWL (density, not hiding)
- Collapse every finding to ONE dense line, ~30–32px, not a two-line ~46–64px band. The muted meta prose ("video 9:16 · 2 ad sets") stops being a wrapped second sentence and becomes cells (format chip + adset_count) — data belongs in columns, not in a height-doubling paragraph.
- Shrink the 46px thumbnail to a fixed ~24px in-cell swatch so the asset no longer dictates row height; a creative row is the same height as an ad-set row and stays comparable on the shared money axis. (Hover peeks larger; full frame lives in the evidence drawer.)
- Add a COMFORTABLE / COMPACT density toggle; default compact for the power buyer.
- Section groups (Pinned · Findings · Non-sales · Stabilizing) become THIN STICKY sub-header rows inside ONE continuous scroll — each showing count + summed stake — not four spaced-out padded bands with air between them. The money-column header stays pinned as you scroll.
- Demote the standing "explain" microcopy / paragraph bands to a header tooltip, not a padded prose row between sections.
- Keep the Change-2 controls that already fight sprawl: bounded top-N by money-at-stake, temporal "changed since last session" ON by default, Learning/Stabilizing auto-deferred. The queue getting longer must cost a CLICK (reveal receipt), never a silent scroll — honesty law intact.
- Net target: the ~11 findings that currently eat ~900px of scroll fit in roughly one ~350px viewport; the queue grows by getting DENSER, not longer.

3.4 — CREATIVE ROWS STAY FIRST-CLASS INSIDE THE GRID (do not break the rack)
- One row per asset, asset-deduped across all N ad sets, combined spend/money-at-stake, expandable to per-placement via row disclosure — never per-ad-set slivers. (Unchanged from Change 2; restated because the grid must honor it.)
- The hook-frame thumbnail is the fixed ~24px swatch at the head of the entity cell, aligned across all creative rows so the visual column is scannable top-to-bottom as fast as the money column — it does NOT get its own wide column and does NOT set row height.
- For non-creative grains (campaign/ad set/anomaly) the swatch cell reads blank/— (missing != zero): no fake tile, no knocked-out alignment.
- Because it is one grid, a CRV row and a SET row share the IDENTICAL money-at-stake column — this is what finally makes "one comparable axis across grains" real instead of a promise. adset_count is its own inline value so "which concept is spread widest" is sortable.
- The count-chip lifecycle lens (Winners/Fatigue/Testing/Diagnose) is the SAME table re-filtered in place using the SAME columns — pivoting into creative-first mode never loses column alignment.

3.5 — RESPONSIVE BEHAVIOR
- Wide (≥1440px): full ~10-column rack visible at the capped measure; both flanking zones (tree + drawer) can sit open simultaneously without shoving the table. At ≥1440 the evidence drawer may open as an INLINE right split rather than a full overlay — the capped spine leaves room, so evidence and queue coexist.
- Laptop (~1024–1440px): drop the lowest-priority columns first (sparkline → confidence → CPA) into the drawer/tooltip; keep grain chip, entity, money-at-stake, Δ, verdict, delivery-state always. Evidence reverts to overlay drawer.
- Narrow (<1024px): entity + money-at-stake + verdict + status stay as the irreducible spine; the rest collapse behind a per-row disclosure. Never wrap a row to two lines to survive — truncate or collapse, keep the single-line rhythm.

3.6 — DO NOT (explicit rejections)
- NO card / tile grid. "Use the horizontal space" means MORE COLUMNS, never more items per row. A card grid re-creates the dead middle at card scale, scatters money-at-stake into a masonry with no shared vertical axis (cross-row ranking dies), burns MORE vertical space via per-card chrome + padding, flattens cross-grain weight (a $4k campaign card reads equal to a $60 creative card), reflows unpredictably on resize so positions are never stable, and is the consumer dashboard the brief vetoes. Rejected.
- NO full-bleed prose rows, NO `margin-left:auto`, NO `justify-content:flex-end` on the number cluster, NO stretching cells to fill an ultrawide.
- NO two-line row bands, NO thumbnail driving row height, NO inflated padding between sections.
- NO master-detail as the default (that is the opt-in Structure mode from Change 2).

PRESERVE (unchanged): IBM Plex operator-console density, warm-neutral --adc tokens, semantic status colors + purple --auto for the engine voice, mono numerics, flat (no cards-on-cards / no shadow chrome), 13px base, and all four honesty laws — missing != zero (blank swatch, "—" cells), no fabricated cross-engine rank, nothing silently hidden (suppression receipts on every truncation/filter), evidence-first (row opens the Zone C drawer).

ACCEPTANCE CHECKS (append to Change-2 list)
9. Money-at-stake renders in a true right-aligned mono COLUMN at the same x on every row; an eye can run straight down it and rank a creative cut against an ad-set cut in one pass.
10. There is no empty middle at any viewport width; the spine is capped and the flanks are the tree + drawer, not dead air.
11. Every finding is a single ~30px line; the ~11-row default set fits in roughly one viewport; a density toggle exists.
12. Creative, ad-set, campaign, and anomaly rows share identical row height and an identical money-at-stake column; the thumbnail is a fixed in-cell swatch, not a height driver.
13. No card/tile grid anywhere; the horizontal axis is spent on data columns only.
