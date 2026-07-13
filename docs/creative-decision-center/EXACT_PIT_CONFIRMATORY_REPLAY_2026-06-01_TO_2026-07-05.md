# Exact-PIT Confirmatory Replay

Generated: 2026-07-12T15:47:15.725Z
Range: 2026-06-01 to 2026-07-05
Current code engine: v3-2026-07-12-breakeven-cut-ceiling

## Boundary

- Exact metrics source: `meta_raw_snapshots` / `ad_insights_bulk` only.
- Exact parent-status source: cutoff-safe positive observations from `meta_raw_snapshots` / `campaign_statuses`.
- Restated `meta_ad_daily` rows used: **0**.
- Current dimension rows used: **0**.
- Persisted decisions are reported as a separate output-hash baseline and are not merged with exact metrics.

## Coverage

- Requested days: **35**
- Days with at least one reconstructable scope: **15**
- Reconstructable scope-days: **105/437** (24.03%)
- Exact manifest rows: **1695**; rejected manifests: **0**
- Generation/conflict-safe exact 3-day scope windows: **96**
- Generation/conflict-safe exact 7-day scope windows: **87**
- Generation/conflict-safe exact 14-day scope windows: **77**
- Generation/conflict-safe exact 28-day scope windows: **77**
- Window count basis: `ad_insights_bulk_latest_generation_terminal_supersede_identity_conflict_safe`
- Campaign config coverage: **100%**
- Adset config coverage: **100%**
- Target coverage: **67.55%**
- Optional creative grouping identity coverage: **0%**
- Campaign-status mapped ad manifests: **1695/1695** (100%)
- Status-bearing rows/scopes: **17097/105**; unmapped status rows: **16815**
- Exact campaign-paused delivery-state branches: **10**; status conflicts: **0**

## Evaluability

- Decision grain: **ad_id**
- Branch-terminal core: **partial**; evaluated **1695**, exact resolutions **372** (unsupported objective labels **362**, parent-paused state-only **10**)
- Full resolver inputs: **none**; evaluable **0**
- Legacy creative-output hash join: **none**; joinable **0**

## Hashes And Reproducibility

- Exact observation-manifest-set SHA-256: `e08cda6c96b474457b6f67bfe603d960a1bf4095463352cb4c832163ac158562`
- Branch-terminal core decision-set SHA-256: `82a6f0112343e84a46b982116a20d5af5eac5ee15696c0f92309496279f87440`
- Full resolver input-set SHA-256: `unavailable`
- Full resolver decision-set SHA-256: `unavailable`
- Legacy creative-output join-set SHA-256: `unavailable`
- Persisted decision-set SHA-256: `5b1aead3216eeb56dc3386a21e97afbcb58af1f842a23fed58668e2de59530c9`
- Current-engine decision-set SHA-256: `unavailable`
- Deterministic transform verified: **yes**
- Persisted baseline status: **persisted_output_hash_only**
- Persisted rows: **2304**; replayable rows: **0**

## Retained Raw Source Inventory

- Inventory status: **available**; snapshots: **602912**
- Retained endpoint names: **ad_insights_bulk, adset_insights, adset_statuses, breakdown_age, breakdown_country, breakdown_publisher_platform,platform_position,impression_device, campaign_configs, campaign_statuses**
- identity.creative_id_at_cutoff (optional_grouping_join): **missing**; exact rows 0/1695; requested by exact endpoint: **false**
- delivery.effective_status_at_cutoff (full_resolver_input): **missing**; exact rows 0/1695; requested by exact endpoint: **false**
- policy.review_status_at_cutoff (full_resolver_input): **missing**; exact rows 0/1695; requested by exact endpoint: **false**
- policy.disapproval_or_limited_reason_at_cutoff (full_resolver_input): **missing**; exact rows 0/1695; requested by exact endpoint: **false**

## Daily Exact Coverage

| Date       | Exact scopes | Observed scopes | Evidence rows | Manifests | Exact 3d windows | Exact 7d windows | Exact 14d windows | Exact 28d windows | Excluded post-cutoff snapshots |
| ---------- | -----------: | --------------: | ------------: | --------: | ---------------: | ---------------: | ----------------: | ----------------: | -----------------------------: |
| 2026-06-01 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                           1171 |
| 2026-06-02 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                           1156 |
| 2026-06-03 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                            754 |
| 2026-06-04 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             44 |
| 2026-06-05 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             24 |
| 2026-06-06 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             23 |
| 2026-06-07 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             18 |
| 2026-06-08 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             17 |
| 2026-06-09 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             16 |
| 2026-06-10 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             14 |
| 2026-06-11 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             14 |
| 2026-06-12 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             14 |
| 2026-06-13 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             14 |
| 2026-06-14 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                             13 |
| 2026-06-15 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                            445 |
| 2026-06-16 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                           1245 |
| 2026-06-17 |            0 |              13 |             0 |         0 |                0 |                0 |                 0 |                 0 |                           2597 |
| 2026-06-18 |            7 |              13 |            78 |        78 |                6 |                6 |                 6 |                 6 |                           2937 |
| 2026-06-19 |            7 |              13 |            76 |        76 |                7 |                7 |                 7 |                 7 |                           2787 |
| 2026-06-20 |            7 |              12 |            99 |        99 |                7 |                7 |                 7 |                 7 |                           2768 |
| 2026-06-21 |            7 |              12 |           132 |       132 |                7 |                7 |                 7 |                 7 |                           2783 |
| 2026-06-22 |            7 |              12 |           119 |       119 |                7 |                7 |                 7 |                 7 |                           2699 |
| 2026-06-23 |            7 |              12 |            88 |        88 |                6 |                6 |                 6 |                 6 |                           2244 |
| 2026-06-24 |            7 |              12 |            76 |        76 |                6 |                6 |                 6 |                 6 |                           1847 |
| 2026-06-25 |            7 |              12 |            78 |        78 |                4 |                4 |                 4 |                 4 |                           1729 |
| 2026-06-26 |            7 |              12 |            88 |        88 |                7 |                4 |                 4 |                 4 |                           1984 |
| 2026-06-27 |            7 |              12 |            74 |        74 |                7 |                4 |                 4 |                 4 |                           1844 |
| 2026-06-28 |            7 |              12 |            65 |        65 |                7 |                4 |                 4 |                 4 |                            713 |
| 2026-06-29 |            0 |              12 |             0 |         0 |                0 |                0 |                 0 |                 0 |                            962 |
| 2026-06-30 |            0 |              12 |             0 |         0 |                0 |                0 |                 0 |                 0 |                            646 |
| 2026-07-01 |            0 |              10 |             0 |         0 |                0 |                0 |                 0 |                 0 |                            381 |
| 2026-07-02 |            7 |              12 |           188 |       188 |                7 |                7 |                 4 |                 4 |                           1289 |
| 2026-07-03 |            7 |              12 |           172 |       172 |                7 |                7 |                 4 |                 4 |                            999 |
| 2026-07-04 |            7 |              12 |           175 |       175 |                5 |                5 |                 4 |                 4 |                           1921 |
| 2026-07-05 |            7 |              12 |           187 |       187 |                6 |                6 |                 3 |                 3 |                           1672 |

## Physically Unreconstructable

- canonical serialized CreativeInput, AccountDecisionProfile, DataHealth, campaign-label context, and hysteresis memory were not persisted
- the persisted historical baseline does not have a complete decision/lifecycle/calibration input-hash chain for every output row
- retained sources do not completely prove historical ad-level configured/effective status or policy/review inputs; campaign-status receipts prove only positively observed parent state
- provider attribution restatements cannot be reversed to the value Meta exposed at an earlier cutoff when that generation was not retained

## Verdict

The exact tier resolves 362 branch-terminal out_of_scope row(s) and 10 parent-paused delivery-state-only row(s) at native ad_id grain. Full resolver inputs remain unavailable, so no full resolver input or decision hash is claimed for paused rows.
