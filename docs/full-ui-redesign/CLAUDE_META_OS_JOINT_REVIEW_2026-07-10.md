# Claude Code — Final Joint Review of the Meta OS Joint Decision and Claude Design Prompt

VERDICT: CONTINUE

Updated 2026-07-10 after a direct post-fix re-read of `META_OS_JOINT_DECISION_2026-07-10.md` and `CLAUDE_DESIGN_META_OS_PROMPT_2026-07-10.md`. All twelve blockers (B1–B12) are materially closed in both documents; see Post-fix verification below. The verdict flips from STOP_AND_FIX to CONTINUE. The original review body is retained unchanged for audit trail.

The joint decision faithfully carries the *shared spine* of both studies: verified-execution north star, permanent Act Now sectioning, single-column + persistent inspector (a justified override of the owner two-column input), `promotionBasis` over a fabricated Validation stage, cohort-at-creation default, Meta-attributed labeling, PAUSED-create invariant, four-mode automation with locked auto-execute, and mobile Tier-0. Those rulings are sound. The blockers below were the closable gaps: safety/honesty/implementability requirements that both studies verified in repo source but the first draft of the two docs dropped or contradicted. Every one was a wording/patch fix; none re-decided direction, and all are now applied.

Method: 10 dimension auditors over the four docs + repo; each finding refuted by three adversarial lenses. Only survivors appear as blockers.

---

## Post-fix verification (2026-07-10)

Re-read of both docs confirms each blocker closed with the required semantics:

- **B1 — Stale commercial-target demotion.** CLOSED. Joint P0 honesty #9 + Phase 0; prompt “### Economic facts” (`Target stale — reduced authority`, demote to `commercial_truth_stale`, server-wired).
- **B2 — Scale Budget has no write path.** CLOSED. Joint “### Promote versus Scale ruling” + prompt “### Promote to Main versus Scale Budget”: routed manual Ads Manager step + receipt, tagged Proposed/contract required, never a one-click write.
- **B3 — `riskTier` producer + highest-ceremony default.** CLOSED. Joint card ruling + P0 selection #8 + Phase 1; prompt “### Decision card” (`Risk unclassified` → highest ceremony, absent never means low) + ADR gate.
- **B4 — Card 1–8 vs 5-card contradiction.** CLOSED. Prompt “### Decision card” replaced with a per-density grammar (Compact / Fact-strip / Thumbnail); acceptance item 2 aligned.
- **B5 — Inspector L1/L2/L3 undefined.** CLOSED. Prompt “### Evidence inspector”: binding L1/L2/L3 → item mapping added.
- **B6 — `>=1600` inspector-threshold contradiction.** CLOSED. Prompt “## RESPONSIVE FRAMES”: persistence begins at 1440; 1600 only widens; never a second column.
- **B7 — Fabricated action-class stop capability.** CLOSED. Prompt “## 06 - AUTOMATION”: per-class breakers tagged Proposed/contract required, “do not exist today.”
- **B8 — Kill-switch semantics.** CLOSED. Both docs: business scope visible on Decisions; re-check at admission and before every mutation/retry; mid-batch halt + aggregate receipt; engage freezes approvals (`Blocked by kill switch`), release re-preflights.
- **B9 — Staged ACTIVE halt-on-drift.** CLOSED. Joint step 6 + prompt “## 05 - LAUNCHPAD” executor: halt on drift/kill/ambiguous, no retry before reconciliation.
- **B10 — Orphaned/unguarded write paths.** CLOSED. Joint P0 #11/#12 + Phase 0: `lib/meta/execution.ts` archived; `bulk-ad-status` resume guarded (preflight, batch cap, target scoping).
- **B11 — Creator spend reconstruction.** CLOSED. Both docs: CPM, cost-per-result, impressions, reach, frequency never serialize; closed Tier-0 signal set; Tier 1 Admin-gated; no absolute-financial tier.
- **B12 — `Open/In Review/Done` contradiction.** CLOSED. Prompt aligned to the response-state model in all three locations (inspector item 7, collaboration, Monitor column); explicit “V1 does not add Open/In Review/Done.”

The non-blocking improvements below remain optional and are not gating.

---

## Blockers (must fix before the prompt is used / before any trust claim)

**B1. Stale commercial-target demotion is missing from every document.** *(JOINT “### P0 honesty and privacy”; PROMPT “### Economic facts”)*
Defect: A months-old operator target still renders as full-trust `vs profit target`, silently driving every scale/cut, `ratioToTarget`, and Winner chip. This is a Claude-study Bucket-1 prerequisite (M.1 item 1.11), critical gap 7, and a P.1.5 MUST-CONTAIN item; it appears in neither P0 list nor the prompt.
Evidence: `lib/creative-decision-engine/data-source.ts` (~line 1066) reads `business_target_packs … ORDER BY updated_at DESC LIMIT 1` with no age predicate; the 30-day rule in `lib/business-commercial.ts:248-256` is unwired. (Refuter: `refuted: False`, verified at HEAD.)
Patch: JOINT — add P0 item: “A commercial target older than 30 days demotes to `commercial_truth_stale` with a confidence penalty and card copy; wire the existing `lib/business-commercial.ts` staleness rule into the engine read.” PROMPT “### Economic facts” — add: “A configured target older than its review window renders `Target stale — reduced authority`, never full-trust `vs profit target`.”

**B2. Scale Budget is presented as an executable CTA but has no write path.** *(PROMPT “### Promote to Main versus Scale Budget”; JOINT “### Promote versus Scale ruling”)*
Defect: The flagship verb has no provider budget-mutation action kind and no prior-state capture; the only budget mutation in the repo is the orphaned guard-bypass path. Presenting it as an executable card command is fabricated current capability (5-persona shared miss).
Evidence: `MetaAdsActionKind` (`lib/meta/ads-action-log.ts:3-9`) has pause/resume/bid/launch only — no budget kind; sole budget write is orphaned `lib/meta/execution.ts`. (Refuter: `refuted: False`.)
Patch: PROMPT — append: “Scale Budget has no provider write path today. Until the write gateway ships a budget executor, the Scale Budget CTA is a routed manual step (Ads Manager handoff plus receipt capture), tagged Proposed/contract required — never a one-click in-product budget change.” Mirror in JOINT.

**B3. `riskTier` is never scheduled, and the “missing tier → highest ceremony” safety default is dropped.** *(BOTH — PROMPT “### Decision card”; JOINT “### Phase 1 - Canonical read contracts”)*
Defect: Both docs gate mobile approval and card/inspector confirmation on `riskTier`, but no phase builds its producer and neither states that an absent tier must escalate, not default to low-risk. A card with no server risk would silently allow the lightest ceremony.
Evidence: no `riskTier` producer exists in active source (grep-verified, hits only in `lib/archive`); Claude M.1 item 1.3 (“absent must never mean low”). (Refuter: `refuted: False`.)
Patch: JOINT Phase 1 — add “Per-grain server-stamped `riskTier` producer (`low|medium|high`); missing tier renders `Risk unclassified` and receives the highest ceremony.” PROMPT “### Decision card” — after the low/high-risk sentence add: “`riskTier` is a server contract that does not exist yet (Proposed/contract required); a decision without one is `Risk unclassified` and always gets the highest confirmation ceremony — absent never means low.”

**B4. The universal card mandate contradicts the 5-card density claim.** *(PROMPT “### Decision card” vs “### Layout” + acceptance item 2)*
Defect: “Every card shows: 1..8” (entity+scope, role/assessment/economic chips, two-line rationale, exposure number, three metrics, confidence+maturity+freshness+risk as distinct values, command) cannot fit the “~5 compact text cards at 1440×900” target (~115px/card per study H.1). Unimplementable as written.
Evidence: prompt lines 275-291 vs 262-270; Claude H.1 density math (Card ~96-120px).
Patch: Replace “Every card shows:” + 8-item list with a per-density grammar: every card carries items 1, 2, 5, 8; **Compact** adds the one-line rationale + role/assessment chips only; **Fact-strip** adds three metrics; **Thumbnail** adds the 48-72px preview. Confidence band/maturity/freshness/risk collapse into a single status line, full detail in the inspector.

**B5. The inspector binds requirements to layer names it never defines.** *(PROMPT “### Evidence inspector” + “## PRIORITY AND IMPACT HONESTY”)*
Defect: “Use three additive disclosure layers and this exact reading order: 1..10” gives ten items but no item→layer mapping, while other sections reference “inspector L3” and the card grammar references L1/L2. The designer cannot place content deterministically.
Evidence: prompt line 295 (10 items, only item 6 “Collapsed”); line 218 (“inspector L3”); card refs to L1/L2.
Patch: After the 10-item order insert: “Layer mapping (binding): L1 = card headline + one-line rationale; L2 = inspector default-open (items 1-5, 7-10); L3 = item 6, the collapsed `How this was decided` (formula, raw/published labels, classifier/engine/scope versions, and raw confidence numerals labeled `Engine score, not a probability`).”

**B6. `>=1600 persistent inspector option` contradicts the `>=1440` permanent-reserve ruling.** *(PROMPT “## RESPONSIVE FRAMES”)*
Defect: Residue of the overridden Codex two-column model. Section 01 and the joint ruling reserve the 420-460px inspector permanently at `>=1440`; the breakpoint list implies persistence begins only at `>=1600`. Contradictory thresholds for one behavior.
Evidence: prompt line ~724 vs line 270 and joint “### Desktop layout ruling.”
Patch: Replace the bullet with: “`>=1440` — one decision column plus the permanently reserved 420-460px context/inspector zone (per §01); `>=1600` — the inspector may widen toward 460px and the measure toward 880px. Never a second decision column.”

**B7. Prompt asserts a current per-action-class stop mechanism that does not exist.** *(PROMPT “## 06 - AUTOMATION”)*
Defect: “Show the current environment, business, and action-class stop mechanisms as a named registry” claims a per-class breaker exists. Fabricated current capability.
Evidence: `app/api/meta/automation/route.ts:63-70` accepts only `engage_kill_switch|release_kill_switch|set_decision_type_mode`; no per-class breaker in `lib/meta/automation-control-plane.ts`. (Refuter: `refuted: False`.)
Patch: Reword: “Show the current environment and business stop mechanisms as a named registry; design action-class stop scope as Proposed/contract required — per-class breakers do not exist yet — until one unified fail-closed registry exists.”

**B8. Kill-switch semantics are incomplete on three safety points.** *(BOTH — JOINT “### Automation ruling” + “### P0 honesty and privacy”; PROMPT “## 01”/“## 06”)*
Defect: (a) The Decisions surface reads only the env switch, so an engaged **business** kill switch is invisible there (P0). (b) The engage×pending-approvals disposition is undefined. (c) Re-check-before-every-mutation and mid-batch halt are dropped.
Evidence: `decisions-workspace/route.ts:105-108` reads only `META_ADS_WRITE_KILL_SWITCH` (Claude L.1); Codex “kill switch must be checked at admission and immediately before every provider mutation”; Claude J.7 pending-approvals rule. (Refuters: `refuted: False`.)
Patch: JOINT — add P0: “Decisions kill-switch state must source every engaged scope (env AND business).” Add to “### Automation ruling”: “Switch state is re-checked immediately before every provider mutation; mid-batch engagement halts all remaining writes and emits one aggregate receipt. Engaging freezes every approval-required item in scope (`blocked by kill switch`); release auto-executes nothing and each frozen item returns to Approval Required with a fresh preflight.” PROMPT §06 — mirror.

**B9. Staged ACTIVE activation drops the halt-on-drift/kill/ambiguous step.** *(BOTH — JOINT “### Launchpad and ACTIVE ruling”; PROMPT “## 05 - LAUNCHPAD”)*
Defect: Both executor descriptions end at “activate the campaign last,” dropping the stop conditions both studies specify.
Evidence: Codex Launchpad step 5 (“stop on drift, kill-switch engagement, or ambiguous provider outcome”); Claude J.5.
Patch: Append step 6: “Halt immediately on state drift, kill-switch engagement, or any ambiguous provider outcome; never activate past an unverified child; no automatic retry before reconciliation.”

**B10. Two unguarded/orphaned write paths are dropped from P0.** *(JOINT “### Phase 0” + “### P0 honesty and privacy”)*
Defect: (a) `lib/meta/execution.ts` — the repo’s only budget mutation, bypassing kill-switch/log/verify — is not scheduled for archival. (b) `bulk-ad-status` resume — the actual in-product activation path — has no billing/pixel/creative preflight, no batch cap.
Evidence: Claude J.5 defects 3 and 4; both files present at HEAD.
Patch: JOINT Phase 0 — add: “Archive/delete `lib/meta/execution.ts` under the write-path policy (archived write paths are never revived).” Add P0: “Guard the `bulk-ad-status` activation path — live preflight (billing, active pixel, creative rejection) at resume, batch cap, and target scoping to launched-draft ads absent explicit override.”

**B11. Creator privacy leaves spend reconstructible.** *(BOTH — “Shares and creator view”)*
Defect: The never-serialize list bans only “absolute spend, revenue, CPA, or ROAS” and permits an undefined “creative-signal trend.” CPM × impressions multiplies back to spend; both fields exist on the share contract today.
Evidence: Claude I.3 Tier-0 gate explicitly excludes the cpm+impressions pair.
Patch: Replace the trend bullet with: “a creative-signal trend limited to thumbstop/hook retention, CTR (all/link), and video 25-100 completion; CPM, cost-per-result, impressions, reach, and frequency never serialize (they reconstruct spend).” Define the permission tier as a closed set (Tier 0 creative-signals = only tier live in v1; Tier 1 indexed-relative = Admin-gated, Future/fixture-only; no absolute-financial tier).

**B12. `Open/In Review/Done` is mandated by the prompt but deferred by the study/joint — unresolved contradiction.** *(PROMPT “## ROLES AND COLLABORATION”, inspector item 7, Monitor column)*
Defect: The prompt requires a workflow-status machine in three places; Claude H.8 defers it (a second completion truth beside the response and execution lifecycles) and the joint adopts the one-lifecycle model. The binding docs disagree.
Evidence: Claude H.8; joint P0 selection #5 (`rejected/overridden` + reason codes, no workflow-status object).
Patch: Choose one and state it. Recommended: align the prompt to H.8 — replace “Open/In Review/Done” with “response state (acted/deferred/rejected/overridden)” in all three places; else add a joint ruling justifying the `DecisionCaseV1` override.

---

## Non-blocking improvements (fix opportunistically; not gating)

- **Action axis:** `consequenceTone` map omits Investigate/Fix delivery/Fix policy — add caution=Fix delivery/policy, neutral=Investigate; note Keep/Tune/Rebuild/Switch/Swap are the v1 campaign contract, not the creative `buyerAction` union.
- **Stress data:** “203” means both total and remainder — align fixture to the `Showing 7 of 203` receipt; add a second USD account (two-account isolation) and an unknown-currency entity.
- **Re-add to the prompt** (present in Claude IA D.1/D.4/D.5, absent from the brief): scope rail, Saved-View-vs-Evaluation-Scope split, Healthy-as-context-band, permalink permanence, capability-declared Studio scope carriers.
- **Phase 1/6:** adopt Codex measurable Acceptance Gates and schedule the un-scheduled producers: creative envelope, per-grain priority/exposure, typed truth signals, graduation+`promotionBasis` persistence, hierarchy-deduped exposure, true-total digest counts, one ADR per producer.
- **a11y/freshness/states:** ban confidence numerals in aria-labels (`MetaActionCard.tsx:185`); “unknown freshness → stale-equivalent”; control-plane-unreadable fail-closed state; deep-links resolve across all lanes; mobile bottom-tab nav; middle-truncate names.
- **Rollback:** name the anti-pattern — the Google advisor path stamps `rolled_back` with no verify read-back; never a precedent.

---

## Implementation gate list (every P0 closes before any surface claims trust)

1. **Honesty P0s wired:** stale-target demotion (B1); unknown-freshness → stale-equivalent + worst-of registry; missing confidence not persisted as measured; USD-default removed; Meta-attributed labeling; date-range/decision-snapshot split with past-dated views action-disabled.
2. **Privacy P0s wired:** creator external payload strips all absolute financials **and** the spend-reconstructing cpm/impressions/reach/frequency set (B11); revocation-at-read + no-store; business/creator attribution; stricter mint; dead `passwordProtection` removed.
3. **Write-safety P0s closed before any execute affordance ships:** `activateAfterCreate` routed through the ACTIVE contract; orphaned `execution.ts` archived; `bulk-ad-status` resume guarded (B10); Scale Budget a routed manual step until a budget executor exists (B2).
4. **Phase-1 server contracts scheduled:** `providerAccountId` scope; snapshot-backed creative read model; classification overlay + named-blocker persistence + one ADR per producer; `riskTier` with highest-ceremony default (B3); creative envelope (`campaignId/adsetIds/thumbnailUrl`); date-free `decisionId`; response attribution + reject/override; keyed History read model; server top-N + true pre-cap + true-total digest counts.
5. **Automation authority gated:** one fail-closed write gateway; durable idempotency + unknown-outcome reconciliation; server-enforced guardrails; prior-state capture + verified forward-inverse rollback; kill-switch checked at admission and before every mutation, mid-batch halt, engage×pending-approvals disposition, business scope visible on Decisions (B7, B8); staged ACTIVE halt-on-drift (B9); four promotion gates (n≥30, ECE≤0.05, mature outcomes, silent_failure breaker); R4 actions Approval-Required at every stage.
6. **Prompt consistency resolved before the design is produced:** card per-density grammar (B4); inspector L1/L2/L3 mapping (B5); single `>=1440` inspector threshold (B6); `Open/In Review/Done` ruling resolved (B12).
7. **Acceptance evidence:** Codex measurable gates pass under corrected fixtures; every frame tagged Current/live-wired · Proposed/contract-required · Future/fixture-only, no fixture masquerading as current capability.

Direction is approved; ship the twelve blocker patches, then continue to the clickable local prototype.
