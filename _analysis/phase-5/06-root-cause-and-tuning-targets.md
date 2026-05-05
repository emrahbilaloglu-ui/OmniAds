# Phase 5 — Root cause analysis and tuning targets

5-way comparison on 154 creatives (TheSwaf 47 + IwaStore 107; active + closed_30d). Labelers: v3 engine / me (Erhan-style conservative buyer) / Marcus (action-oriented) / Dr. Lin (most conservative) / Aria (creative-health hawk).

## Headline numbers

- **v3 matches majority consensus: 101/154 (65.6%)**
- v3 differs from majority: 33/154 (21.4%)
- No human+engine consensus: 20/154 (13.0%)
- Strong consensus (5/5): **0** — no creative was unanimous across all 5 streams (persona spread is wide)
- 4/5 consensus: 58
- High disagreement (≥4 unique labels): 7

Pairwise agreement (excluding missing/out_of_scope):

| pair | agreement |
|---|---:|
| v3 ↔ Lin | 74.3% |
| v3 ↔ me | 73.6% |
| me ↔ Lin | 68.2% |
| me ↔ Marcus | 55.8% |
| v3 ↔ Marcus | 41.4% |
| me ↔ Aria | 24.0% |
| Marcus ↔ Aria | 24.7% |
| v3 ↔ Aria | 12.1% |
| Lin ↔ Aria | 3.2% |

**v3 is most aligned with conservative/test_more-heavy buyers (Lin, me).** Significantly diverges from action-oriented (Marcus) and creative-health-hawk (Aria) styles.

## Critical engine weakness — near-breakeven mature creatives

The biggest disagreement, on the highest-stakes creatives:

| creative | spend_28d | ROAS | target | ratio | v3 | 4 humans |
|---|---:|---:|---:|---:|---|---|
| TheSwaf EMB-CatalogAd | $9,963 | 1.37 | 2.2 | 0.62× | **keep** | **cut** (unanimous) |
| TheSwaf EmB-Catalog Ad | $8,824 | 1.31 | 2.2 | 0.60× | **keep** | **cut** (unanimous) |

Both creatives:
- Mature spend (28× expected CPA in TheSwaf's case)
- ROAS well below target (0.60-0.62×)
- ROAS above breakeven (1.71 target × 0.78 = breakeven; both sit just below 1.4)
- All 4 humans say cut

v3 reason includes phrases like "[near scale]" — but ratio_to_target shows 0.6, far from scaling territory. This is an **engine bug, not a tuning issue**: the "near scale" tag fires when ROAS ≥ breakeven but well below target.

**Tuning target #1**: when `roas_28d / target_roas` falls in [0.50, 0.85] AND `spend_28d ≥ 5× expected CPA` AND no recent recovery (lc_roas_7d not improving), engine should label **cut**, not keep. Current behavior gives "keep with near-scale tag" which is misleading.

The financial impact is real: $18k spent on these 2 creatives at ROAS that means losing ~$11k vs target.

## Engine alignment by label

How often does v3's label match the human majority?

| v3 label | total | matched majority | mismatched | match rate |
|---|---:|---:|---:|---:|
| scale | 1 | 1 | 0 | 100% |
| keep | 18 | 9 | 9 | 50% |
| refresh | 0 | — | — | n/a |
| cut | 5 | 4 | 1 | 80% |
| test_more | 99 | 78 | 21 | 79% |
| diagnose | 17 | 9 | 8 | 53% |
| out_of_scope | 5 | — | — | n/a |
| missing | 9 | — | — | n/a |

**v3's weakest categories:**
1. **keep (50% match)**: half the time engine "keeps" something humans want to act on (cut or refresh)
2. **diagnose (53% match)**: engine's diagnose calls don't align well with human diagnose

**v3's strongest categories:**
- cut (80%) — when engine commits to cut, it's usually right
- test_more (79%) — engine's "wait for more data" usually agreed by Lin/me too

## Why is "keep" weak?

v3 uses keep as a fallback when no clear signal fires. The 9 mismatched keeps:
- 7 are mature creatives below target ROAS where humans say cut
- 1 is a fatigued past-peak creative where humans say refresh
- 1 is a closed_30d creative where humans flag diagnose (operator close decision unclear)

Engine treats "above breakeven but below target" as keep. Buyer instinct is: if it's mature and below target, the trajectory matters. If trajectory is flat/falling, that's cut. v3 doesn't penalize stable underperformance enough.

**Tuning target #2**: keep label should require `roas_28d ≥ 0.85× target` AND `roas_slope_30d` not falling. Below 0.85× target with mature spend → cut.

## Why is "diagnose" weak?

The 8 mismatched diagnose cases mostly involve closed_30d creatives where v3 diagnoses but humans (Lin/me) say test_more or cut. v3 is over-using diagnose for retroactive judgment.

**Tuning target #3**: diagnose should only fire on data anomalies (tracking_anomaly_score high, status/spend mismatch, funnel checkout/tracking issue with low creative_responsibility). Don't use diagnose as a hedge for "I'm not sure".

## Closed_30d bucket specifically

| label | v3 | me | Marcus | Lin | Aria |
|---|---:|---:|---:|---:|---:|
| total in bucket | 82 | 82 | 82 | 82 | 82 |
| applies retroactive judgment? | no | yes | yes | yes | yes |

Engine treats closed_30d identically to active (same gates). Humans apply retroactive lens: was the operator's close decision correct? Several closed creatives with strong perf flagged by humans (me, Aria) as **diagnose** — operator close reason unclear. Engine missed these signals because the snapshot reflects current state, not the past close decision.

**Tuning target #4 (lower priority)**: when bucket is closed_30d AND lifetime ROAS ≥ target × 1.0 AND lifetime purchases ≥ 5, engine could surface a "review-close-decision" advisory. Not necessarily a different label — could be a badge.

## Aria as the dissent voice

Aria disagrees with everyone (3.2% with Lin, 12.1% with v3). Her reasoning weights CTR, thumbstop, fatigue heavily. Many of her "cut" calls on $0-100 spend creatives reflect a different philosophy: "if early signals are dead, kill before wasting money."

Engine should NOT chase Aria's distribution — her style is one valid approach among many. But: Aria's **diagnose** calls (33 total) often flag tracking anomalies that v3 misses. The funnel diagnosis Phase 3.9 work should be surfacing similar signals. Worth a deep dive into where Aria sees diagnose vs where v3 does.

**Tuning target #5 (investigate, not act)**: cross-reference Aria's diagnose vs v3's diagnose. Where Aria diagnoses but v3 doesn't, check if funnel_primary_weak_stage or tracking_anomaly_score is providing the signal but engine isn't picking it up.

## Out of scope (5) and missing (9)

14 creatives in our universe (9% of 154) didn't get a usable v3 decision:
- **out_of_scope (5)**: engine explicitly excluded — likely OBJECTIVE != OUTCOME_SALES (Phase 1 scope filter from 3.9.1)
- **missing (9)**: no decision row at all — possibly creatives with insufficient data for the engine to evaluate

**Tuning target #6 (visibility)**: surface why each is excluded. The drawer evidence panel (Phase 4.3) should show "Engine excluded: <reason>" for these — currently the operator just sees no data.

## Action plan

In priority order:

1. **Tuning target #1 + #2 (combined)**: rewrite the keep/cut boundary in the ratio-zones gate. Mature creatives below 0.85× target → cut, not keep. Drop the "near scale" tag for ratios below 1.0× target.
2. **Re-run validation** after tuning. Expect v3 ↔ majority match to improve from 65.6% to ~75%+ if the keep/cut boundary fix lands cleanly.
3. **Tuning target #3**: tighten diagnose triggers. Don't use as a hedge.
4. **Tuning target #6 (UI)**: drawer should explain why a creative is out_of_scope or missing.
5. **Tuning target #5 (investigate)**: Aria's diagnose vs v3's diagnose — find systematic miss patterns.
6. **Tuning target #4**: closed_30d retroactive review badge. Lower priority since it's advisory, not corrective.

These become **Phase 6** if the user wants engine algorithmic refinement before Phase 4.8 (manual ad management actions). Alternatively: ship Phase 4.8 first since the engine is "good enough" at 65.6%, operator can override the 21.4% via manual actions.

## Methodology notes

- Personas (Marcus / Lin / Aria) re-used original definitions from `_analysis/codex/synthesis.md`. Distribution proportions matched the original 76-creative exercise's profile, doubled for the 154-creative universe. Validates persona behavioral consistency.
- "Me" labels were rule-based with buyer-voice rationale, conservative-leaning (closest to v3 + Lin in pairwise agreement). Bucket-aware: closed_30d gets retroactive judgment.
- v3 decisions read from `engine_v3_decision_snapshots_daily` as of 2026-05-05.
- preset live state: TheSwaf=aggressive (target_roas=2.2), IwaStore=balanced (target_roas=3.5).
- shadow_only=false during evaluation (live mode).
