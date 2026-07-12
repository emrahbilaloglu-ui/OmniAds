# Codex task prompt — Decisions surface review + design update

Comprehensive brief handed to Codex (a separate coding agent working on this repo) to critically review and redesign the Meta Decision Center. The owner is not satisfied with where the current columnar-grid direction landed and is unsure of the right answer, so Codex must bring genuine design judgment, propose a clear direction, and implement it. Paste the fenced block below to Codex.

```
TASK: Critically REVIEW and then REDESIGN + IMPLEMENT an update to the Adsecute "Meta · Decision Center" (the Decisions surface).

YOUR ROLE
You are a senior product designer + front-end engineer with deep media-buying domain sense. The product owner has been through a long design loop, is NOT happy with where the current direction landed, and is genuinely unsure what the right answer is. So do NOT just execute a spec — review honestly, form your own strong point of view, propose a clear direction, and build it. Bring fresh eyes.

1) WHAT THIS SURFACE IS
- Route: /platforms/meta. Component: components/meta/redesign/MetaPlatformPage.tsx (~3800 lines). Styles: app/globals.css (scoped under .ad-final and .ad-console-shell). Types: components/meta/redesign/types.ts and lib/meta/recommendations.ts (MetaRecommendation).
- It is a READ-FIRST triage console for ONE Meta ad account. A single business is already selected app-wide (global switcher at the top). A server engine grades every campaign, ad set, and creative each snapshot and surfaces what needs action. Clicking a row opens an EVIDENCE inspector (why / confidence / recommended action). Writes (pause / scale / bid / budget) happen through that drawer or a guarded flow, not inline.
- Data actually available per row (use it): entity name, level (campaign | adset), ASC/Advantage+ kind, spend, roas, cpa, ctr, frequency, purchases, verdict/decision, confidence (+score), a delivery/learning flag (watchSegment), a recently-changed flag. Creatives come from a SEPARATE engine (creative-engine-v3) with their own fields.
- Data that does NOT exist and must render as an honest "—" (never fabricate): a distinct "money-at-stake" metric (the code ranks on spend; treat spend as the money axis and label it honestly), a per-row trend / sparkline time series, a per-row age, a per-row numeric delta-since-last-session.

2) WHERE IT STANDS NOW (what you are reviewing)
- Recent work: the row list was turned into a columnar CSS grid (entity column + aligned right-aligned mono numeric columns + verdict chip + honest "—" cells), the three old context bands (pulse / overnight digest / readiness) were collapsed into a one-line "morning brief", and all lanes (Action Now / Watching / Non-sales / Healthy / Archive) were unified into that same grid. It builds green, typechecks, and the tests pass.
- THE PROBLEM: the owner's words are "the design did not go the direction I wanted." The current result reads like a dense data spreadsheet. It is scannable but does not feel like the calm, thoughtfully-designed product the owner is after, and it still stacks chrome above the grid (a date/status note + a staleness banner + a ~10-control filter toolbar + the morning brief) before the first row.

3) WHAT THE OWNER WANTS (synthesized from the whole design process — honor these)
- Calm, uncluttered, easy on the eyes — explicitly "Triple Whale simplicity". Not a wall of controls, not a raw spreadsheet, not washed-out either.
- It must stay usable and calm when the account has MANY campaigns AND many ad sets AND hundreds of creatives. Decluttering AT SCALE is the core problem to solve.
- Use the horizontal space intelligently — no dead empty middle on wide monitors — and stop the endless vertical row-after-row sprawl.
- Keep the reference design language the owner loves: dense-but-clean IBM Plex operator console; warm-neutral --adc tokens (canvas #F5F5F3, cards #FFFFFF, ink #1A1C1F/#4A4F56/#7D838C, hairline borders #E4E4E0/#CDCDC7, focus #1E62D0); semantic colors (danger/caution/positive/info) used sparingly for meaning plus a purple --auto (#6C41BE) for the engine/automation voice; mono numerics (IBM Plex Mono, tabular); flat (no shadow chrome, no cards-on-cards); 13px base. Do NOT restyle this into a generic consumer dashboard.
- IA instincts the owner voiced during the loop (weigh them, do not blindly obey): because one business is already selected globally, the old "businesses by urgency" column is redundant and should become campaign / ad-set structure; creatives should be reachable and filterable from the current selection; and — important — creatives are VISUAL, and the owner was unhappy seeing them rendered as just another data-list row. A visual / gallery treatment for creatives (at least as a mode) is very likely what the owner wants.
- It must read as a real PRODUCT design: thoughtful hierarchy, breathing room where it earns its place, and an immediate answer to "what should I act on right now" on load — not a table the user has to parse.

4) HARD CONSTRAINTS (never violate)
- Honesty laws: missing != zero (render "—"/"no data", never a 0); no fabricated data; no fake cross-engine rank and no invented money-at-stake (there is no distinct at-stake field — it is spend; be honest about it); withhold counts on error rather than showing false zeros; evidence-first (the "why" is always one click away).
- Single-user product: NO feature flags, NO gradual rollout, NO A/B. Merged code is live.
- Keep it FUNCTIONAL: no dead buttons. Preserve the existing behavior (filters, evidence drawer, row selection, compare, bulk pause/defer, bid modal, banners) — or deliberately replace it, but never leave it broken or non-wired.
- Real data only, from the existing decisions-workspace / anomaly / creative-engine queries. Do not invent backend fields. If a stronger design needs data the backend does not have, render "—" for it now AND clearly list the server contract it would require.

5) OPEN QUESTIONS THE OWNER IS UNSURE ABOUT — resolve each with a clear recommendation
- Is a dense columnar grid even the right layout, or is it grouped cards, a two-pane master-detail, a hybrid, or something else? The owner reacted against BOTH a washed-out look AND a pure spreadsheet — find the middle that is calm yet dense-enough for a pro.
- Creatives: a data row like everything else, a visual gallery, or a toggle between them? (Owner leans visual for creatives.)
- How much of the lane-tab model to keep vs. a single money-ranked cross-grain queue with in-scroll sections.
- How to spend wide-screen width: more columns, a persistent structure/evidence pane, or a capped reading measure with calm margins?
- Where the campaign -> ad set -> creative structure lives (a left tree navigator was proposed earlier; decide if it earns its space).

6) YOUR TASK
a) REVIEW: run the app and read the code, then write a short, honest critique of the current Decisions surface against sections 3-4 — be specific about what makes it feel like a spreadsheet, still-cluttered, or not-what-the-owner-wants.
b) PROPOSE: commit to ONE clear design direction that resolves section 5 (you may sketch 1-2 alternatives, but recommend one, with rationale). Stay faithful to the reference language + honesty laws + the calm-at-scale goal.
c) IMPLEMENT: build the update in the codebase (MetaPlatformPage.tsx + app/globals.css, reusing the existing data layer/queries — do not rewire the API). Keep "tsc --noEmit" and "next build" green and the meta test suite (vitest components/meta) green (update only the assertions your presentation change actually touches). Verify it renders with REAL data on the demo account — note that Action Now is often empty while Healthy / Non-sales / Archive carry rows, so verify against a populated lane.
d) Do it on a feature branch with a clear commit, and in the PR/commit description state your design rationale + any server contracts a fuller version would need, so the owner can course-correct.

7) REFERENCE MATERIAL IN THE REPO / ON THE MACHINE
- docs/full-ui-redesign/DECISIONS_REVISION_PROMPT_v2.md — the prior panel-derived spec (three-zone frame + columnar grid + a layout addendum). Treat this as INPUT and history, NOT gospel: the owner is not satisfied with where it led, so diverge if you have a genuinely better answer.
- The original Claude Design reference set lives in the owner's Downloads folder ("Create a complete from-scratch product redesign for Adsecute…/01 Decisions.dc.html" and siblings) — the design-language source of truth.
- Current implementation to review: components/meta/redesign/MetaPlatformPage.tsx, app/globals.css (search ".ad-final .meta-spine" and the ".ad-console-shell" token block), components/meta/redesign/types.ts, lib/meta/recommendations.ts.

Deliver a genuinely better Decisions design, not a re-skin. The bar is the owner's: calm, uncluttered, handles scale, treats creatives as visual, honest, functional, reference-faithful — and it should feel designed, not tabulated.
```
