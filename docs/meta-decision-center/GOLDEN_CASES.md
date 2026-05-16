# Meta Decision Center Golden Cases

These cases document the expected campaign/adset decision behavior after Phases
A through F.4. They are documentation goldens for Phase G closeout and should be
converted into executable fixtures when touching the related resolver paths.

| caseId | area | input summary | expected output | proof / guard |
|---|---|---|---|---|
| MG-001 | cohort | `customEventType=PURCHASE` with generic conversion goal | purchase cohort | custom event wins over optimization goal |
| MG-002 | cohort | `optimizationGoal=LANDING_PAGE_VIEWS` with incidental purchases/revenue | out of purchase recommendation window | explicit non-purchase optimization cannot be overridden by revenue fallback |
| MG-003 | lane | non-sales objective with mid/upper/lead/traffic/engagement cohort | Out of Sales Scope or cohort-specific path | non-sales recs must not sit in daily sales-action lane |
| MG-004 | target anchor | purchase campaign looks like scale winner but no target pack anchors | no hard purchase scale | p75/p50 account benchmark is context, not profit anchor |
| MG-005 | target anchor | purchase adset looks like cut loser but no target pack anchors | no hard purchase cut | hard cut needs target/break-even ROAS or CPA anchor |
| MG-006 | target anchor | target pack absent but conservative fallback thresholds exist | no configured anchor | fallback coverage thresholds are ignored for hard anchors |
| MG-007 | maturity | high spend below `max(currency_floor, CPA_baseline * multiplier)` | not mature for hard cut/scale | loss-budget maturity formula governs purchase hard action |
| MG-008 | kind calibration | requested `campaign_kind=test` has sufficient rows | use Test calibration profile | kind-aware profile selected together |
| MG-009 | kind calibration | requested `campaign_kind=mixed` has sparse/null rows | canonical `all` fallback | no Main/Test inference for sparse Mixed bucket |
| MG-010 | labels | unlabeled campaign has would-be hard scale/cut/refresh | diagnostic/review-only output | label guard blocks hard action but preserves evidence |
| MG-011 | labels | Test campaign refresh candidate | cut semantics with `labelTransform` | Test refresh means experiment removal, not stable winner refresh |
| MG-012 | labels | Test campaign scale candidate | `promote_test_to_main` payload diagnostic only | UI CTA remains disabled until adoption/distribution gates |
| MG-013 | blockers | recent significant edit evidence exists | cooldown/watch before hard action | edit cooldown overrides performance branch |
| MG-014 | blockers | click-to-LPV drops materially versus click volume | tracking-risk diagnose/watch | tracking is inferred only from funnel-step evidence |
| MG-015 | blockers | many initiate checkouts but IC-to-purchase rate collapses vs history | checkout/funnel diagnose/watch | zero purchases alone is insufficient for CAPI/checkout claim |
| MG-016 | blockers | monthly spend is materially overpaced | pacing blocker before hard scale/cut | budget pacing must gate automation and hard changes |
| MG-017 | signals | audience overlap/source fields missing | unsupported/diagnose/watch | do not hard-action unsupported overlap assumptions |
| MG-018 | feed | feed status explicitly problematic or disapproval count present | catalog/feed diagnostic scenario | explicit problem evidence required |
| MG-019 | feed | feed status `no_issues` or `not_limited` | no feed-problem scenario | negated/healthy statuses are non-problematic |
| MG-020 | learning | learning campaign is on pace and immature | wait/watch learning scenario | no premature cut while learning evidence is still active |
| MG-021 | learning | post-learning underperformer lacks learning-exit evidence | no A5 cut | A5 requires explicit learning-exit/post-learning proof |
| MG-022 | bid | B4 min-ROAS loosen without readable Meta ROAS target | no B4 tune action | bid target loosen requires a current target |
| MG-023 | bid | conservative profit-first bid cap winner is under-delivering | B6 keep/tune candidate | B6 requires conservative posture and under-delivery |
| MG-024 | optimization | purchase-optimized campaign with weak purchase and stronger pre-purchase signal | G1 test/switch recommendation | Sales objective alone is insufficient; purchase optimization must be explicit |
| MG-025 | optimization | generic `OFFSITE_CONVERSIONS` without purchase custom event | no purchase-optimized G1 | generic conversion goal is not purchase proof |
| MG-026 | optimization | explicit pre-purchase optimized campaign with purchase sample and target anchors | G2 downshift-to-purchase candidate | requires recent purchase sample and commercial floors |
| MG-027 | non-purchase adset | efficient mid-funnel/lead/traffic/engagement adset | cohort-specific scale path | event-cost/cohort calibration, not sales ROAS anchor |
| MG-028 | non-purchase adset | inefficient non-purchase adset with inadequate event sample | no hard cut | non-purchase hard cuts still need cohort/event-cost maturity |
| MG-029 | upper funnel | awareness/upper-funnel campaign | informational card, not hard action | upper-funnel path is advisory unless downstream evidence supports action |
| MG-030 | empirical logs | outcome table contains preflight/rollback/operator rows only | insufficient empirical model | only explicit `action_type=outcome` rows count |
| MG-031 | empirical logs | raw rows high but judged positive/negative sample below floor | insufficient sample blocker | sample floor is judged outcomes, not raw rows |
| MG-032 | empirical logs | unknown/pending rows dominate with few negatives | negative rate not diluted | denominator is judged outcomes only |
| MG-033 | automation | high empirical summary, no live preflight or rollback proof | not auto-execute eligible | empirical evidence alone only removes empirical blocker |
| MG-034 | automation | empirical summary weak/negative | empirical precision blocker | automation readiness remains conservative |
| MG-035 | UI | action card renders automation readiness | backend-provided chip only | UI does not derive automation tier or buyer action |
| MG-036 | persistence | stored snapshot recommendation read | empirical enrichment attempted after label guard | storage failure returns unchanged recommendations |

## Fixture Maintenance Rules

- Keep each golden linked to at least one unit, route, snapshot, or UI test when
  the related code path changes.
- If a scenario remains unsupported because signal coverage is absent, document
  the diagnose/watch fallback instead of inventing a hard-action fixture.
- Do not remove a golden case just because production data is sparse. Remove it
  only when the underlying scenario contract is deliberately retired.
- Obsolete fixtures should be pruned when they assert behavior that is no longer
  a valid contract. As of Phase G closeout, no Meta-specific fixture file existed
  before this document; therefore there was no Meta fixture to delete.
